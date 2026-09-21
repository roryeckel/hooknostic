import type { AgentPluginIssue, AgentPluginProjectionFile } from "../types.js";

interface MaterializedPackageTree {
  provider: string;
  into: string;
  files: readonly { path: string; contents: Uint8Array; mode: 0o644 | 0o755 }[];
}

/** The spelling a collision is reported against, or undefined when the path is free. */
function collidingPath(path: string, taken: ReadonlyMap<string, string>): string | undefined {
  return taken.get(path.toLowerCase());
}

/** How a collision reads when the two spellings differ only in case. */
function caseClause(path: string, existing: string): string {
  return existing === path ? "" : ` as ${JSON.stringify(existing)} on case-insensitive filesystems`;
}

/**
 * Place provider output relative to a projector's plugin root without overwriting other package content.
 *
 * Collisions fold case. A build produced on a case-sensitive filesystem can be
 * installed on an insensitive one, where `Runtime/LIB.SO` and `runtime/lib.so`
 * are one file — so emitting both would mean the projection, its digest and the
 * installed tree disagree depending on where each ran (ADR-0006).
 */
export function materializedPackageFiles(
  trees: readonly MaterializedPackageTree[] | undefined,
  options: { prefix?: string; claimed: ReadonlySet<string> },
): { files: AgentPluginProjectionFile[]; issues: AgentPluginIssue[] } {
  const files: AgentPluginProjectionFile[] = [];
  const issues: AgentPluginIssue[] = [];
  const prefix = options.prefix ?? "";
  const claimed = new Map([...options.claimed].map((path) => [path.toLowerCase(), path]));
  const materializedPaths = new Map<string, string>();

  for (const tree of trees ?? []) {
    const base = `${prefix}${tree.into}`;
    for (const file of tree.files) {
      const path = `${base}/${file.path}`;
      const shipped = collidingPath(path, claimed);
      if (shipped !== undefined) {
        issues.push({
          severity: "error",
          scope: "file",
          message:
            `materializer ${JSON.stringify(tree.provider)} writes ${JSON.stringify(path)}, which the package ` +
            `already ships${caseClause(path, shipped)}. Point its "into" at a directory the package does not use.`,
          path,
        });
        continue;
      }
      const provided = collidingPath(path, materializedPaths);
      if (provided !== undefined) {
        issues.push({
          severity: "error",
          scope: "file",
          message:
            `materializer ${JSON.stringify(tree.provider)} writes ${JSON.stringify(path)}, which another ` +
            `materialized tree already provides${caseClause(path, provided)}. Point its "into" at a distinct directory.`,
          path,
        });
        continue;
      }
      materializedPaths.set(path.toLowerCase(), path);
      files.push({ path, contents: Buffer.from(file.contents), mode: file.mode });
    }
  }
  return { files, issues };
}
