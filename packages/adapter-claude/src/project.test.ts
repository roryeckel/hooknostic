import { describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MCP_SCHEMA, type ProjectComponents } from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";

import { claudeHarness } from "./harness.js";
import { projectComponentProfiles, projectComponents } from "./project.js";

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
            headers: { Authorization: "Bearer ${HOOKNOSTIC_PROJECT_TOKEN:-anonymous}" },
          },
          literal: { type: "streamable-http", url: "https://example.invalid/mcp" },
          // Launched from the opaque document, which Claude never expands.
          local: { type: "stdio", command: "node", args: ["${HOOKNOSTIC_PROJECT_TOKEN}"] },
        },
      },
    },
  };
}

// Resolved from the project profiles rather than restated, so the gate these
// tests exercise is the declaration the build actually hands the integrator.
const support = resolveAgentPluginProjection(
  { id: "claude", version: claudeHarness.recommendedRange, delivery: "project", output: "." },
  { profiles: projectComponentProfiles },
).matrix!;

describe("Claude project components", () => {
  it("keeps native expansion for direct remote declarations", async () => {
    const integration = await projectComponents(source("direct"), ".", ".hooknostic/artifacts/claude", "", {
      support,
    });
    expect(integration.entries.map((entry) => entry.key.at(-1))).toEqual(["referenced", "literal", "local"]);
    expect(integration.omissions).toBeUndefined();
    expect(integration.deviations).toBeUndefined();
  });

  it("emits package remote declarations Claude would expand and reports the deviation", async () => {
    const integration = await projectComponents(source("package"), ".", ".hooknostic/artifacts/claude", "", {
      support,
    });
    expect(integration.entries.map((entry) => entry.key.at(-1))).toEqual(["referenced", "literal", "local"]);
    expect(integration.omissions).toBeUndefined();
    expect(integration.deviations).toEqual([
      {
        id: "mcp-environment-expansion",
        component: "agent-plugin.mcp.streamable-http",
        name: "referenced",
        path: "mcp.json#referenced",
        reason: expect.stringContaining("${HOOKNOSTIC_PROJECT_TOKEN}, ${HOOKNOSTIC_PROJECT_TOKEN:-anonymous}"),
      },
    ]);
  });

  // A version range whose profile no longer declares the deviation stops
  // reporting it; the check is the declaration, not the adapter's own opinion.
  it("reports nothing for a range whose profile does not declare the deviation", async () => {
    const undeclared = Object.fromEntries(
      Object.entries(support).map(([component, cell]) => [component, { level: cell.level }]),
    );
    const integration = await projectComponents(source("package"), ".", ".hooknostic/artifacts/claude", "", {
      support: undeclared,
    });
    expect(integration.deviations).toBeUndefined();
  });
});
