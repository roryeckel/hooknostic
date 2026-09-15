import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import type {
  GeneratedArtifact,
  McpLauncherServer,
  ProjectComponentOptions,
  ProjectEntry,
  ProjectIntegration,
} from "@hooknostic/core";
import { projectHookBootstrap, projectMcpBootstrap, projectMcpLauncher, projectSkillFiles } from "@hooknostic/core";

import { codexHarness } from "./harness.js";
import { translateMcp } from "./project-agent-plugin.js";

const ENVIRONMENT_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const EXACT_ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_ENVIRONMENT_REFERENCE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i;
const LAUNCHER_SUPPLIED = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

/**
 * Variables the launcher expands for a stdio server. Codex passes a stdio child
 * only the variables listed in `env_vars` (.capture/codex-project-mcp), so each
 * one must be forwarded or the launcher sees it unset.
 */
function launcherEnvironment(server: McpLauncherServer): string[] {
  const expanded = [
    ...(server.args ?? []),
    ...Object.values(server.env ?? {}),
    ...(server.cwd === undefined || server.cwd.startsWith("./") ? [] : [server.cwd]),
  ];
  const names = new Set<string>();
  for (const text of expanded) {
    for (const match of text.matchAll(ENVIRONMENT_REFERENCE)) {
      if (!LAUNCHER_SUPPLIED.has(match[1]!)) names.add(match[1]!);
    }
  }
  return [...names].sort();
}

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
    const document = JSON.parse(
      typeof manifest.contents === "string" ? manifest.contents : new TextDecoder().decode(manifest.contents),
    ) as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };
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

export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
  config: string,
  options: ProjectComponentOptions,
): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".agents/skills");
  const translated = translateMcp(source.mcp ? { mcp: source.mcp.config } : {}, new Set(options.mcpProjectCwdServers));
  if (translated.omitted.length)
    throw new Error(translated.omitted.map((item) => `${item.name}: ${item.reason}`).join("; "));
  result.files.push(...(await projectMcpLauncher(source, root, output, translated.launcherServers)).files);
  for (const [name, server] of Object.entries(translated.servers)) {
    const declaration = source.mcp?.config.mcpServers[name];
    const launcherIndex = "command" in server ? Number(server.args![1]) : -1;
    const forwarded =
      source.origin === "direct" && launcherIndex >= 0
        ? launcherEnvironment(translated.launcherServers[launcherIndex]!)
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
        rationale: "Legacy SSE project transport is not established; Codex reads url declarations as Streamable HTTP.",
      },
    },
    source: {
      date: "2026-09-11",
      validatedOn: [
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
