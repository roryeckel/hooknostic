import { describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MCP_SCHEMA, type AgentPluginMcpServer, type ProjectComponents } from "@hooknostic/agent-plugin";

import { projectComponents, projectIntegration } from "./project.js";

function source(mcpServers: Record<string, AgentPluginMcpServer>): ProjectComponents {
  return { origin: "direct", skills: [], mcp: { root: ".", config: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers } } };
}

describe("Codex project components", () => {
  it("uses Codex environment-backed fields for direct remote headers", async () => {
    const integration = await projectComponents(
      source({
        stripe: {
          type: "streamable-http",
          url: "https://stripe.invalid/mcp",
          headers: { Authorization: "Bearer ${STRIPE_TOKEN}" },
        },
        exa: {
          type: "streamable-http",
          url: "https://exa.invalid/mcp",
          headers: { "x-api-key": "${EXA_TOKEN}", "x-static": "present" },
        },
      }),
      ".",
      ".hooknostic/artifacts/codex",
      "hooknostic.config.ts",
      {},
    );
    const entries = Object.fromEntries(
      integration.entries.map((entry) => [String(entry.key[1]), entry.value]),
    ) as Record<string, Record<string, unknown>>;
    expect(entries["stripe"]).toEqual({ url: "https://stripe.invalid/mcp", bearer_token_env_var: "STRIPE_TOKEN" });
    expect(entries["exa"]).toEqual({
      url: "https://exa.invalid/mcp",
      http_headers: { "x-static": "present" },
      env_http_headers: { "x-api-key": "EXA_TOKEN" },
    });
  });

  it("preserves a prototype-key literal remote header", async () => {
    const headers = JSON.parse('{"__proto__":"present"}') as Record<string, string>;
    const integration = await projectComponents(
      source({
        remote: { type: "streamable-http", url: "https://example.invalid/mcp", headers },
      }),
      ".",
      "out",
      "hooknostic.config.ts",
      {},
    );
    const value = integration.entries[0]!.value as { http_headers: Record<string, string> };
    expect(Object.hasOwn(value.http_headers, "__proto__")).toBe(true);
    expect(value.http_headers["__proto__"]).toBe("present");
  });

  it.each([
    [
      { bad: { type: "streamable-http" as const, url: "https://example.invalid/${TOKEN}/mcp" } },
      "cannot represent environment references in a remote URL",
    ],
    [
      {
        bad: {
          type: "streamable-http" as const,
          url: "https://example.invalid/mcp",
          headers: { "x-key": "prefix-${TOKEN}" },
        },
      },
      "cannot mix an environment reference with literal text",
    ],
  ])("rejects a direct remote reference Codex cannot represent", async (servers, message) => {
    await expect(projectComponents(source(servers), ".", "out", "hooknostic.config.ts", {})).rejects.toThrow(message);
  });

  it("does not reinterpret Agent Plugin package headers", async () => {
    const packaged: ProjectComponents = {
      ...source({
        api: {
          type: "streamable-http",
          url: "https://example.invalid/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      }),
      origin: "package",
    };
    const integration = await projectComponents(packaged, ".", "out", "hooknostic.config.ts", {});
    expect(integration.entries[0]?.value).toEqual({
      url: "https://example.invalid/mcp",
      http_headers: { Authorization: "Bearer ${TOKEN}" },
    });
  });

  it("emits target-native startup timeouts", async () => {
    const integration = await projectComponents(
      source({ slow: { type: "stdio", command: "node" } }),
      ".",
      "out",
      "hooknostic.config.ts",
      { mcpStartupTimeoutMs: { slow: 60_001 } },
    );
    expect(integration.entries[0]?.value).toMatchObject({ startup_timeout_sec: 61 });
  });

  it("forwards every environment variable the stdio launcher expands", async () => {
    const integration = await projectComponents(
      source({
        tracker: {
          type: "stdio",
          command: "tracker-mcp",
          args: ["--host", "${TRACKER_HOST}", "${PLUGIN_ROOT}/data"],
          env: { TRACKER_TOKEN: "${TRACKER_TOKEN}", LITERAL: "plain", DATA: "${PLUGIN_DATA}" },
          cwd: "${TRACKER_WORKDIR}",
        },
        relative: { type: "stdio", command: "plain-mcp", cwd: "./${NOT_EXPANDED}" },
      }),
      ".",
      "out",
      "hooknostic.config.ts",
      { mcpProjectCwdServers: ["tracker"] },
    );
    const entries = Object.fromEntries(
      integration.entries.map((entry) => [String(entry.key[1]), entry.value]),
    ) as Record<string, Record<string, unknown>>;
    expect(entries["tracker"]?.["env_vars"]).toEqual(["TRACKER_HOST", "TRACKER_TOKEN", "TRACKER_WORKDIR"]);
    expect(entries["relative"]).not.toHaveProperty("env_vars");
  });

  it("uses an owned hook bootstrap instead of a cwd-relative runtime path", () => {
    const artifacts = [
      {
        path: ".codex/hooks.json",
        contents: JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "old", timeout: 1 }] }] } }),
      },
    ];
    const integration = projectIntegration(artifacts, ".hooknostic/artifacts/codex", ".agents/hooknostic/config.ts");
    const command = (integration.entries[0]?.value as { hooks: { command: string }[] }).hooks[0]!.command;
    expect(command).toContain("--input-type=module --eval");
    expect(command).not.toContain(".hooknostic/artifacts/codex/.codex/hooknostic/hooknostic.mjs");
  });
});
