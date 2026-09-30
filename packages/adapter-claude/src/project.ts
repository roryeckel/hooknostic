import type {
  AgentDefinition,
  AgentPluginComponentSupport,
  AgentPluginDeviation,
  AgentPluginProjectionProfile,
} from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { contentsText, renderMarkdownFrontmatter } from "@hooknostic/agent-plugin";
import type {
  GeneratedArtifact,
  HarnessAdapter,
  ProjectComponentOptions,
  ProjectEntry,
  ProjectIntegration,
} from "@hooknostic/core";
import { projectAgentFiles, projectMcpLauncher, projectSkillFiles } from "@hooknostic/core";

import { claudeHarness } from "./harness.js";
import {
  claudeExpandedReferences,
  declaresEnvironmentExpansion,
  ENVIRONMENT_EXPANSION_DEVIATION,
  environmentExpansionReason,
} from "./mcp-expansion.js";
export function projectIntegration(artifacts: readonly GeneratedArtifact[], output: string): ProjectIntegration {
  const manifest = artifacts.find((a) => a.path === "hooks/hooks.json");
  const entries: ProjectEntry[] = [];
  if (manifest) {
    const document = JSON.parse(contentsText(manifest.contents)) as {
      hooks: Record<string, { hooks: { command: string; args?: string[]; timeout: number }[] }[]>;
    };
    for (const [event, groups] of Object.entries(document.hooks)) {
      for (const group of groups)
        for (const command of group.hooks) {
          command.command = "node";
          command.args = [`${"${CLAUDE_PROJECT_DIR}"}/${output}/runtime/hooknostic.mjs`];
        }
      if (groups.length !== 1) throw new Error("expected one compiled dispatcher group per event");
      entries.push({ path: ".claude/settings.json", key: ["hooks", event], kind: "array", value: groups[0] });
    }
  }
  return {
    files: [],
    entries,
    guidance: [
      "Restart Claude Code after synchronization; project hook execution has not been observed by this command.",
    ],
  };
}

export const claudeAgents: NonNullable<HarnessAdapter["agents"]> = {
  projectDirectory: ".claude/agents",
  // `hooks` would run commands beside the one generated dispatcher (ADR-0003),
  // and `mcpServers` would declare servers outside MCP validation and its
  // launcher; both belong to their own components.
  reservedNativeKeys: ["name", "description", "hooks", "mcpServers"],
};

/**
 * Claude has no agent mode: every agent file can run as a session (`--agent`,
 * the `agent` setting) and is offered for delegation. So a `primary`
 * definition is delegable too, which only a project permission rule,
 * `Agent(<name>)`, would withhold (`.capture/agents`, ADR-0027 decision 9).
 */
export const PRIMARY_AGENT_DELEGABLE = "primary-agent-delegable";

/** The deviation for each `primary` definition, where the cell declares it. */
export function primaryDelegableDeviations(
  agents: readonly AgentDefinition[],
  cell: AgentPluginComponentSupport | undefined,
): AgentPluginDeviation[] {
  if (!(cell?.deviations ?? []).some((item) => item.id === PRIMARY_AGENT_DELEGABLE)) return [];
  return agents
    .filter((agent) => agent.mode === "primary")
    .map((agent) => ({
      id: PRIMARY_AGENT_DELEGABLE,
      component: "agents.primary",
      name: agent.name,
      path: agent.source,
      reason: `agent ${JSON.stringify(agent.name)} is primary only, but Claude also offers it for delegation.`,
    }));
}

/**
 * `.claude/agents/<name>.md` for every mode: the portable core as Claude's own
 * frontmatter fields, then `native.claude` verbatim, then the instructions as
 * the body, which Claude uses as the system prompt of a subagent and of a
 * session run as the agent alike (`.capture/agents`).
 */
export function renderClaudeAgent(agent: AgentDefinition): { file: string; contents: string } {
  const native = Object.entries(agent.native["claude"] ?? {}).filter(
    ([key]) => !claudeAgents.reservedNativeKeys.includes(key),
  );
  return {
    file: `${agent.name}.md`,
    contents: renderMarkdownFrontmatter(
      { name: agent.name, description: agent.description, ...Object.fromEntries(native) },
      agent.instructions,
    ),
  };
}

