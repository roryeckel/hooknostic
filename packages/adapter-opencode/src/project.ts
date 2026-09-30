import { relative } from "node:path";

import type {
  AgentDefinition,
  AgentPluginComponentSupport,
  AgentPluginDegradation,
  AgentPluginProjectionProfile,
} from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { renderMarkdownFrontmatter } from "@hooknostic/agent-plugin";
import type { GeneratedArtifact, HarnessAdapter, ProjectComponentOptions, ProjectIntegration } from "@hooknostic/core";
import { projectAgentFiles, projectMcpLauncher, projectSkillFiles } from "@hooknostic/core";

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

export const opencodeAgents: NonNullable<HarnessAdapter["agents"]> = {
  projectDirectory: ".opencode/agents",
  // The file name is the identity, so `name` has nothing to say and v1 would
  // pass it to the provider as a model option. `prompt` (v1) and `system` (v2)
  // are the instructions, and `mode` is the portable field's (ADR-0028).
  reservedNativeKeys: ["name", "description", "mode", "prompt", "system"],
};

/**
 * `.opencode/agents/<name>.md` for both families: the file name is the agent,
 * the definition's `mode` is always written -- OpenCode's own default is not
 * `subagent`: v2 makes an agent primary, which its subagent tool cannot select
 * -- and the instructions are the body, which replaces the provider's base
 * prompt (`.capture/agents`).
 */
export function renderOpenCodeAgent(agent: AgentDefinition): { file: string; contents: string } {
  const native = Object.entries(agent.native["opencode"] ?? {}).filter(
    ([key]) => !opencodeAgents.reservedNativeKeys.includes(key),
  );
  return {
    file: `${agent.name}.md`,
    contents: renderMarkdownFrontmatter(
      { description: agent.description, mode: agent.mode, ...Object.fromEntries(native) },
      agent.instructions,
    ),
  };
}

/**
 * OpenCode 2.0.17 runs a session started as the agent on the configured
 * `model`, not on the agent's own, which applies only when it runs as a
 * subagent (`.capture/agents`). Only the v2 project cell declares this.
 */
export const PRIMARY_AGENT_MODEL_IGNORED = "primary-agent-model-ignored";

/** The degradation for each primary-capable definition with a native model, where the cell declares it. */
export function primaryModelDegradations(
  agents: readonly AgentDefinition[],
  cell: AgentPluginComponentSupport | undefined,
): AgentPluginDegradation[] {
  if (!(cell?.degradations ?? []).some((item) => item.id === PRIMARY_AGENT_MODEL_IGNORED)) return [];
  return agents
    .filter((agent) => agent.mode !== "subagent" && agent.native["opencode"]?.["model"] !== undefined)
    .map((agent) => ({
      id: PRIMARY_AGENT_MODEL_IGNORED,
      component: "agents.native",
      name: agent.name,
      path: agent.source,
      reason: `agent ${JSON.stringify(agent.name)} sets native.opencode.model, which OpenCode ignores for a session run as the agent; it applies when the agent runs as a subagent.`,
    }));
}

