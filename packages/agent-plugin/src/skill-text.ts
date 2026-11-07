/**
 * Portable body tokens, and references a harness would show the model as
 * written (ADR-0028, ADR-0037).
 *
 * A skill that runs a script it ships has to name it, and the harnesses do not
 * agree on how. Claude Code expands `${CLAUDE_SKILL_DIR}` in a skill's text to
 * the skill's absolute directory. Codex and OpenCode expand nothing, but tell
 * the model to resolve relative paths against the skill's directory
 * (.capture/skill-directory). `${SKILL_DIR}` is the portable spelling:
 * projection writes each target's form in its place, in the body only.
 * `${HARNESS}` and `${SKILL_REF:name}` use adapter-supplied projection context.
 */

import { isAgentSkillName } from "./load.js";
import type { AgentPluginDegradation, AgentPluginSkill } from "./types.js";

export const SKILL_DIR_PLACEHOLDER = "${SKILL_DIR}";

/** Degradation id for a SKILL.md reference the target leaves as written (ADR-0028). */
export const SKILL_REFERENCE_UNEXPANDED = "skill-reference-unexpanded";

/** How one target treats the text of a skill. */
export interface SkillTextTarget {
  /** Build-time projection identity, not runtime harness detection (ADR-0037). */
  harness?: string;
  /** Authored sibling names mapped to their final native prompt references. */
  skillReferences?: ReadonlyMap<string, string>;
  /** What `${SKILL_DIR}` becomes in the body. */
  skillDirectory: string;
  /** A target-owned shortfall to report whenever the body token is rewritten. */
  directoryDegradation?: Pick<AgentPluginDegradation, "id" | "reason">;
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
 * A relative-directory policy: `${SKILL_DIR}` becomes `.`, and every Claude
 * Code variable and Agent Plugins placeholder is shown as written. Codex
 * overrides the directory with its explicit model-substituted placeholder.
 */
export const RELATIVE_SKILL_TEXT: SkillTextTarget = {
  skillDirectory: ".",
  leavesLiteral: (name) => AGENT_PLUGIN_PLACEHOLDER_NAMES.has(name) || name.startsWith("CLAUDE_"),
};

/**
 * What the frontmatter keeps as written, on every target: no harness expands a
 * reference there. Claude Code quoted a plugin skill's description with its
 * `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SESSION_ID}` as
 * written, though it expands them in the body; Codex hands the model the whole
 * file as written (.capture/skill-directory). The projection never rewrites it.
 */
function frontmatterLeavesLiteral(name: string): boolean {
  return isBodyToken(name) || AGENT_PLUGIN_PLACEHOLDER_NAMES.has(name) || name.startsWith("CLAUDE_");
}

function isBodyToken(name: string): boolean {
  return name === "SKILL_DIR" || name === "HARNESS" || name === "SKILL_REF" || name.startsWith("SKILL_REF:");
}

const FRONTMATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const REFERENCE = /\$\{(SKILL_REF:|[A-Za-z_][A-Za-z0-9_]*\})/g;

function replaceReferences(text: string, replace: (reference: string, name: string) => string): string {
  const parts: string[] = [];
  let offset = 0;
  for (const match of text.matchAll(REFERENCE)) {
    if (match.index < offset) continue;
    let end = match.index + match[0].length;
    if (match[1] === "SKILL_REF:") {
      // Consume the whole reserved reference, even when malformed. Otherwise
      // line breaks or nested tokens can hide a diagnostic or trigger a partial rewrite.
      let depth = 1;
      for (; end < text.length && depth > 0; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}") depth--;
      }
      if (depth > 0) break;
    }
    const reference = text.slice(match.index, end);
    parts.push(text.slice(offset, match.index), replace(reference, reference.slice(2, -1)));
    offset = end;
  }
  parts.push(text.slice(offset));
  return parts.join("");
}

export interface ProjectedSkillText {
  /** The rewritten file, or undefined when nothing changed and the bytes stand. */
  contents?: Uint8Array;
  /** The target's directory shortfall, only when a body token was rewritten. */
  directoryDegradation?: Pick<AgentPluginDegradation, "id" | "reason">;
  /**
   * References the target will show as written, each once and in order:
   * every checked reference in the frontmatter, which no harness expands and
   * the projection never rewrites, and every body reference `leavesLiteral`
   * names.
   */
  unexpanded: string[];
  /** True when any of `unexpanded` was found in the frontmatter. */
  inFrontmatter?: true;
}

