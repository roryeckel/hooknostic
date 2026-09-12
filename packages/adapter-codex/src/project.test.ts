import { describe, expect, it } from "vitest";
import { AGENT_PLUGIN_MCP_SCHEMA, type AgentPluginMcpServer, type ProjectComponents } from "@hooknostic/agent-plugin";
import { projectComponents } from "./project.js";

function source(mcpServers: Record<string, AgentPluginMcpServer>): ProjectComponents {
  return { origin: "direct", skills: [], mcp: { root: ".", config: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers } } };
}

describe("Codex project components", () => {
  it("uses Codex environment-backed fields for direct remote headers", async () => {
    const integration = await projectComponents(source({
      stripe: { type: "streamable-http", url: "https://stripe.invalid/mcp", headers: { Authorization: "Bearer ${STRIPE_TOKEN}" } },
      exa: { type: "streamable-http", url: "https://exa.invalid/mcp", headers: { "x-api-key": "${EXA_TOKEN}", "x-static": "present" } },
    }), ".", ".hooknostic/artifacts/codex", "hooknostic.config.ts");
    const entries = Object.fromEntries(integration.entries.map(entry => [String(entry.key[1]), entry.value])) as Record<string, Record<string, unknown>>;
    expect(entries["stripe"]).toEqual({ url: "https://stripe.invalid/mcp", bearer_token_env_var: "STRIPE_TOKEN" });
    expect(entries["exa"]).toEqual({
      url: "https://exa.invalid/mcp",
      http_headers: { "x-static": "present" },
      env_http_headers: { "x-api-key": "EXA_TOKEN" },
    });
  });

  it.each([
    [{ bad: { type: "streamable-http" as const, url: "https://example.invalid/${TOKEN}/mcp" } }, "cannot represent environment references in a remote URL"],
    [{ bad: { type: "streamable-http" as const, url: "https://example.invalid/mcp", headers: { "x-key": "prefix-${TOKEN}" } } }, "cannot mix an environment reference with literal text"],
  ])("rejects a direct remote reference Codex cannot represent", async (servers, message) => {
    await expect(projectComponents(source(servers), ".", "out", "hooknostic.config.ts")).rejects.toThrow(message);
  });

  it("does not reinterpret Agent Plugin package headers", async () => {
    const packaged: ProjectComponents = {
      ...source({ api: { type: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } }),
      origin: "package",
    };
    const integration = await projectComponents(packaged, ".", "out", "hooknostic.config.ts");
    expect(integration.entries[0]?.value).toEqual({ url: "https://example.invalid/mcp", http_headers: { Authorization: "Bearer ${TOKEN}" } });
  });
});