export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
  _config?: string,
  options: ProjectComponentOptions = {},
): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".claude/skills");
  const agents = projectAgentFiles(source.agents ?? [], claudeAgents.projectDirectory, renderClaudeAgent);
  result.files.push(...agents.files);
  if (agents.files.length > 0)
    result.guidance.push("Claude Code reads project agents from .claude/agents; restart it if that directory is new.");
  const delegable = primaryDelegableDeviations(source.agents ?? [], options.support?.["agents.primary"]);
  if (delegable.length > 0) (result.deviations ??= []).push(...delegable);
  if ((source.agents ?? []).some((agent) => agent.mode !== "subagent"))
    result.guidance.push("Start a Claude Code session as a primary agent with claude --agent <name>.");
  if (source.mcp) {
    const launcher = await projectMcpLauncher(source, root, output);
    result.files.push(...launcher.files);
    let index = 0;
    for (const [name, server] of Object.entries(source.mcp.config.mcpServers)) {
      const component = `agent-plugin.mcp.${server.type}` as const;
      // Only a package's text is governed by the specification: a direct
      // source's `${NAME}` is a request Claude is meant to resolve. Stdio
      // servers launch from the opaque document, which Claude never expands, so
      // only a remote declaration shows Claude package text. The document is
      // forced, not chosen: a project .mcp.json has no variable naming a package
      // root (`.capture/claude-project-mcp-environment`).
      if (source.origin === "package" && server.type !== "stdio") {
        const references = claudeExpandedReferences(server);
        if (references.length > 0 && declaresEnvironmentExpansion(options.support?.[component])) {
          (result.deviations ??= []).push({
            id: ENVIRONMENT_EXPANSION_DEVIATION,
            component,
            name,
            path: `mcp.json#${name}`,
            reason: environmentExpansionReason(name, references),
          });
        }
      }
      const value =
        server.type === "stdio"
          ? { command: "node", args: [`./${output}/mcp-launcher.mjs`, String(index++)] }
          : {
              type: server.type === "streamable-http" ? "http" : "sse",
              url: server.url,
              ...(server.headers === undefined ? {} : { headers: server.headers }),
            };
      result.entries.push({ path: ".mcp.json", key: ["mcpServers", name], kind: "property", value });
    }
    result.guidance.push(
      "Launch Claude Code from the project root for project MCP commands; approve servers through the harness.",
    );
  }
  return result;
}

