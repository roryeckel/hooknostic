import { describe, expect, it } from "vitest";

import { copilotEnvironmentReferences } from "./mcp-expansion.js";

describe("Copilot MCP environment references", () => {
  it("treats the aliases in a stdio command as a deviation, because 1.0.101 expands them there", () => {
    // Agent Plugins 1.0 §9.2 expands only in args, env and cwd; the capture
    // launched ${PLUGIN_ROOT}/node-copy.exe as a command.
    expect(copilotEnvironmentReferences({ type: "stdio", command: "${PLUGIN_ROOT}/node-copy.exe" })).toEqual([
      "PLUGIN_ROOT",
    ]);
  });

  it("excludes the aliases in args, env and cwd, where the specification requires expansion", () => {
    expect(
      copilotEnvironmentReferences({
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/server.mjs", "${HOME}/x"],
        env: { DATA: "${PLUGIN_DATA}/data", TOKEN: "${GH_TOKEN}" },
        cwd: "${PLUGIN_DATA}",
      }),
    ).toEqual(["GH_TOKEN", "HOME"]);
  });

  it("reports simple ambient references in remote header values only", () => {
    expect(
      copilotEnvironmentReferences({
        type: "streamable-http",
        url: "https://example.invalid/${USERPROFILE}/mcp",
        headers: { "X-Data": "${PLUGIN_DATA}", "X-Token": "${GH_TOKEN}", "X-Fallback": "${HOME:-fallback}" },
      }),
    ).toEqual(["GH_TOKEN"]);
    expect(copilotEnvironmentReferences({ type: "sse", url: "https://example.invalid/mcp" })).toEqual([]);
  });
});
