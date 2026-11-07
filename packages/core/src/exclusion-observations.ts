import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { excludedByTarget, observeProjectSkill, type ProjectComponents } from "@hooknostic/agent-plugin";

import type { AuthorExclusions } from "./build.js";
import { ownedProjectFiles } from "./project-files.js";
import type { AuthoredProjectSkill } from "./skill-policy.js";

/** Observe authored native copies without acquiring ownership or changing their bytes. */
export async function authoredExclusionSources(
  root: string,
  readers: readonly { directories: readonly string[]; exclusions: AuthorExclusions; sourceRoots: readonly string[] }[],
  origin: ProjectComponents["origin"],
  config: string,
): Promise<AuthoredProjectSkill[]> {
  const owned = await ownedProjectFiles(root, config);
  const canonical = async (path: string) => realpath(path).catch(() => resolve(path));
  const contains = (directory: string, path: string) => {
    const offset = relative(directory, path);
    return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
  };
  const observed = new Map<string, AuthoredProjectSkill>();
  const isOwned = (path: string) => owned.has(relative(root, path).replaceAll("\\", "/"));
  for (const reader of readers) {
    if (!reader.exclusions.patterns.length) continue;
    const sources = await Promise.all(reader.sourceRoots.map(canonical));
    // Recover names beneath pruned parents without parsing excluded manifests.
    const sourceNames = new Set(
      (await Promise.all(sources.map((source) => readdir(source, { withFileTypes: true }).catch(() => []))))
        .flatMap((entries) => entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()))
        .map((entry) => entry.name.toLowerCase()),
    );
    for (let ancestor = root; ; ancestor = dirname(ancestor)) {
      for (const directory of reader.directories) {
        const path = await canonical(resolve(ancestor, directory));
        const inPlace = sources.some((source) => contains(path, source));
        if (!inPlace && reader.exclusions.matches.length === 0) continue;
        const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
          throw error;
        });
        // Inspect relevant children independently: unrelated invalid links must
        // not erase valid observations, and a skill may itself be a junction.
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const skillPath = `${origin === "package" ? "skills/" : ""}${entry.name}`.toLowerCase();
          // Inventory can prune an ancestor before it learns any skill names.
          const matched = reader.exclusions.matches.some(({ path }) => {
            const boundary = path.toLowerCase();
            return (
              boundary === skillPath ||
              boundary.startsWith(`${skillPath}/`) ||
              (skillPath.startsWith(`${boundary}/`) && sourceNames.has(entry.name.toLowerCase()))
            );
          });
          if (!inPlace && !matched) continue;
          const loaded = await observeProjectSkill(resolve(path, entry.name), {
            logicalRoot: skillPath,
            patterns: reader.exclusions.patterns,
            directSkills: origin === "direct",
          });
          const failure = loaded.issues.find((issue) => issue.scope === "file" && issue.severity === "error");
          if (failure) throw new Error(`Cannot inspect native skill ${resolve(path, entry.name)}: ${failure.message}`);
          const skill = loaded.skill;
          // Malformed native manifests are not portable skills; they do not
          // turn unrelated authoring errors into configured-source validation.
          if (!skill) continue;
          // Owned files are reconciled separately. Only unowned bytes can remain
          // exposed here; the planner decides whether an owned manifest survives.
          const files = skill.files.filter((file) => !isOwned(resolve(skill.source, file.path)));
          if (
            files.some((file) =>
              excludedByTarget(
                `${origin === "package" ? "skills/" : ""}${skill.name}/${file.path}`,
                reader.exclusions.patterns,
                origin === "direct",
              ),
            )
          )
            observed.set(skill.source, {
              ...skill,
              files: [
                ...new Map(
                  [...(observed.get(skill.source)?.files ?? []), ...files].map((file) => [file.path, file]),
                ).values(),
              ],
              ownedManifest: isOwned(resolve(skill.source, "SKILL.md")),
            });
        }
      }
      if (dirname(ancestor) === ancestor) break;
    }
  }
  return [...observed.values()];
}
