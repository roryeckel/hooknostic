import { type AgentPluginSkill, isAgentSkillName } from "@hooknostic/agent-plugin";

/**
 * OpenCode keeps one flat skill namespace: two plugins that each ship a
 * `status` skill produce one `status`, and the other is unreachable
 * (`.capture/opencode-skill-namespace`). Claude and Codex qualify a plugin's
 * skills by the plugin, so a package author has no reason to avoid a common
 * name. The projection therefore names each skill `<plugin>-<skill>`, which is
 * as close to the plugin-qualified `<plugin>:<skill>` as a skill name can
 * spell -- `:` is not a legal name character.
 *
 * Only the frontmatter `name` changes. OpenCode identifies a skill by that
 * field, not its directory, so the directory keeps its portable name and every
 * `${PLUGIN_ROOT}/skills/<name>/...` path in the package still resolves
 * (ADR-0021).
 */

/** The Agent Skills name limit, which the qualified name must still meet. */
const MAX_NAME = 64;

/**
 * The prefix a plugin's skills are qualified with. A plugin name may contain
 * `.` and a skill name may not, so `com.acme` qualifies as `com-acme-...`.
 */
function skillPrefix(plugin: string): string {
  return plugin.replaceAll(".", "-");
}

export interface SkillRename {
  skill: AgentPluginSkill;
  /** The name OpenCode will list, which is `skill.name` when it is kept. */
  name: string;
  /** Why the bare name was kept, when it was kept despite needing a prefix. */
  kept?: string;
}

/**
 * The name each skill is emitted under. A skill already named for its plugin
 * (`<plugin>` or `<plugin>-...`) is left alone, so `alpha-maintenance`
 * does not become `alpha-alpha-maintenance`.
 */
export function qualifiedSkillNames(plugin: string, skills: readonly AgentPluginSkill[]): SkillRename[] {
  return qualifyNames(
    plugin,
    skills.map((skill) => skill.name),
    "skill",
  ).map(({ name, kept }, index) => ({ skill: skills[index]!, name, ...(kept === undefined ? {} : { kept }) }));
}

/**
 * The plugin-qualified spelling of each name, by the rules above, for any item
 * OpenCode keeps in one flat namespace -- skills (ADR-0021) and subagents
 * (ADR-0027) alike. `noun` only words the reason a bare name was kept.
 */
export function qualifyNames(
  plugin: string,
  names: readonly string[],
  noun: string,
): { name: string; kept?: string }[] {
  const prefix = skillPrefix(plugin);
  const planned = names.map((authored): { authored: string; name: string; kept?: string } => {
    if (authored === prefix || authored.startsWith(`${prefix}-`)) return { authored, name: authored };
    const name = `${prefix}-${authored}`;
    if (name.length > MAX_NAME) {
      return {
        authored,
        name: authored,
        kept: `${JSON.stringify(name)} would exceed the ${MAX_NAME}-character Agent Skills name limit`,
      };
    }
    // A plugin name like `a.-b` survives its own rule but becomes `a--b`,
    // which no skill name may contain. Emitting it would ship a skill whose
    // name fails the rule its package was validated against.
    if (!isAgentSkillName(name)) {
      return { authored, name: authored, kept: `${JSON.stringify(name)} is not a valid Agent Skills name` };
    }
    return { authored, name };
  });
  // A package may already ship `status` and `<plugin>-status`. Prefixing the
  // first would give OpenCode two items of one name, which is the collision
  // this exists to prevent, so both keep what the author wrote.
  const taken = new Map<string, number>();
  for (const { name } of planned) taken.set(name, (taken.get(name) ?? 0) + 1);
  return planned.map(({ authored, name, kept }) =>
    name !== authored && (taken.get(name) ?? 0) > 1
      ? { name: authored, kept: `the package already has a ${noun} named ${JSON.stringify(name)}` }
      : { name, ...(kept === undefined ? {} : { kept }) },
  );
}

/**
 * `contents` with the frontmatter `name` changed from `from` to `to`, or
 * undefined when there is no single top-level `name:` line carrying `from` as
 * a plain or quoted scalar. Everything else is left byte for byte, including
 * the quoting, a trailing comment and the line ending.
 */
export function renameSkillManifest(contents: Uint8Array, from: string, to: string): Uint8Array | undefined {
  const text = new TextDecoder().decode(contents);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (frontmatter === null) return undefined;
  const start = frontmatter[0].indexOf("\n") + 1;
  const body = frontmatter[1] ?? "";
  // A skill name is `[a-z0-9-]`, so it needs no escaping in a pattern and no
  // YAML scalar can spell it any other way than plain or quoted. A multiline
  // `$` also stops before a carriage return, so CRLF needs no pattern of its
  // own.
  const line = new RegExp(`^name:([ \\t]*)(["']?)${from}\\2([ \\t]*(?:#[^\\r\\n]*)?)$`, "gm");
  const matches = [...body.matchAll(line)];
  // Any second top-level `name` key, however spelled, means this line may not
  // be the one a YAML parser keeps.
  if (matches.length !== 1 || body.match(/^name[ \t]*:/gm)?.length !== 1) return undefined;
  const match = matches[0]!;
  const [, space, quote, rest] = match;
  const at = start + match.index;
  return new TextEncoder().encode(
    `${text.slice(0, at)}name:${space}${quote}${to}${quote}${rest}${text.slice(at + match[0].length)}`,
  );
}
