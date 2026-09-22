import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

  // Claude never sees a package's stdio text under project delivery: no
  // variable in a project .mcp.json names a package root, so the launcher holds
  // it, and it reaches the server literally (`.capture/claude-project-mcp-environment`).
  it("keeps a package's stdio text out of Claude's declaration and literal at the server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-claude-project-"));
    try {
      const packaged = source("package");
      packaged.mcp = {
        root: dir,
        config: {
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            local: {
              type: "stdio",
              command: process.execPath,
              args: [
                "-e",
                "process.stdout.write(JSON.stringify({ args: process.argv.slice(1), declared: process.env.DECLARED }))",
                "${HOOKNOSTIC_PROJECT_TOKEN}",
              ],
              env: { DECLARED: "${HOOKNOSTIC_PROJECT_TOKEN:-fallback}" },
            },
          },
        },
      };
      const integration = await projectComponents(packaged, dir, "out", "", { support });
      expect(integration.entries).toEqual([
        expect.objectContaining({
          key: ["mcpServers", "local"],
          value: { command: "node", args: ["./out/mcp-launcher.mjs", "0"] },
        }),
      ]);
      expect(integration.deviations).toBeUndefined();
      for (const file of integration.files) {
        await mkdir(dirname(join(dir, file.path)), { recursive: true });
        await writeFile(join(dir, file.path), file.contents);
      }
      const run = spawnSync(process.execPath, [join(dir, "out/mcp-launcher.mjs"), "0"], {
        cwd: dir,
        env: { ...process.env, HOOKNOSTIC_PROJECT_TOKEN: "ambient" },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        args: ["${HOOKNOSTIC_PROJECT_TOKEN}"],
        declared: "${HOOKNOSTIC_PROJECT_TOKEN:-fallback}",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
