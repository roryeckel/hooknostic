import type { AgentPluginIssue, AgentPluginProjectionFile } from "../types.js";

interface MaterializedRuntimeInput {
  ecosystem: string;
  into: string;
  files: readonly { path: string; contents: Uint8Array }[];
}

/**
 * Where a projector must write the runtimes core materialized.
 *
 * Shared because the placement rule is the same everywhere -- `into` is
 * relative to that harness's plugin root -- while the prefix that reaches it is
 * not: Claude and Codex read from the output root, and OpenCode's
 * `${PLUGIN_ROOT}` is the nested package directory, so a root-level path there
 * would be unreachable from the very `mcp.json` that names it.
 *
 * A materialized tree never silently overwrites author content. The author's
 * own files are copied first, so a collision means `into` was pointed at a
 * directory the package already ships, and quietly replacing it would make a
 * build that looks clean produce a package missing the author's file.
 */
export function materializedRuntimeFiles(
  runtimes: readonly MaterializedRuntimeInput[] | undefined,
  options: { prefix?: string; claimed: ReadonlySet<string> },
): { files: AgentPluginProjectionFile[]; issues: AgentPluginIssue[] } {
  const files: AgentPluginProjectionFile[] = [];
  const issues: AgentPluginIssue[] = [];
  const prefix = options.prefix ?? "";

  for (const runtime of runtimes ?? []) {
    const base = `${prefix}${runtime.into.replace(/^\.\//, "").replace(/\/+$/, "")}`;
    for (const file of runtime.files) {
      const path = `${base}/${file.path}`;
      if (options.claimed.has(path)) {
        issues.push({
          severity: "error",
          scope: "file",
          message:
            `the ${runtime.ecosystem} runtime materializes over ${JSON.stringify(path)}, which the package ` +
            `already ships. Point its "into" at a directory the package does not use.`,
          path,
        });
        continue;
      }
      files.push({ path, contents: Buffer.from(file.contents) });
    }
  }
  return { files, issues };
}
