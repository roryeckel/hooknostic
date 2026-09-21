import { relative, resolve } from "node:path";

import type { ProjectComponents } from "@hooknostic/agent-plugin";

import { bundleMcpLauncher, type McpLauncherServer } from "./mcp-launcher.js";
import type { ProjectIntegration } from "./project-files.js";
export function projectSkillFiles(source: ProjectComponents, root: string, destination: string): ProjectIntegration {
  const relinquishFiles: string[] = [];
  const relinquishPrefixes: string[] = [];
  const unappliedModes: { skill: string; path: string }[] = [];
  const files = source.skills.flatMap((skill) => {
    const path = `${destination}/${skill.name}`;
    if (resolve(root, path) === resolve(skill.source)) {
      relinquishPrefixes.push(path);
      // Derived rather than passed in: on both component routes 0755 is only
      // ever reached by declaration (ADR-0013 ignores the host bit), so a
      // declared entry is exactly a 0755 file here. Passing the declaration
      // down instead would give this function a second source of truth about
      // which files were named, free to disagree with the modes it is holding.
      for (const file of skill.files) {
        if (file.mode === 0o755) unappliedModes.push({ skill: skill.name, path: file.path });
      }
      return [];
    }
    return skill.files.map((file) => ({ ...file, path: `${path}/${file.path}` }));
  });
  if (files.length)
    files.push({
      path: `${destination}/.gitattributes`,
      contents: new TextEncoder().encode("** -text\n"),
      mode: 0o644,
    });
  else if (relinquishPrefixes.length) relinquishFiles.push(`${destination}/.gitattributes`);
  return {
    files,
    entries: [],
    guidance: [],
    ...(unappliedModes.length ? { unappliedModes } : {}),
    ...(relinquishFiles.length ? { relinquishFiles } : {}),
    ...(relinquishPrefixes.length ? { relinquishPrefixes } : {}),
  };
}
export async function projectMcpLauncher(
  source: ProjectComponents,
  root: string,
  output: string,
  selectedServers?: McpLauncherServer[],
): Promise<ProjectIntegration> {
  if (!source.mcp) return { files: [], entries: [], guidance: [] };
  const servers =
    selectedServers ??
    Object.entries(source.mcp.config.mcpServers)
      .filter(([, s]) => s.type === "stdio")
      .map(([name, s]) => ({ name, ...s }));
  if (!servers.length) return { files: [], entries: [], guidance: [] };
  const relativeToOutput = (path: string) => relative(resolve(root, output), path).replaceAll("\\", "/") || ".";
  const launcher = await bundleMcpLauncher({
    frontEnd: "self-resolving",
    rootOffset: relativeToOutput(source.mcp.root),
    dataOffset: relativeToOutput(resolve(root, ".hooknostic/data")),
    pluginName: "project",
    environmentReferences: source.origin === "direct",
  });
  return {
    files: [
      { path: `${output}/.gitattributes`, contents: "* -text\n" },
      { path: `${output}/mcp-launcher.mjs`, contents: launcher },
      { path: `${output}/mcp-servers.json`, contents: JSON.stringify({ plugin: "project", servers }, null, 2) + "\n" },
    ],
    entries: [],
    guidance: [],
  };
}
