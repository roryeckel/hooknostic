import { describe, expect, it } from "vitest";

import { mcpPrerequisites, mcpRequiredCommands } from "./prerequisites.js";
import type { AgentPluginMcpConfig } from "./types.js";
import { AGENT_PLUGIN_MCP_SCHEMA } from "./types.js";

const config = (mcpServers: AgentPluginMcpConfig["mcpServers"]): AgentPluginMcpConfig => ({
  $schema: AGENT_PLUGIN_MCP_SCHEMA,
  mcpServers,
});

describe("mcpPrerequisites", () => {
  it("treats every interpreter alike, whatever language it runs", () => {
    const entries = mcpPrerequisites(
      config({
        python: { type: "stdio", command: "uvx", args: ["mcp-server-git"] },
        container: { type: "stdio", command: "docker", args: ["run", "-i", "--rm", "x/y"] },
        node: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] },
        dotnet: { type: "stdio", command: "dotnet", args: ["tool", "run", "mcp"] },
      }),
    );

    // The point of the derivation: `node` gets no privileged treatment, and no
    // list of blessed runners decides which of these is "supported".
    expect(entries.map((entry) => [entry.server, entry.requires])).toEqual([
      ["container", ["docker"]],
      ["dotnet", ["dotnet"]],
      ["node", ["node"]],
      ["python", ["uvx"]],
    ]);
    expect(entries.every((entry) => !entry.contained)).toBe(true);
  });

  it("asks nothing of the host for a command the package ships", () => {
    const entries = mcpPrerequisites(config({ compiled: { type: "stdio", command: "./bin/server" } }));

    expect(entries).toEqual([{ server: "compiled", command: "./bin/server", contained: true, requires: [] }]);
  });

  it("reports nothing for a remote server, which is never spawned", () => {
    expect(mcpPrerequisites(config({ remote: { type: "streamable-http", url: "https://example.test/mcp" } }))).toEqual(
      [],
    );
    expect(mcpPrerequisites(undefined)).toEqual([]);
  });

  it("collapses one command shared by several servers, in a stable order", () => {
    const entries = mcpPrerequisites(
      config({
        second: { type: "stdio", command: "uvx", args: ["b"] },
        first: { type: "stdio", command: "uvx", args: ["a"] },
        shipped: { type: "stdio", command: "./bin/server" },
        third: { type: "stdio", command: "docker", args: ["run", "c"] },
      }),
    );

    // A contained command contributes nothing: there is no PATH lookup to probe.
    expect(mcpRequiredCommands(entries)).toEqual(["docker", "uvx"]);
  });
});