/**
 * Project portable tokens in a SKILL.md body using target-owned directory,
 * harness and sibling-reference context, and list what remains as written.
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
     * does not own and cannot rewrite: portable body tokens are then reported
     * as unexpanded instead.
     */
    rewrite?: boolean;
  } = {},
): ProjectedSkillText {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(contents);
  const frontmatter = FRONTMATTER.exec(text)?.[0] ?? "";
  const body = text.slice(frontmatter.length);
  const unexpanded = new Set<string>();
  replaceReferences(frontmatter, (reference, name) => {
    if (frontmatterLeavesLiteral(name)) unexpanded.add(reference);
    return reference;
  });
  const inFrontmatter = unexpanded.size > 0 ? ({ inFrontmatter: true } as const) : {};
  const rewrite = options.rewrite ?? true;
  let directoryRewritten = false;
  const projectedBody = replaceReferences(body, (reference, name) => {
    if (isBodyToken(name)) {
      let replacement: string | undefined;
      if (rewrite) {
        if (name === "SKILL_DIR") {
          replacement = target.skillDirectory;
          directoryRewritten = true;
        } else if (name === "HARNESS") replacement = target.harness;
        else if (name.startsWith("SKILL_REF:")) {
          const sibling = name.slice("SKILL_REF:".length);
          if (isAgentSkillName(sibling)) replacement = target.skillReferences?.get(sibling);
        }
      }
      if (replacement !== undefined) return replacement;
      unexpanded.add(reference);
    } else if (target.leavesLiteral(name)) unexpanded.add(reference);
    return reference;
  });
  return {
    ...(projectedBody === body ? {} : { contents: new TextEncoder().encode(frontmatter + projectedBody) }),
    ...(directoryRewritten && target.directoryDegradation ? { directoryDegradation: target.directoryDegradation } : {}),
    unexpanded: [...unexpanded],
    ...inFrontmatter,
  };
}

/** The reason an HN101 for `skill-reference-unexpanded` gives, naming each reference. */
export function unexpandedSkillReferenceReason(
  skill: string,
  references: readonly string[],
  harness: string,
  options: { inPlace?: boolean; inFrontmatter?: boolean } = {},
): string {
  const listed = references.map((reference) => JSON.stringify(reference)).join(", ");
  const why = options.inPlace
    ? references.some((reference) => isBodyToken(reference.slice(2, -1)))
      ? ` ${harness} discovers this skill where it is, so its portable body tokens cannot be rewritten; move the skill outside the destination for Hooknostic to own it.`
      : ""
    : options.inFrontmatter
      ? " No harness expands a reference in the frontmatter, and portable tokens are rewritten in the body only."
      : "";
  const siblingHelp = references.some((reference) => reference.startsWith("${SKILL_REF"))
    ? " Use ${SKILL_REF:name} with the authored name of an available sibling skill; use native text in target-specific overlays for external plugin references."
    : "";
  const harnessHelp =
    references.includes("${HARNESS}") && !options.inPlace && !options.inFrontmatter
      ? " The projector must supply the build-time harness identity."
      : "";
  return `skill ${JSON.stringify(skill)} contains ${listed}, which ${harness} shows the model as written.${why}${siblingHelp}${harnessHelp}`;
}

/**
 * Project the text of every skill a package ships: the rewritten SKILL.md
 * bytes by package path, and degradations for references the target shows as
 * written or its conditional directory-substitution shortfall. Core
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
        reason: unexpandedSkillReferenceReason(skill.name, projected.unexpanded, harness, {
          ...(projected.inFrontmatter ? { inFrontmatter: true } : {}),
        }),
      });
    }
    if (projected.directoryDegradation) {
      degradations.push({
        ...projected.directoryDegradation,
        component: "agent-plugin.skills",
        name: skill.name,
        path: skill.manifestPath,
      });
    }
  }
  return { rewritten, degradations };
}