export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
  _config: string,
  options: ProjectComponentOptions,
  emitMcp?: (body: string, options: { defaultAgent?: string }) => string,
): Promise<ProjectIntegration> {
  // OpenCode discovers .agents/skills natively. Copy the loader's filtered
  // inventory there instead of naming its unfiltered source directory through
  // skills.paths, which would re-expose excluded files and rejected siblings.
  const result = projectSkillFiles(source, root, ".agents/skills");
  const agents = projectAgentFiles(source.agents ?? [], opencodeAgents.projectDirectory, renderOpenCodeAgent);
  result.files.push(...agents.files);
  if (agents.files.length > 0)
    result.guidance.push("OpenCode reads project agents from .opencode/agents; restart it after synchronization.");
  const ignoredModels = primaryModelDegradations(source.agents ?? [], options.support?.["agents.native"]);
  if (ignoredModels.length > 0) (result.degradations ??= []).push(...ignoredModels);
  // The components module also carries the default agent: OpenCode's own
  // default_agent, set from the project's plugin rather than written into a
  // configuration file that may be spelled either way (`.capture/agents`
  // inject-default, both families).
  if (source.mcp || source.defaultAgent !== undefined) {
    if (source.mcp) result.files.push(...(await projectMcpLauncher(source, root, output)).files);
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
      source.mcp && source.origin === "direct"
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
${source.defaultAgent === undefined ? "" : `  config.default_agent = ${JSON.stringify(source.defaultAgent)};\n`}${emitMcp ? "};" : "} });"}
`;
    result.files.push({
      path: ".opencode/plugins/hooknostic-components.js",
      contents: emitMcp
        ? emitMcp(module, source.defaultAgent === undefined ? {} : { defaultAgent: source.defaultAgent })
        : module,
    });
    // A project that names its own default keeps it: sync refuses instead.
    result.absent = [
      ...declarations.flatMap(([name]) =>
        ["opencode.json", "opencode.jsonc"].map((path) => ({ path, key: ["mcp", name] })),
      ),
      ...(source.defaultAgent === undefined
        ? []
        : ["opencode.json", "opencode.jsonc"].map((path) => ({ path, key: ["default_agent"] }))),
    ];
    if (source.defaultAgent !== undefined)
      result.guidance.push(`OpenCode sessions in this project now start as the ${source.defaultAgent} agent.`);
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
      "agents.definition": {
        level: "exact",
        rationale:
          "Written to .opencode/agents/<name>.md with the definition's mode. As a subagent or all, the task tool's description offers it to the parent with its description, and the instructions replace the provider's base prompt; environment details are appended.",
      },
      "agents.default": {
        level: "exact",
        rationale:
          "The project's components plugin sets default_agent from its config hook, and OpenCode starts every session in the project as that agent; sync refuses a project whose opencode.json or opencode.jsonc already names one.",
      },
      "agents.primary": {
        level: "exact",
        rationale:
          "With mode: primary or all, opencode run --agent <name> and default_agent run the session as the agent, on its instructions in place of the provider prompt, its model and its permission rules; a primary agent is absent from the task tool, and OpenCode falls back to its default agent when told to run a subagent.",
      },
      "agents.native": {
        level: "exact",
        rationale:
          "native.opencode fields are written verbatim into the frontmatter; model and permission were observed taking effect, a denied tool leaving the child's tool list. On 1.18.31 neither steps nor maxSteps stopped the child. OpenCode passes a key it does not know to the provider as a model option.",
      },
    },
    source: {
      date: "2026-09-11",
      validatedOn: [
        {
          version: "1.18.31",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "A project .opencode/agents file (and the legacy .opencode/agent directory) was offered to the parent through the task tool with its description; its body replaced the provider prompt, its model reached the child request, permission deny removed edit and bash from the child's tools, steps and maxSteps did not cap the child, and neither .claude/agents nor .agents/agents was read.",
        },
        {
          version: "1.18.31",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "With mode: primary or all, a project agent ran as the session through run --agent and through default_agent, on its body in place of the provider prompt, its model and its permission denies; primary agents were absent from the task tool and all agents present, and run --agent on a mode: subagent agent fell back to the default agent with a warning. A mode: primary definition synchronized by Hooknostic's project delivery ran as the session through run --agent, on its instructions and native model (packages/cli/test/agent-definition-playback.test.ts). With components.defaultAgent naming a synchronized mode: primary definition, a session started with no --agent ran as it (packages/cli/test/agent-definition-playback.test.ts, generated-default).",
        },
        {
          version: "1.18.18",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "At the reference build every mode behaved as on 1.18.31: primary and all agents ran as the session, only subagent and all agents were offered for delegation, a subagent fell back, and a synchronized mode: primary definition ran as the session.",
        },
        {
          version: "1.18.18",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "At the reference build, a project agent and a config-hook-injected one behaved as on 1.18.31, and a definition synchronized by Hooknostic's project delivery was offered through the task tool, delegated to, and ran on its instructions and native model (packages/cli/test/agent-definition-playback.test.ts).",
        },
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
