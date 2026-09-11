import { codexHarness } from "./harness.js";
import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { ProjectComponents } from "@hooknostic/agent-plugin";
import { translateMcp } from "./project-agent-plugin.js";
import { projectSkillFiles, projectMcpLauncher, projectMcpBootstrap } from "@hooknostic/core";
import type { GeneratedArtifact, ProjectIntegration, ProjectEntry } from "@hooknostic/core";
export function projectIntegration(artifacts: readonly GeneratedArtifact[], output: string): ProjectIntegration {
  if (/[$`]/.test(output)) throw new Error("Codex project output paths containing shell expansion characters are unsupported");
  const manifest = artifacts.find(a => a.path === ".codex/hooks.json");
  const entries: ProjectEntry[] = [];
  if (manifest) {
    const document = JSON.parse(typeof manifest.contents === "string" ? manifest.contents : new TextDecoder().decode(manifest.contents)) as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };
    for (const [event, groups] of Object.entries(document.hooks)) {
      for (const group of groups) for (const command of group.hooks) command.command = `node "${output}/.codex/hooknostic/hooknostic.mjs"`;
      if (groups.length !== 1) throw new Error("expected one compiled dispatcher group per event");
      entries.push({ path: ".codex/hooks.json", key: ["hooks", event], kind: "array", value: groups[0] });
    }
  }
  return { files: [], entries, guidance: ["Open Codex from the project root and restart after synchronization. Review project and hook trust in Codex; execution has not been observed by this command."] };
}

export async function projectComponents(source: ProjectComponents, root: string, output: string, config: string): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".agents/skills");
  const translated = translateMcp(source.mcp ? { mcp: source.mcp.config } : {});
  if (translated.omitted.length) throw new Error(translated.omitted.map(item => `${item.name}: ${item.reason}`).join("; "));
  result.files.push(...(await projectMcpLauncher(source, root, output, translated.launcherServers)).files);
  for (const [name, server] of Object.entries(translated.servers)) {
    const value = "command" in server ? {
      command: "node", args: projectMcpBootstrap(output, config, Number(server.args![1])),
    } : server;
    result.entries.push({ path: ".codex/config.toml", key: ["mcp_servers", name], kind: "property", format: "toml", value });
  }
  if (result.entries.length) result.guidance.push("Codex reads project MCP only in trusted projects. Restart after synchronization. Same-named servers merge across home, project, nested, and command-line configuration; resolve conflicting declarations manually. Hooknostic does not inspect or change personal trust or connect to MCP servers during diagnostics.");
  return result;
}

export const projectComponentProfiles: readonly AgentPluginProjectionProfile[] = [{
  range: codexHarness.recommendedRange,
  components: {
    "agent-plugin.skills": { level: "exact" },
    "agent-plugin.mcp.stdio": { level: "emulated", rationale: "An owned repository-locating Node bootstrap launches the portable server from its declared source root. Node must be on PATH; project trust remains a human prerequisite." },
    "agent-plugin.mcp.streamable-http": { level: "exact", rationale: "Native project TOML url and http_headers preserve remote declarations." },
    "agent-plugin.mcp.sse": { level: "unsupported", rationale: "Legacy SSE project transport is not established; Codex reads url declarations as Streamable HTTP." },
  },
  source: {
    date: "2026-09-11",
    validatedOn: [{ version: "0.153.2", date: "2026-09-11", method: "live-probe", artifact: ".capture/codex-project-mcp", what: "Production project reconciliation and launcher playback with stdio and loopback Streamable HTTP; trust, cwd, config layering and diagnostic network behavior recorded." }, { version: "0.153.2", date: "2026-09-11", method: "live-probe", artifact: ".capture/project-integration", what: "Repository-local hook and skill playback; activation boundaries are recorded in the capture notes." }],
  },
}];
