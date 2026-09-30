import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { contentsText, SKILL_REFERENCE_UNEXPANDED } from "@hooknostic/agent-plugin";
import type { GeneratedArtifact, ProjectComponentOptions, ProjectEntry, ProjectIntegration } from "@hooknostic/core";
import { projectMcpLauncher, projectSkillFiles } from "@hooknostic/core";

import { claudeHarness } from "./harness.js";
import {
  claudeExpandedReferences,
  declaresEnvironmentExpansion,
  ENVIRONMENT_EXPANSION_DEVIATION,
  environmentExpansionReason,
} from "./mcp-expansion.js";
import { CLAUDE_PROJECT_SKILL_TEXT } from "./skill-text.js";
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
  _config?: string,
  options: ProjectComponentOptions = {},
): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".claude/skills", {
    target: CLAUDE_PROJECT_SKILL_TEXT,
    harness: "Claude Code",
  });
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
      "agent-plugin.skills": {
        level: "exact",
        rationale:
          "Copied into .claude/skills as authored, except that ${SKILL_DIR} in a SKILL.md body becomes ${CLAUDE_SKILL_DIR}, which Claude expands to the skill's absolute directory in a project skill too (ADR-0028). A skill already at its destination is discovered in place and not rewritten.",
        degradations: [
          {
            id: SKILL_REFERENCE_UNEXPANDED,
            summary:
              "A project skill that holds ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${PLUGIN_ROOT} or ${PLUGIN_DATA} anywhere, ${SKILL_DIR} in its frontmatter, or ${SKILL_DIR} at all when discovered in place, reaches the model with that text as written: outside a plugin Claude expands only ${CLAUDE_SKILL_DIR} and ${CLAUDE_SESSION_ID} in skill text.",
            evidence: ".capture/skill-directory",
          },
        ],
      },
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
    },
    source: {
      date: "2026-09-12",
      validatedOn: [
        {
          version: "2.1.285",
          date: "2026-09-30",
          method: "live-probe",
          artifact: ".capture/skill-directory",
          what: "A project skill under .claude/skills, loaded through the Skill tool, reached the model with ${CLAUDE_SKILL_DIR} (the skill's absolute directory, forward slashes) and ${CLAUDE_SESSION_ID} expanded, and ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${SKILL_DIR}, ${PLUGIN_ROOT}, ${PLUGIN_DATA} and ${HOME} as written.",
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
