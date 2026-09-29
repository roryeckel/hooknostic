import type { AgentDefinition, AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { contentsText } from "@hooknostic/agent-plugin";
import type {
  GeneratedArtifact,
  HarnessAdapter,
  ProjectComponentOptions,
  ProjectEntry,
  ProjectIntegration,
} from "@hooknostic/core";
import {
  launcherEnvironmentReferences,
  projectAgentFiles,
  projectHookBootstrap,
  projectMcpBootstrap,
  projectMcpLauncher,
  projectSkillFiles,
  renderTomlDocument,
} from "@hooknostic/core";

import { codexHarness } from "./harness.js";
import { translateMcp } from "./project-agent-plugin.js";

// Both forms a direct source may write. Codex's native fields carry only a
// plain `${NAME}`, so any other reference is refused rather than sent on as
// literal text.
const ENVIRONMENT_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;
const DEFAULTED_ENVIRONMENT_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}/;
const EXACT_ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_ENVIRONMENT_REFERENCE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i;

function directRemote(
  name: string,
  server: { url: string; headers?: Record<string, string> },
): Record<string, unknown> {
  if ([...server.url.matchAll(ENVIRONMENT_REFERENCE)].length) {
    throw new Error(
      `Codex project MCP ${JSON.stringify(name)} cannot represent environment references in a remote URL; use an environment-backed header`,
    );
  }
  const httpHeaders: Record<string, string> = Object.create(null);
  const envHttpHeaders: Record<string, string> = Object.create(null);
  let bearerTokenEnvVar: string | undefined;
  for (const [header, value] of Object.entries(server.headers ?? {})) {
    if (DEFAULTED_ENVIRONMENT_REFERENCE.test(value)) {
      throw new Error(
        `Codex project MCP ${JSON.stringify(name)} header ${JSON.stringify(header)} cannot represent a \${NAME:-default} fallback; Codex's environment-backed headers name a variable with no default`,
      );
    }
    const exact = value.match(EXACT_ENVIRONMENT_REFERENCE);
    const bearer = header.toLowerCase() === "authorization" ? value.match(BEARER_ENVIRONMENT_REFERENCE) : null;
    if (bearer) bearerTokenEnvVar = bearer[1]!;
    else if (exact) envHttpHeaders[header] = exact[1]!;
    else if ([...value.matchAll(ENVIRONMENT_REFERENCE)].length) {
      throw new Error(
        `Codex project MCP ${JSON.stringify(name)} header ${JSON.stringify(header)} cannot mix an environment reference with literal text`,
      );
    } else httpHeaders[header] = value;
  }
  return {
    url: server.url,
    ...(Object.keys(httpHeaders).length ? { http_headers: httpHeaders } : {}),
    ...(Object.keys(envHttpHeaders).length ? { env_http_headers: envHttpHeaders } : {}),
    ...(bearerTokenEnvVar === undefined ? {} : { bearer_token_env_var: bearerTokenEnvVar }),
  };
}
export function projectIntegration(
  artifacts: readonly GeneratedArtifact[],
  output: string,
  config: string,
): ProjectIntegration {
  if (/[$`]/.test(output))
    throw new Error("Codex project output paths containing shell expansion characters are unsupported");
  const manifest = artifacts.find((a) => a.path === ".codex/hooks.json");
  const entries: ProjectEntry[] = [];
  if (manifest) {
    const document = JSON.parse(contentsText(manifest.contents)) as {
      hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]>;
    };
    const command = projectHookBootstrap(`${output}/.codex/hooknostic/hooknostic.mjs`, config);
    for (const [event, groups] of Object.entries(document.hooks)) {
      for (const group of groups) for (const hook of group.hooks) hook.command = command;
      if (groups.length !== 1) throw new Error("expected one compiled dispatcher group per event");
      entries.push({ path: ".codex/hooks.json", key: ["hooks", event], kind: "array", value: groups[0] });
    }
  }
  return {
    files: [],
    entries,
    guidance: [
      "Restart Codex after synchronization. Review project and hook trust in Codex; execution has not been observed by this command.",
    ],
  };
}

export const codexAgents: NonNullable<HarnessAdapter["agents"]> = {
  projectDirectory: ".codex/agents",
  // `mcp_servers` would declare servers outside MCP validation and its
  // launcher; `hooks` would add hook layers beside the generated dispatcher.
  reservedNativeKeys: ["name", "description", "developer_instructions", "mcp_servers", "hooks"],
};

/**
 * `.codex/agents/<name>.toml`: `name`, `description` and the instructions as
 * `developer_instructions`, which Codex adds to its own base instructions
 * rather than replacing them, then `native.codex` verbatim. Codex rejects the
 * whole file over one unknown key (`.capture/agents`), so passthrough fields
 * are the author's to spell exactly as Codex's config reference does.
 */
export function renderCodexAgent(agent: AgentDefinition): { file: string; contents: string } {
  const native = Object.entries(agent.native["codex"] ?? {}).filter(
    ([key]) => !codexAgents.reservedNativeKeys.includes(key),
  );
  let contents: string;
  try {
    contents = renderTomlDocument({
      name: agent.name,
      description: agent.description,
      developer_instructions: agent.instructions,
      ...Object.fromEntries(native),
    });
  } catch (error) {
    throw new Error(
      `agent ${JSON.stringify(agent.name)}: native.codex ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { file: `${agent.name}.toml`, contents };
}

export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
  config: string,
  options: ProjectComponentOptions,
): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".agents/skills");
  const agents = projectAgentFiles(source.agents ?? [], codexAgents.projectDirectory, renderCodexAgent);
  result.files.push(...agents.files);
  if (agents.files.length > 0) {
    result.guidance.push(
      "Codex reads project agents from .codex/agents; restart it after synchronization, and review project trust in Codex.",
    );
    // A child inherits the parent's reasoning effort, which a different model
    // may refuse; 0.156.1 then fails the spawn outright (.capture/agents).
    const unpaired = (source.agents ?? []).filter((agent) => {
      const native = agent.native["codex"] ?? {};
      return native["model"] !== undefined && native["model_reasoning_effort"] === undefined;
    });
    if (unpaired.length > 0)
      result.guidance.push(
        `Codex agents ${unpaired.map((agent) => JSON.stringify(agent.name)).join(", ")} set native.codex.model without model_reasoning_effort; a spawned agent inherits the parent's effort, which a different model can refuse.`,
      );
  }
  const translated = translateMcp(
    source.mcp ? { mcp: source.mcp.config } : {},
    new Set(options.mcpProjectCwdServers),
    source.origin === "package" ? options.mcpEnvironment : undefined,
  );
  if (translated.omitted.length)
    throw new Error(translated.omitted.map((item) => `${item.name}: ${item.reason}`).join("; "));
  result.files.push(...(await projectMcpLauncher(source, root, output, translated.launcherServers)).files);
  for (const [name, server] of Object.entries(translated.servers)) {
    const declaration = source.mcp?.config.mcpServers[name];
    const launcherIndex = "command" in server ? Number(server.args![1]) : -1;
    const forwarded =
      launcherIndex < 0
        ? []
        : source.origin === "direct"
          ? launcherEnvironmentReferences(translated.launcherServers[launcherIndex]!)
          : "command" in server
            ? (server.env_vars ?? [])
            : [];
    const base =
      "command" in server
        ? {
            command: "node",
            args: projectMcpBootstrap(output, config, launcherIndex),
            ...(forwarded.length ? { env_vars: forwarded } : {}),
          }
        : source.origin === "direct" && declaration && declaration.type !== "stdio"
          ? directRemote(name, declaration)
          : server;
    const timeout = options.mcpStartupTimeoutMs?.[name];
    const value = { ...base, ...(timeout === undefined ? {} : { startup_timeout_sec: Math.ceil(timeout / 1000) }) };
    result.entries.push({
      path: ".codex/config.toml",
      key: ["mcp_servers", name],
      kind: "property",
      format: "toml",
      value,
    });
  }
  if (result.entries.length)
    result.guidance.push(
      "Codex reads project MCP only in trusted projects. Restart after synchronization. Same-named servers merge across home, project, nested, and command-line configuration; resolve conflicting declarations manually. Hooknostic does not inspect or change personal trust or connect to MCP servers during diagnostics.",
    );
  return result;
}

