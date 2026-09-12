import { describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MCP_SCHEMA, type ProjectComponents } from "@hooknostic/agent-plugin";

import { projectComponents } from "./project.js";

function source(origin: ProjectComponents["origin"]): ProjectComponents {
  return {
    origin,
    skills: [],
    mcp: {
      root: ".",
      config: {
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          referenced: {
            type: "streamable-http",
            url: "https://example.invalid/${HOOKNOSTIC_PROJECT_TOKEN}/mcp",
            headers: { Authorization: "Bearer ${HOOKNOSTIC_PROJECT_TOKEN}" },
          },
          literal: { type: "streamable-http", url: "https://example.invalid/mcp" },
        },
      },
    },
  };
}

describe("Claude project components", () => {
  it("keeps native expansion for direct remote declarations", async () => {
    const integration = await projectComponents(source("direct"), ".", ".hooknostic/artifacts/claude");
    expect(integration.entries.map((entry) => entry.key.at(-1))).toEqual(["referenced", "literal"]);
    expect(integration.omissions).toBeUndefined();
  });

  it("omits package remote declarations whose references Claude would expand", async () => {
    const integration = await projectComponents(source("package"), ".", ".hooknostic/artifacts/claude");
    expect(integration.entries.map((entry) => entry.key.at(-1))).toEqual(["literal"]);
    expect(integration.omissions).toEqual([
      {
        component: "agent-plugin.mcp.streamable-http",
        name: "referenced",
        reason: expect.stringContaining("literal environment references"),
      },
    ]);
  });
});
