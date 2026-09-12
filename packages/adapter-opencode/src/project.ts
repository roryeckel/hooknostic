import { translateMcp, RUNTIME_LAUNCHER, RUNTIME_PLUGIN_ROOT } from "./project-agent-plugin.js";
import { opencodeHarness } from "./harness.js";
import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import { dirname, relative, resolve } from "node:path";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { projectMcpLauncher } from "@hooknostic/core";
import type { GeneratedArtifact, ProjectIntegration } from "@hooknostic/core";
export function projectIntegration(artifacts: readonly GeneratedArtifact[], output: string): ProjectIntegration {
  const files = [{
    path: ".opencode/plugins/.gitattributes",
    contents: "hooknostic.js -text\nhooknostic-components.js -text\n",
  }, ...artifacts.filter(a => a.path.startsWith(".opencode/plugins/")).map(a => ({
    path: a.path,
    contents: `export { default } from ${JSON.stringify("../../" + output + "/" + a.path)};\n`,
  }))];
  return { files, entries: [], guidance: ["Restart OpenCode to reload project modules; execution has not been observed by this command."] };
}

export async function projectComponents(source: ProjectComponents, root: string, output: string): Promise<ProjectIntegration> {
  const result: ProjectIntegration = { files: [], entries: [], guidance: [] };
  const skillRoots = [...new Set(source.skills.filter(skill => resolve(skill.source) !== resolve(root, ".agents/skills", skill.name)).map(skill => relative(root, dirname(skill.source)).replaceAll("\\", "/") || "."))];
  if (source.mcp || skillRoots.length) {
    const launcher = await projectMcpLauncher(source, root, output);
    result.files.push(...launcher.files);
    const sourceRoot = relative(root, source.mcp?.root ?? root).replaceAll("\\", "/") || ".";
    const translated = translateMcp(source.mcp ? { mcp: source.mcp.config } : {});
    if (translated.omitted.length) throw new Error(translated.omitted.map(item => `${item.name}: ${item.reason}`).join("; "));
    const declarations = Object.entries(translated.servers);
    const directEnvironmentResolution = source.origin === "direct" ? `
const expandEnvironment = (value) => value.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (reference, name) => {
  const resolved = process.env[name];
  if (resolved === undefined) throw new Error("Hooknostic MCP environment variable " + name + " is required by " + reference);
  return resolved;
});
const resolveRemote = (server) => ({ ...server,
  url: expandEnvironment(server.url),
  ...(server.headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [name, expandEnvironment(value)])) }),
});
` : "\nconst resolveRemote = (server) => server;\n";
    const module = `import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const declarations = JSON.parse(${JSON.stringify(JSON.stringify(declarations))});
${directEnvironmentResolution}
export default async () => ({ config(config) {
  const paths = ${JSON.stringify(skillRoots)}.map(path => resolve(root, path));
  if (paths.length) config.skills = { ...(config.skills ?? {}), paths: [...new Set([...(config.skills?.paths ?? []), ...paths])] };
  const mcp = { ...(config.mcp ?? {}) };
  for (const [name, server] of declarations) {
    if (Object.hasOwn(mcp, name)) throw new Error("Hooknostic MCP collision: " + name);
    const value = server.type === "local" ? { ...server,
      command: server.command.map(arg => arg === ${JSON.stringify(RUNTIME_LAUNCHER)} ? resolve(root, ${JSON.stringify(output + "/mcp-launcher.mjs")}) : arg),
      cwd: server.cwd === ${JSON.stringify(RUNTIME_PLUGIN_ROOT)} ? resolve(root, ${JSON.stringify(sourceRoot)}) : server.cwd,
    } : resolveRemote(server);
    Object.defineProperty(mcp, name, { value, enumerable: true, configurable: true, writable: true });
  }
  config.mcp = mcp;
} });
`;
    result.files.push({ path: ".opencode/plugins/hooknostic-components.js", contents: module });
    result.absent = declarations.flatMap(([name]) => ["opencode.json", "opencode.jsonc"].map(path => ({ path, key: ["mcp", name] })));
  }
  return result;
}

export const projectComponentProfiles: readonly AgentPluginProjectionProfile[] = [{
  range: opencodeHarness.recommendedRange,
  components: {
    "agent-plugin.skills": { level: "exact" },
    "agent-plugin.mcp.stdio": { level: "emulated", rationale: "A project launcher resolves portable paths and variables at runtime; dependencies are supplied by the project." },
    "agent-plugin.mcp.streamable-http": { level: "exact" },
    "agent-plugin.mcp.sse": { level: "exact" },
  },
  source: {
    date: "2026-09-11",
    validatedOn: [{ version: "1.18.29", date: "2026-09-11", method: "live-probe", artifact: ".capture/project-integration", what: "Repository-local hook and skill playback plus loopback MCP transports; activation boundaries are recorded in the capture notes." }],
  },
}];