export const projectComponentProfiles: readonly AgentPluginProjectionProfile[] = [
  {
    range: codexHarness.recommendedRange,
    components: {
      "agent-plugin.skills": { level: "exact" },
      "agent-plugin.mcp.stdio": {
        level: "emulated",
        rationale:
          "An owned repository-locating Node bootstrap launches the portable server from its declared source root. Node must be on PATH; project trust remains a human prerequisite.",
      },
      "agent-plugin.mcp.streamable-http": {
        level: "exact",
        rationale: "Native project TOML url and http_headers preserve remote declarations.",
      },
      "agent-plugin.mcp.sse": {
        level: "unsupported",
        rationale: "SSE project transport is not established; Codex reads url declarations as Streamable HTTP.",
      },
      // Declared rather than left absent. An absent cell still raises HN205,
      // but behind core's rationale-free fallback, which tells the author
      // nothing they can act on. Claims about this projection's own reach, so
      // they rest on what project integration writes rather than on a capture.
      "agent-plugin.client-extension.files": {
        level: "unsupported",
        rationale:
          "Project integration writes .codex/config.toml and a skills tree. A plugin's extensions.\"com.openai\" object and its namespace files are read from an installed plugin's root, and project delivery installs nothing, so there is no surface at project scope that would read them. Deliver the package to reach them.",
      },
      "agent-plugin.runtime-package": {
        level: "unsupported",
        rationale:
          "Codex installs no dependencies even for an installed plugin -- measured on package delivery, where a copied package.json and package-lock.json left no node_modules in the installed root and the dependency failed to resolve. Project delivery installs nothing at all, so the pair would sit unread beside the projected files. Bundle a Node component's dependencies instead.",
      },
      "agents.definition": {
        level: "exact",
        rationale:
          "Written to .codex/agents/<name>.toml. Defining one adds an agent_type parameter to spawn_agent, whose description lists the subagent with its description, and the instructions reach the child as developer_instructions added to Codex's own base instructions rather than replacing them. Codex's model guidance tells it to spawn only when asked. Trust gating of project agents is not established: with no trust entry for the project, and only hook trust bypassed, codex exec still discovered its agent.",
      },
      "agents.native": {
        level: "exact",
        rationale:
          "native.codex fields are written verbatim as agent-file TOML; model and model_reasoning_effort were observed taking effect. sandbox_mode in an agent file did not change the child's policy, which followed the session's. Codex rejects the whole file over one unknown key, so every field must be one Codex's configuration accepts. mcp_servers and hooks are refused, because they belong to their own components.",
      },
    },
    source: {
      date: "2026-09-11",
      validatedOn: [
        {
          version: "0.156.1",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "A project .codex/agents TOML file added agent_type to spawn_agent with the agent listed under its description; spawning it delivered developer_instructions to the child after the base instructions, its model reached the child request once model_reasoning_effort was set, an unknown key made Codex ignore the whole file, and the child's reported sandbox_mode followed the session rather than the file.",
        },
        {
          version: "0.148.0",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "At the reference build, spawn_agent gained agent_type once a project agent existed, and a definition synchronized by Hooknostic's project delivery was delegated to and ran on its developer_instructions and native model, its result returning through wait_agent (packages/cli/test/agent-definition-playback.test.ts).",
        },
        {
          version: "0.154.0",
          date: "2026-09-22",
          method: "live-probe",
          artifact: ".capture/project-integration",
          what: "A direct stdio server started although its generated env_vars named a variable absent from Codex's environment, and the launcher resolved ${NAME:-default} for both the set and the unset name.",
        },
        {
          version: "0.153.2",
          date: "2026-09-11",
          method: "live-probe",
          artifact: ".capture/codex-project-mcp",
          what: "Production project reconciliation and launcher playback with stdio and loopback Streamable HTTP; trust, cwd, config layering and diagnostic network behavior recorded.",
        },
        {
          version: "0.153.2",
          date: "2026-09-11",
          method: "live-probe",
          artifact: ".capture/project-integration",
          what: "Repository-local hook and skill playback, including nested-session ownership bootstrap and target-specific stdio cwd, argv, and startup timeout.",
        },
        {
          version: "0.153.2",
          date: "2026-09-12",
          method: "doc-derived",
          artifact: ".capture/codex-project-mcp",
          what: "Official Codex MCP documentation defines bearer_token_env_var as the environment variable whose token is sent in the Authorization header; project startup behavior for this field was not live-probed.",
        },
        {
          version: "0.153.2",
          date: "2026-09-14",
          method: "live-probe",
          artifact: ".capture/codex-project-mcp",
          what: "A variable set in Codex's environment but not listed in env_vars does not reach a project stdio server (undeclaredEnvVar), so the projector lists every variable the launcher expands.",
        },
      ],
    },
  },
];
