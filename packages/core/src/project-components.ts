import { relative, resolve } from "node:path";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { bundleMcpLauncher, type McpLauncherServer } from "./mcp-launcher.js";
import type { ProjectIntegration } from "./project-files.js";
export function projectSkillFiles(source: ProjectComponents, root: string, destination: string): ProjectIntegration {
  const files = source.skills.flatMap(skill => {
    const path = `${destination}/${skill.name}`;
    if (resolve(root, path) === resolve(skill.source)) return [];
    return skill.files.map(file => ({ ...file, path: `${path}/${file.path}` }));
  });
  return { files, entries: [], guidance: [] };
}
export async function projectMcpLauncher(source: ProjectComponents, root: string, output: string, selectedServers?: McpLauncherServer[]): Promise<ProjectIntegration> {
  if (!source.mcp) return { files: [], entries: [], guidance: [] };
  const servers = selectedServers ?? Object.entries(source.mcp.config.mcpServers).filter(([, s]) => s.type === "stdio").map(([name, s]) => ({ name, ...s }));
  if (!servers.length) return { files: [], entries: [], guidance: [] };
  const relativeToOutput = (path: string) => relative(resolve(root, output), path).replaceAll("\\", "/") || ".";
  const launcher = await bundleMcpLauncher({ frontEnd: "self-resolving", rootOffset: relativeToOutput(source.mcp.root), dataOffset: relativeToOutput(resolve(root, ".hooknostic/data")), pluginName: "project", environmentReferences: source.origin === "direct" });
  return { files: [
    { path: `${output}/.gitattributes`, contents: "* -text\n" },
    { path: `${output}/mcp-launcher.mjs`, contents: launcher },
    { path: `${output}/mcp-servers.json`, contents: JSON.stringify({ plugin: "project", servers }, null, 2) + "\n" },
  ], entries: [], guidance: [] };
}
