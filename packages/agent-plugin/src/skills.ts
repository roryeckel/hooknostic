import type { AgentPluginPackage } from "./types.js";

const SKILL_DIRECTORY = /^(skills\/[^/]+)\//;
const SKILL_MANIFEST = "SKILL.md";

/**
 * A predicate matching package paths belonging to a skill the loader rejected.
 *
 * Under `onInvalid: "warn"` an invalid skill is dropped from `source.skills` and
 * left in `source.files`, so a projection that copies the package and points the
 * harness at its `skills/` tree ships a component the loader said it skipped.
 *
 * The test is "declares a skill AND is not accepted", not merely "is not
 * accepted". A directory under `skills/` holding no `SKILL.md` is not a skill at
 * all -- shared assets, say -- and matching on absence alone deletes it from a
 * package with nothing wrong in it.
 */
export function isRejectedSkillPath(source: AgentPluginPackage): (path: string) => boolean {
  const accepted = new Set(source.skills.map((skill) => skill.directory));
  const declared = new Set(
    source.files
      .map((file) => SKILL_DIRECTORY.exec(file.path))
      .filter((match): match is RegExpExecArray => match !== null)
      .filter((match) => source.files.some((file) => file.path === `${match[1]}/${SKILL_MANIFEST}`))
      .map((match) => match[1]!),
  );
  const rejected = new Set([...declared].filter((directory) => !accepted.has(directory)));
  return (path: string): boolean => {
    const match = SKILL_DIRECTORY.exec(path);
    // Anchored to the separator: `skills/review-notes` is not inside
    // `skills/review`.
    return match !== null && rejected.has(match[1]!);
  };
}
