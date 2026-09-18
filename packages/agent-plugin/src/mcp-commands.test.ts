import { describe, expect, it } from "vitest";

import { mcpPathCommands, mcpServerCommands } from "./mcp-commands.js";
import type { AgentPluginMcpConfig } from "./types.js";
import { AGENT_PLUGIN_MCP_SCHEMA } from "./types.js";

const config = (mcpServers: AgentPluginMcpConfig["mcpServers"]): AgentPluginMcpConfig => ({
  $schema: AGENT_PLUGIN_MCP_SCHEMA,
  mcpServers,
});

describe("mcpServerCommands", () => {
  it("classifies commands only by how the declared command is resolved", () => {
    const entries = mcpServerCommands(
      config({
        first: { type: "stdio", command: "alpha", args: ["serve"] },
        second: { type: "stdio", command: "beta", args: ["run"] },
      }),
    );

    expect(entries.map((entry) => [entry.server, entry.command, entry.resolution])).toEqual([
      ["first", "alpha", "path-lookup"],
      ["second", "beta", "path-lookup"],
    ]);
  });

  it("reports that a contained command is shipped by the package", () => {
    expect(mcpServerCommands(config({ compiled: { type: "stdio", command: "./bin/server" } }))).toEqual([
      { server: "compiled", command: "./bin/server", resolution: "package" },
    ]);
  });

  it("reports nothing for a remote server, which is never spawned", () => {
    expect(mcpServerCommands(config({ remote: { type: "streamable-http", url: "https://example.test/mcp" } }))).toEqual(
      [],
    );
    expect(mcpServerCommands(undefined)).toEqual([]);
  });

  it("collapses one command shared by several servers, in a stable order", () => {
    const entries = mcpServerCommands(
      config({
        second: { type: "stdio", command: "zeta", args: ["b"] },
        first: { type: "stdio", command: "zeta", args: ["a"] },
        shipped: { type: "stdio", command: "./bin/server" },
        third: { type: "stdio", command: "alpha", args: ["run"] },
      }),
    );

    expect(mcpPathCommands(entries)).toEqual(["alpha", "zeta"]);
  });
});
