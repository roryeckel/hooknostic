import type { AgentPluginIssue, AgentPluginProjectionFile } from "../types.js";

interface MaterializedPackageTree {
  provider: string;
  into: string;
  files: readonly { path: string; contents: Uint8Array }[];
}

/** Place provider output relative to a projector's plugin root without overwriting other package content. */
export function materializedPackageFiles(
  trees: readonly MaterializedPackageTree[] | undefined,
  options: { prefix?: string; claimed: ReadonlySet<string> },
): { files: AgentPluginProjectionFile[]; issues: AgentPluginIssue[] } {
  const files: AgentPluginProjectionFile[] = [];
  const issues: AgentPluginIssue[] = [];
  const prefix = options.prefix ?? "";
  const materializedPaths = new Set<string>();

  for (const tree of trees ?? []) {
    const base = `${prefix}${tree.into}`;
    for (const file of tree.files) {
      const path = `${base}/${file.path}`;
      if (options.claimed.has(path)) {
        issues.push({
          severity: "error",
          scope: "file",
          message:
            `materializer ${JSON.stringify(tree.provider)} writes ${JSON.stringify(path)}, which the package ` +
            `already ships. Point its "into" at a directory the package does not use.`,
          path,
        });
        continue;
      }
      if (materializedPaths.has(path)) {
        issues.push({
          severity: "error",
          scope: "file",
          message:
            `materializer ${JSON.stringify(tree.provider)} writes ${JSON.stringify(path)}, which another ` +
            `materialized tree already provides. Point its "into" at a distinct directory.`,
          path,
        });
        continue;
      }
      materializedPaths.add(path);
      files.push({ path, contents: Buffer.from(file.contents) });
    }
  }
  return { files, issues };
}
