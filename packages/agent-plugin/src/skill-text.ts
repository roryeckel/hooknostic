/**
 * The skill-directory token, and the references in a SKILL.md a harness would
 * show the model as written (ADR-0028).
 *
 * A skill that runs a script it ships has to name it, and the harnesses do not
 * agree on how. Claude Code expands `${CLAUDE_SKILL_DIR}` in a skill's text to
 * the skill's absolute directory. Codex and OpenCode expand nothing, but tell
 * the model to resolve relative paths against the skill's directory
 * (.capture/skill-directory). `${SKILL_DIR}` is the portable spelling:
 * projection writes each target's form in its place, in the body only.
 */

import type { AgentPluginDegradation, AgentPluginSkill } from "./types.js";

export const SKILL_DIR_PLACEHOLDER = "${SKILL_DIR}";

/** Degradation id for a SKILL.md reference the target leaves as written (ADR-0028). */
export const SKILL_REFERENCE_UNEXPANDED = "skill-reference-unexpanded";

/** How one target treats the text of a skill. */
export interface SkillTextTarget {
  /** What `${SKILL_DIR}` becomes in the body. */
  skillDirectory: string;
  /**
   * Whether the target shows `${name}` to the model as written. Only names with
   * captured evidence belong here; any other `${...}` in a skill is left alone
   * and unreported, because shell parameter syntax in a command the model runs
   * is the shell's to expand, not the harness's.
   */
  leavesLiteral(name: string): boolean;
}

/** The Agent Plugins 1.0 placeholders, which no measured harness expands in skill text. */
export const AGENT_PLUGIN_PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

/**
 * Codex and both OpenCode families: `${SKILL_DIR}` becomes `.`, a path
 * relative to the skill's directory, and every Claude Code variable and Agent
 * Plugins placeholder is shown as written.
 */
export const RELATIVE_SKILL_TEXT: SkillTextTarget = {
  skillDirectory: ".",
  leavesLiteral: (name) => AGENT_PLUGIN_PLACEHOLDER_NAMES.has(name) || name.startsWith("CLAUDE_"),
};

const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface ProjectedSkillText {
  /** The rewritten file, or undefined when nothing changed and the bytes stand. */
  contents?: Uint8Array;
  /**
   * References the target will show as written, each once and in order:
   * `${SKILL_DIR}` in the frontmatter, which is never rewritten, and every body
   * reference `leavesLiteral` names.
   */
  unexpanded: string[];
}

/**
 * Write `target`'s skill directory for each `${SKILL_DIR}` in the body of a
 * SKILL.md, and list what the target will leave as written.
 *
 * The frontmatter keeps its bytes: it is the harness's metadata, and a name or
 * description is not a place a harness resolves a path. Everything outside the
 * replaced tokens keeps its bytes too, including line endings and a BOM.
 */
export function projectSkillText(
  contents: Uint8Array,
  target: SkillTextTarget,
  options: {
    /**
     * False for a skill the target discovers where it is, which Hooknostic
     * does not own and cannot rewrite: a body `${SKILL_DIR}` is then reported
     * as unexpanded instead.
     */
    rewrite?: boolean;
  } = {},
): ProjectedSkillText {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(contents);
  const frontmatter = FRONTMATTER.exec(text)?.[0] ?? "";
  const body = text.slice(frontmatter.length);
  const unexpanded = new Set<string>();
  if (frontmatter.includes(SKILL_DIR_PLACEHOLDER)) unexpanded.add(SKILL_DIR_PLACEHOLDER);
  const rewrite = options.rewrite ?? true;
  for (const [reference, name] of body.matchAll(REFERENCE)) {
    if (name === "SKILL_DIR" ? !rewrite : target.leavesLiteral(name!)) unexpanded.add(reference);
  }
  if (!rewrite || !body.includes(SKILL_DIR_PLACEHOLDER)) return { unexpanded: [...unexpanded] };
  return {
    contents: new TextEncoder().encode(frontmatter + body.split(SKILL_DIR_PLACEHOLDER).join(target.skillDirectory)),
    unexpanded: [...unexpanded],
  };
}

/** The reason an HN101 for `skill-reference-unexpanded` gives, naming each reference. */
export function unexpandedSkillReferenceReason(
  skill: string,
  references: readonly string[],
  harness: string,
  options: { inPlace?: boolean } = {},
): string {
  const listed = references.map((reference) => JSON.stringify(reference)).join(", ");
  const why = !references.includes(SKILL_DIR_PLACEHOLDER)
    ? ""
    : options.inPlace
      ? ` ${harness} discovers this skill where it is, so ${SKILL_DIR_PLACEHOLDER} cannot be rewritten; move the skill outside the destination for Hooknostic to own it.`
      : ` ${SKILL_DIR_PLACEHOLDER} is rewritten in the body only, never in the frontmatter.`;
  return `skill ${JSON.stringify(skill)} contains ${listed}, which ${harness} shows the model as written.${why}`;
}

/**
 * Project the text of every skill a package ships: the rewritten SKILL.md
 * bytes by package path, and one `skill-reference-unexpanded` degradation per
 * skill whose text still holds a reference the target shows as written. Core
 * applies `components.onDegraded` and `components.accept` to them, and fails
 * the target if its profile does not declare the id (ADR-0022).
 *
 * `contentsOf` supplies each SKILL.md, so a projector that already rewrote one
 * (OpenCode's skill names) hands over its own bytes.
 */
export function projectPackageSkillTexts(
  skills: readonly AgentPluginSkill[],
  contentsOf: (path: string) => Uint8Array | undefined,
  target: SkillTextTarget,
  harness: string,
): { rewritten: Map<string, Uint8Array>; degradations: AgentPluginDegradation[] } {
  const rewritten = new Map<string, Uint8Array>();
  const degradations: AgentPluginDegradation[] = [];
  for (const skill of skills) {
    const contents = contentsOf(skill.manifestPath);
    if (contents === undefined) continue;
    const projected = projectSkillText(contents, target);
    if (projected.contents !== undefined) rewritten.set(skill.manifestPath, projected.contents);
    if (projected.unexpanded.length > 0) {
      degradations.push({
        id: SKILL_REFERENCE_UNEXPANDED,
        component: "agent-plugin.skills",
        name: skill.name,
        path: skill.manifestPath,
        reason: unexpandedSkillReferenceReason(skill.name, projected.unexpanded, harness),
      });
    }
  }
  return { rewritten, degradations };
}
