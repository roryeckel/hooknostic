import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { contentsText, RELATIVE_SKILL_TEXT, SKILL_REFERENCE_UNEXPANDED } from "@hooknostic/agent-plugin";
import type { GeneratedArtifact, ProjectComponentOptions, ProjectEntry, ProjectIntegration } from "@hooknostic/core";
import {
  launcherEnvironmentReferences,
  projectHookBootstrap,
  projectMcpBootstrap,
  projectMcpLauncher,
  projectSkillFiles,
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

export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
  config: string,
  options: ProjectComponentOptions,
): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".agents/skills", { target: RELATIVE_SKILL_TEXT, harness: "Codex" });
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
      "agent-plugin.skills": {
        level: "exact",
        rationale:
          "Copied into .agents/skills as authored, except that ${SKILL_DIR} in a SKILL.md body becomes `.`: Codex expands nothing in skill text, and the base instructions of the models it bundles tell the model to resolve a skill's relative paths against the directory containing its SKILL.md (ADR-0028). A skill already at its destination is discovered in place and not rewritten.",
        degradations: [
          {
            id: SKILL_REFERENCE_UNEXPANDED,
            summary:
              "A SKILL.md that holds a Claude Code variable such as ${CLAUDE_PLUGIN_ROOT}, ${PLUGIN_ROOT} or ${PLUGIN_DATA} anywhere, ${SKILL_DIR} in its frontmatter, or ${SKILL_DIR} at all in a skill discovered in place, reaches the model with that text as written: Codex expands nothing in skill text.",
            evidence: ".capture/skill-directory",
          },
        ],
      },
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
    },
    source: {
      date: "2026-09-11",
      validatedOn: [
        {
          version: "0.154.0",
          date: "2026-09-30",
          method: "live-probe",
          artifact: ".capture/skill-directory",
          what: "Over the loopback model with isolated state, a $where mention handed the model the project skill's SKILL.md path and the whole file with every ${...} as written: ${CLAUDE_SKILL_DIR}, ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${CLAUDE_SESSION_ID}, ${SKILL_DIR}, ${PLUGIN_ROOT}, ${PLUGIN_DATA} and ${HOME}. The base instructions of all seven models codex debug models lists say to resolve relative paths against the directory containing a filesystem-backed SKILL.md; the loopback model, served through a custom provider, received none.",
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
