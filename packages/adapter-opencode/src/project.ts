import { relative } from "node:path";

import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import type { GeneratedArtifact, ProjectComponentOptions, ProjectIntegration } from "@hooknostic/core";
import { projectMcpLauncher, projectSkillFiles } from "@hooknostic/core";

import { opencodeHarness } from "./harness.js";
import { RUNTIME_LAUNCHER, RUNTIME_PLUGIN_ROOT, translateMcp } from "./project-agent-plugin.js";
/** Project wiring whose `.opencode/plugins` module is `wrap(importPathOfArtifact)`. */
export function projectIntegrationWith(wrap: (importPath: string) => string) {
  return (artifacts: readonly GeneratedArtifact[], output: string): ProjectIntegration => {
    const importPath = (path: string): string =>
      path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    const files = [
      {
        path: ".opencode/plugins/.gitattributes",
        contents: ".gitattributes -text\nhooknostic.js -text\nhooknostic-components.js -text\n",
      },
      ...artifacts
        .filter((a) => a.path.startsWith(".opencode/plugins/"))
        .map((a) => ({ path: a.path, contents: wrap("../../" + importPath(output + "/" + a.path)) })),
    ];
    return {
      files,
      entries: [],
      guidance: ["Restart OpenCode to reload project modules; execution has not been observed by this command."],
    };
  };
}

export const projectIntegration = projectIntegrationWith(
  (importPath) => `export { default } from ${JSON.stringify(importPath)};\n`,
);

export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
  _config: string,
  options: ProjectComponentOptions,
  emitMcp?: (body: string) => string,
): Promise<ProjectIntegration> {
  // OpenCode discovers .agents/skills natively. Copy the loader's filtered
  // inventory there instead of naming its unfiltered source directory through
  // skills.paths, which would re-expose excluded files and rejected siblings.
  const result = projectSkillFiles(source, root, ".agents/skills");
  if (source.mcp) {
    const launcher = await projectMcpLauncher(source, root, output);
    result.files.push(...launcher.files);
    const sourceRoot = relative(root, source.mcp?.root ?? root).replaceAll("\\", "/") || ".";
    const translated = translateMcp(
      source.mcp ? { mcp: source.mcp.config } : {},
      new Set(options.mcpProjectCwdServers),
    );
    if (translated.omitted.length)
      throw new Error(translated.omitted.map((item) => `${item.name}: ${item.reason}`).join("; "));
    const declarations = Object.entries(translated.servers).map(([name, server]) => {
      const timeout = options.mcpStartupTimeoutMs?.[name];
      return [name, { ...server, ...(timeout === undefined ? {} : { timeout }) }] as const;
    });
    const directEnvironmentResolution =
      source.origin === "direct"
        ? `
const expandEnvironment = (value, missing) => value.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\\}/g, (reference, name, fallback) => {
  const resolved = process.env[name];
  if (resolved !== undefined) return resolved;
  if (fallback !== undefined) return fallback;
  missing.add(name);
  return reference;
});
const resolveRemote = (name, server) => {
  const missing = new Set();
  const resolved = { ...server,
    url: expandEnvironment(server.url, missing),
    ...(server.headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(server.headers).map(([header, value]) => [header, expandEnvironment(value, missing)])) }),
  };
  if (missing.size === 0) return resolved;
  console.warn("Hooknostic disabled MCP " + JSON.stringify(name) + ": missing environment " + [...missing].sort().join(", "));
  return { ...server, enabled: false };
};
`
        : "\nconst resolveRemote = (_name, server) => server;\n";
    const module = `/* global process, console */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const declarations = JSON.parse(${JSON.stringify(JSON.stringify(declarations))});
${directEnvironmentResolution}
${emitMcp ? "const configure = (config) => {" : "export default async () => ({ config(config) {"}
  const mcp = { ...(config.mcp ?? {}) };
  for (const [name, server] of declarations) {
    const value = server.type === "local" ? { ...server,
      command: server.command.map(arg => arg === ${JSON.stringify(RUNTIME_LAUNCHER)} ? resolve(root, ${JSON.stringify(output + "/mcp-launcher.mjs")}) : arg),
      cwd: server.cwd === ${JSON.stringify(RUNTIME_PLUGIN_ROOT)} ? resolve(root, ${JSON.stringify(sourceRoot)}) : server.cwd,
    } : resolveRemote(name, server);
    Object.defineProperty(mcp, name, { value, enumerable: true, configurable: true, writable: true });
  }
  config.mcp = mcp;
${emitMcp ? "};" : "} });"}
`;
    result.files.push({
      path: ".opencode/plugins/hooknostic-components.js",
      contents: emitMcp ? emitMcp(module) : module,
    });
    result.absent = declarations.flatMap(([name]) =>
      ["opencode.json", "opencode.jsonc"].map((path) => ({ path, key: ["mcp", name] })),
    );
  }
  return result;
}

export const projectComponentProfiles: readonly AgentPluginProjectionProfile[] = [
  {
    range: opencodeHarness.recommendedRange,
    components: {
      "agent-plugin.skills": { level: "exact" },
      "agent-plugin.mcp.stdio": {
        level: "emulated",
        rationale:
          "A project launcher resolves portable paths and variables at runtime; dependencies are supplied by the project.",
      },
      "agent-plugin.mcp.streamable-http": { level: "exact" },
      "agent-plugin.mcp.sse": { level: "exact" },
      // Declared rather than left absent. An absent cell still raises HN205,
      // but behind core's rationale-free fallback, which tells the author
      // nothing they can act on. Claims about this projection's own reach, so
      // they rest on what project integration writes rather than on a capture.
      "agent-plugin.client-extension.files": {
        level: "unsupported",
        rationale: "OpenCode reads no portable client-extension namespace, at project scope or any other.",
      },
      "agent-plugin.runtime-package": {
        level: "unsupported",
        rationale:
          "Of OpenCode's three measured routes only a registry-installed package resolves a dependency closure, and it does so from its own npm manifest rather than from this component's. A project plugin is read from .opencode/plugins/ with no install step at all, so a manifest and lockfile written beside it would leave no node_modules. Bundle a Node component's dependencies, which works on every route.",
      },
    },
    source: {
      date: "2026-09-11",
      validatedOn: [
        {
          version: "1.18.29",
          date: "2026-09-11",
          method: "live-probe",
          artifact: ".capture/project-integration",
          what: "Repository-local hook and skill playback plus loopback MCP transports; activation boundaries are recorded in the capture notes.",
        },
        {
          version: "1.18.30",
          date: "2026-09-11",
          method: "live-probe",
          artifact: ".capture/project-integration",
          what: "Project declarations replaced a same-named inherited server, an unset remote variable disabled only that server, and unaffected loopback MCP remained available.",
        },
      ],
    },
  },
];
