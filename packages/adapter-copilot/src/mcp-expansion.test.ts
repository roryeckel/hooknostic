import { describe, expect, it } from "vitest";

import type { AgentPluginMcpServer } from "@hooknostic/agent-plugin";

import { copilotEnvironmentReferences } from "./mcp-expansion.js";

// Each row is a declaration a 1.0.101 capture exercised (.capture/copilot,
// plugin-mcp-stdio-fallback and the transport probes) and the references it
// showed Copilot changing, against what Agent Plugins 1.0 permits.
const CASES: readonly [string, AgentPluginMcpServer, readonly string[]][] = [
  [
    "a braced alias in a stdio command, which the specification excludes",
    { type: "stdio", command: "${PLUGIN_ROOT}/node-copy.exe" },
    ["${PLUGIN_ROOT}"],
  ],
  ["a bare alias in a stdio command", { type: "stdio", command: "$PLUGIN_ROOT/node-copy.exe" }, ["$PLUGIN_ROOT"]],
  [
    "the exact aliases in args, env and cwd, where the specification expands them",
    {
      type: "stdio",
      command: "node",
      args: ["${PLUGIN_ROOT}/server.mjs"],
      env: { DATA: "${PLUGIN_DATA}/data" },
      cwd: "${PLUGIN_DATA}",
    },
    [],
  ],
  [
    "ambient braced, fallback and bare references in a stdio command, args, env and cwd",
    {
      type: "stdio",
      command: "${NODE:-node}",
      args: ["${HOME}/x", "${MISSING:-fallback-arg}", "x$TOKEN-y"],
      env: { TOKEN: "${GH_TOKEN}", BARE: "$GH_TOKEN" },
      cwd: "${PLUGIN_ROOT}/$SUB",
    },
    ["$GH_TOKEN", "$SUB", "$TOKEN", "${GH_TOKEN}", "${HOME}", "${MISSING:-fallback-arg}", "${NODE:-node}"],
  ],
  [
    "bare and fallback alias spellings in stdio args and env, which are not the specification's placeholders",
    {
      type: "stdio",
      command: "node",
      args: ["${PLUGIN_ROOT:-fallback-root}"],
      env: { ROOT: "$PLUGIN_ROOT", DATA: "$PLUGIN_DATA" },
    },
    ["$PLUGIN_DATA", "$PLUGIN_ROOT", "${PLUGIN_ROOT:-fallback-root}"],
  ],
  [
    "%NAME%, which stayed literal",
    { type: "stdio", command: "node", args: ["%GH_TOKEN%"], env: { TOKEN: "%GH_TOKEN%" } },
    [],
  ],
  [
    "ambient braced, fallback and bare references in a remote url and header values",
    {
      type: "streamable-http",
      url: "https://example.invalid/${USERPROFILE}/mcp?fallback=${HOME:-fallback}&bare=$TOKEN",
      headers: { "X-Token": "${GH_TOKEN}", "X-Fallback": "${HOME:-fallback}", "X-Bare": "$TOKEN" },
    },
    ["$TOKEN", "${GH_TOKEN}", "${HOME:-fallback}", "${USERPROFILE}"],
  ],
  [
    "exact and bare aliases in remote header values, which stayed literal",
    {
      type: "sse",
      url: "https://example.invalid/mcp",
      headers: { "X-Root": "${PLUGIN_ROOT}", "X-Data": "${PLUGIN_DATA}", "X-Bare": "$PLUGIN_ROOT" },
    },
    [],
  ],
  [
    "an alias with a fallback in a remote header value, which took its fallback",
    { type: "sse", url: "https://example.invalid/mcp", headers: { "X-Root": "${PLUGIN_ROOT:-fallback-root}" } },
    ["${PLUGIN_ROOT:-fallback-root}"],
  ],
  [
    "a reference in a remote header name, which was never expanded",
    { type: "streamable-http", url: "https://example.invalid/mcp", headers: { "X-Name-$TOKEN": "value" } },
    [],
  ],
];

describe("Copilot MCP environment references", () => {
  it.each(CASES)("%s", (_, server, expected) => {
    expect(copilotEnvironmentReferences(server)).toEqual(expected);
  });
});
