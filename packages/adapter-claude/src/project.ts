import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { contentsText } from "@hooknostic/agent-plugin";
import type { GeneratedArtifact, ProjectEntry, ProjectIntegration } from "@hooknostic/core";
import { projectMcpLauncher, projectSkillFiles } from "@hooknostic/core";

import { claudeHarness } from "./harness.js";
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

export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".claude/skills");
  if (source.mcp) {
    const launcher = await projectMcpLauncher(source, root, output);
    result.files.push(...launcher.files);
    let index = 0;
    for (const [name, server] of Object.entries(source.mcp.config.mcpServers)) {
      const component = `agent-plugin.mcp.${server.type}` as const;
      const hasEnvironmentReference =
        server.type !== "stdio" &&
        (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(server.url) ||
          Object.values(server.headers ?? {}).some((value) => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)));
      if (source.origin === "package" && hasEnvironmentReference) {
        const reason = `MCP server ${name} requires literal environment references, but Claude project MCP expands set references`;
        (result.omissions ??= []).push({ component, name, reason });
        continue;
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
        rationale:
          "Project integration writes .mcp.json, a skills tree and settings Claude reads from the project. The com.anthropic.claude-code namespace is an overlay on an installed plugin's root, and project delivery installs nothing, so there is no surface at project scope that would read it. Deliver the package to reach it.",
      },
      "agent-plugin.runtime-package": {
        level: "unsupported",
        rationale:
          "The locked install this component depends on is Claude's own, run in its plugin cache against an installed marketplace copy (ADR-0012). Project delivery installs nothing, so a manifest and lockfile written beside the projected files would be read by nothing and no node_modules would appear. Bundle a Node component's dependencies, or deliver the package, where Claude supports this exactly.",
      },
    },
    source: {
      date: "2026-09-12",
      validatedOn: [
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
