import * as nodePath from "node:path";

/**
 * The path a generated module in directory `from` hands to `path.resolve(here,
 * …)` to reach `to`.
 *
 * Relative where one exists. Where none can, it is `to` itself: across Windows
 * drives, and across UNC shares, where Node's win32 `relative` climbs past the
 * share root and `resolve` then clamps the result onto the wrong share
 * (`\\host\share` to `\\host\other\tools` gives `..\..\other\tools`).
 *
 * Separators become `/` only where `\` is the separator: on POSIX a backslash
 * is an ordinary file-name character, and converting it names another path.
 * `paths` is injectable so tests can hold both platforms' behaviour.
 */
export function portableRelative(
  from: string,
  to: string,
  paths: Pick<typeof nodePath, "parse" | "relative" | "resolve" | "sep"> = nodePath,
): string {
  const windows = paths.sep === "\\";
  const rootOf = (path: string) => paths.parse(paths.resolve(path)).root.toLowerCase();
  const result = !windows || rootOf(from) === rootOf(to) ? paths.relative(from, to) || "." : paths.resolve(to);
  return windows ? result.replaceAll("\\", "/") : result;
}
