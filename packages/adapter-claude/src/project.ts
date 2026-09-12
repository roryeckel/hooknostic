import { claudeHarness } from "./harness.js";
import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { projectSkillFiles, projectMcpLauncher } from "@hooknostic/core";
import type { GeneratedArtifact, ProjectIntegration, ProjectEntry } from "@hooknostic/core";
export function projectIntegration(artifacts: readonly GeneratedArtifact[], output: string): ProjectIntegration {
  const manifest = artifacts.find(a => a.path === "hooks/hooks.json");
  const entries: ProjectEntry[] = [];
  if (manifest) {
    const document = JSON.parse(typeof manifest.contents === "string" ? manifest.contents : new TextDecoder().decode(manifest.contents)) as { hooks: Record<string, { hooks: { command: string; args?: string[]; timeout: number }[] }[]> };
    for (const [event, groups] of Object.entries(document.hooks)) {
      for (const group of groups) for (const command of group.hooks) {
        command.command = "node";
        command.args = [`${"${CLAUDE_PROJECT_DIR}"}/${output}/runtime/hooknostic.mjs`];
      }
      if (groups.length !== 1) throw new Error("expected one compiled dispatcher group per event");
      entries.push({ path: ".claude/settings.json", key: ["hooks", event], kind: "array", value: groups[0] });
    }
  }
  return { files: [], entries, guidance: ["Restart Claude Code after synchronization; project hook execution has not been observed by this command."] };
}

export async function projectComponents(source: ProjectComponents, root: string, output: string): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".claude/skills");
  if (source.mcp) {
    const launcher = await projectMcpLauncher(source, root, output);
    result.files.push(...launcher.files);
    let index = 0;
    for (const [name, server] of Object.entries(source.mcp.config.mcpServers)) {
      const component = `agent-plugin.mcp.${server.type}` as const;
      const hasEnvironmentReference = server.type !== "stdio" && (
        /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(server.url) ||
        Object.values(server.headers ?? {}).some(value => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value))
      );
      if (source.origin === "package" && hasEnvironmentReference) {
        const reason = `MCP server ${name} requires literal environment references, but Claude project MCP expands set references`;
        (result.omissions ??= []).push({ component, name, reason });
        continue;
      }
      const value = server.type === "stdio"
        ? { command: "node", args: [`./${output}/mcp-launcher.mjs`, String(index++)] }
        : { type: server.type === "streamable-http" ? "http" : "sse", url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) };
      result.entries.push({ path: ".mcp.json", key: ["mcpServers", name], kind: "property", value });
    }
    result.guidance.push("Launch Claude Code from the project root for project MCP commands; approve servers through the harness.");
  }
  return result;
}

export const projectComponentProfiles: readonly AgentPluginProjectionProfile[] = [{
  range: claudeHarness.recommendedRange,
  components: {
    "agent-plugin.skills": { level: "exact" },
    "agent-plugin.mcp.stdio": { level: "emulated", rationale: "A project launcher resolves portable paths and variables at runtime; dependencies are supplied by the project." },
    "agent-plugin.mcp.streamable-http": { level: "exact" },
    "agent-plugin.mcp.sse": { level: "exact" },
  },
  source: {
    date: "2026-09-12",
    validatedOn: [{ version: "2.1.268", date: "2026-09-11", method: "live-probe", artifact: ".capture/project-integration", what: "Repository-local hook and skill playback plus loopback MCP transports; activation boundaries are recorded in the capture notes." }, { version: "2.1.268", date: "2026-09-12", method: "live-probe", artifact: ".capture/claude-project-mcp-environment", what: "Project MCP expanded set environment references in remote URLs and headers; unset references remained literal, and tested escaping forms did not preserve exact literals in both fields." }],
  },
}];