export const projectComponentProfiles: readonly AgentPluginProjectionProfile[] = [
  {
    range: claudeHarness.recommendedRange,
    components: {
      "agent-plugin.skills": { level: "exact" },
      "agent-plugin.mcp.stdio": {
        level: "emulated",
        rationale:
          "A project .mcp.json has no variable naming the project or a package root, so a generated launcher resolves the package's paths, working directory and plugin variables from its own location, and Claude sees only the launcher. A package's other text therefore reaches the server literally, as Agent Plugins 1.0 requires, where package delivery lets Claude expand it; a direct source's references are resolved from Claude's environment by Claude's own rules, except that an unset one with no default stops the server. Dependencies are supplied by the project.",
      },
      "agent-plugin.mcp.streamable-http": {
        level: "exact",
        deviations: [
          {
            id: ENVIRONMENT_EXPANSION_DEVIATION,
            summary:
              "Claude substitutes set environment variables into project remote urls and headers, where Agent Plugins 1.0 forbids all expansion in a package's declaration.",
            evidence: ".capture/claude-project-mcp-environment",
          },
        ],
      },
      "agent-plugin.mcp.sse": {
        level: "exact",
        deviations: [
          {
            id: ENVIRONMENT_EXPANSION_DEVIATION,
            summary:
              "Claude substitutes set environment variables into project remote urls and headers, where Agent Plugins 1.0 forbids all expansion in a package's declaration.",
            evidence: ".capture/claude-project-mcp-environment",
          },
        ],
      },
      // Declared rather than left absent. An absent cell still raises HN205,
      // but behind core's rationale-free fallback, which tells the author
      // nothing they can act on. Claims about this projection's own reach, so
      // they rest on what project integration writes rather than on a capture.
      "agent-plugin.client-extension.files": {
        level: "unsupported",
        rationale:
          "Project integration writes .mcp.json, a skills tree and settings Claude reads from the project. The com.anthropic.claude-code namespace is an overlay on an installed plugin's root, and project delivery installs nothing, so there is no surface at project scope that would read it. Deliver the package to reach it.",
      },
      "agent-plugin.runtime-package": {
        level: "unsupported",
        rationale:
          "The locked install this component depends on is Claude's own, run in its plugin cache against an installed marketplace copy (ADR-0012). Project delivery installs nothing, so a manifest and lockfile written beside the projected files would be read by nothing and no node_modules would appear. Bundle a Node component's dependencies, or deliver the package, where Claude supports this exactly.",
      },
      "agents.definition": {
        level: "exact",
        rationale:
          "Written to .claude/agents/<name>.md, one file whatever the mode. The parent is offered the subagent by name and description, and the instructions become its system prompt, replacing Claude Code's default; a one-line SDK preamble and Claude's short subagent notes remain around them.",
      },
      "agents.primary": {
        level: "exact",
        rationale:
          "The same file runs as a session through claude --agent <name> or the agent setting: the instructions replace the default system prompt between the one-line SDK preamble and the environment section, and its native tool list and model apply to the session. Every event of that session names the agent as agent_type.",
        deviations: [
          {
            id: PRIMARY_AGENT_DELEGABLE,
            summary:
              "Claude has no agent mode, so it also offers a primary-only agent for delegation. Only a project permission rule, Agent(<name>) in permissions.deny, withholds it, and Hooknostic does not write one.",
            evidence: ".capture/agents",
          },
        ],
      },
      "agents.native": {
        level: "exact",
        rationale:
          "native.claude fields are written verbatim into the frontmatter; tools, model and maxTurns were each observed taking effect, and tools and model apply to a session run as the agent too. hooks and mcpServers are refused, because they belong to their own components.",
      },
    },
    source: {
      date: "2026-09-12",
      validatedOn: [
        {
          version: "2.1.283",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "A project .claude/agents file was advertised to the parent with its description and selected through Agent's subagent_type; its body replaced the default system prompt, its tools list was the child's exact tool set, its model reached the child request, maxTurns stopped the child at the limit, and hook payloads inside the child carried agent_type.",
        },
        {
          version: "2.1.238",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "At the reference build, a project and a plugin agent behaved as on 2.1.283, and a definition synchronized by Hooknostic's project delivery was advertised, delegated to, and ran on its instructions, native model and native tools (packages/cli/test/agent-definition-playback.test.ts).",
        },
        {
          version: "2.1.283",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "The same project file ran as the session through --agent and through the project's agent setting: its body replaced the default system prompt, its tools list was the session's exact tool set, its model reached every request, and every hook event of the session carried agent_type without agent_id. With permissions.deny: [Agent(<name>)] in the project settings the parent's request no longer listed the agent and its delegation was refused, while --agent still ran it. A mode: primary definition synchronized by Hooknostic's project delivery ran as the session through --agent, on its instructions, native tools and native model (packages/cli/test/agent-definition-playback.test.ts).",
        },
        {
          version: "2.1.238",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "At the reference build a project agent ran as the session through --agent and the agent setting as on 2.1.283, and the permission rule withheld it from delegation the same way; a synchronized mode: primary definition ran as the session.",
        },
        {
          version: "2.1.278",
          date: "2026-09-22",
          method: "live-probe",
          artifact: ".capture/claude-project-mcp-environment",
          what: "Direct source: in its own declaration Claude resolved ${NAME:-default} to a defined variable's value, even an empty one, and otherwise to the default; a direct stdio server received the same values through the launcher, and one with an unset ${NAME} and no default did not start.",
        },
        {
          version: "2.1.278",
          date: "2026-09-21",
          method: "live-probe",
          artifact: ".capture/claude-project-mcp-environment",
          what: "Project stdio: a synchronized package server received its ${NAME} and ${NAME:-default} args and env values literally through the generated launcher, while Claude expanded the same text in a native declaration; Claude did not expand ${CLAUDE_PROJECT_DIR} in .mcp.json, though it set that variable for the child.",
        },
        {
          version: "2.1.278",
          date: "2026-09-21",
          method: "live-probe",
          artifact: ".capture/claude-project-mcp-environment",
          what: "Re-run with ${NAME:-default} added: project MCP expanded set references and substituted the default for unset ones in remote urls and headers; plain unset references remained literal, and no tested escape preserved a literal.",
        },
        {
          version: "2.1.268",
          date: "2026-09-11",
          method: "live-probe",
          artifact: ".capture/project-integration",
          what: "Repository-local hook and skill playback plus loopback MCP transports; activation boundaries are recorded in the capture notes.",
        },
        {
          version: "2.1.268",
          date: "2026-09-12",
          method: "live-probe",
          artifact: ".capture/claude-project-mcp-environment",
          what: "Project MCP expanded set environment references in remote URLs and headers; unset references remained literal, and tested escaping forms did not preserve exact literals in both fields.",
        },
      ],
    },
  },
];
