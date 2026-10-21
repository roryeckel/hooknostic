import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MCP_SCHEMA, type ProjectComponents } from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";

import { copilotHarness } from "./harness.js";
import { projectComponentProfiles, projectComponents } from "./project.js";

function source(origin: ProjectComponents["origin"], root: string): ProjectComponents {
  const encoder = new TextEncoder();
  return {
    origin,
    skills: [
      {
        name: "probe",
        source: join(root, "skills", "probe"),
        files: [
          {
            path: "SKILL.md",
            contents: encoder.encode(
              "---\nname: probe\ndescription: Probe skill.\n---\n\nRun ${SKILL_DIR}/probe.sh, then report ${PLUGIN_ROOT}.\n",
            ),
            mode: 0o644,
          },
        ],
      },
    ],
    mcp: {
      root,
      config: {
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          referenced: {
            type: "streamable-http",
            url: "https://example.invalid/${HOOKNOSTIC_PROJECT_TOKEN}/mcp",
            headers: { Authorization: "Bearer ${HOOKNOSTIC_PROJECT_TOKEN}" },
          },
          local: { type: "stdio", command: "node", args: ["${HOOKNOSTIC_PROJECT_TOKEN}"] },
          events: { type: "sse", url: "https://example.invalid/sse" },
        },
      },
    },
  };
}

const support = resolveAgentPluginProjection(
  { id: "copilot", version: copilotHarness.recommendedRange, delivery: "project", output: "." },
  { profiles: projectComponentProfiles },
).matrix!;

describe("Copilot project components", () => {
  it("copies skills to .agents/skills and rewrites the skill directory token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-project-"));
    try {
      const integration = await projectComponents(source("direct", dir), dir, "out", "", { support });
      const skill = integration.files.find((file) => file.path === ".agents/skills/probe/SKILL.md");
      expect(skill).toBeDefined();
      const text = typeof skill!.contents === "string" ? skill!.contents : new TextDecoder().decode(skill!.contents);
      expect(text).toContain("<absolute path of the directory containing this SKILL.md>/probe.sh");
      expect(text).toContain("${PLUGIN_ROOT}");
      expect(integration.degradations?.map((entry) => entry.id).sort()).toEqual([
        "skill-directory-model-substitution",
        "skill-reference-unexpanded",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes native project MCP declarations, with stdio behind the shared launcher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-project-"));
    try {
      const integration = await projectComponents(source("direct", dir), dir, "out", "", { support });
      expect(integration.entries).toEqual([
        expect.objectContaining({
          path: ".github/mcp.json",
          key: ["mcpServers", "local"],
          value: { type: "stdio", command: "node", args: ["./out/mcp-launcher.mjs", "0"] },
        }),
        expect.objectContaining({
          path: ".github/mcp.json",
          key: ["mcpServers", "referenced"],
          value: {
            type: "http",
            url: "https://example.invalid/${HOOKNOSTIC_PROJECT_TOKEN}/mcp",
            headers: { Authorization: "Bearer ${HOOKNOSTIC_PROJECT_TOKEN}" },
          },
        }),
        expect.objectContaining({
          path: ".github/mcp.json",
          key: ["mcpServers", "events"],
          value: { type: "sse", url: "https://example.invalid/sse" },
        }),
      ]);
      expect(integration.files.map((file) => file.path)).toContain("out/mcp-launcher.mjs");
      // A direct source's references are the project's to resolve.
      expect(integration.deviations).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a package's ambient header reference as the deviation its profile declares", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-project-"));
    try {
      const integration = await projectComponents(source("package", dir), dir, "out", "", { support });
      expect(integration.deviations).toEqual([
        {
          id: "mcp-environment-expansion",
          component: "agent-plugin.mcp.streamable-http",
          name: "referenced",
          path: "mcp.json#referenced",
          reason: expect.stringContaining("${HOOKNOSTIC_PROJECT_TOKEN}"),
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops reporting the deviation when the resolved profile does not declare it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-project-"));
    try {
      const undeclared = Object.fromEntries(
        Object.entries(support).map(([component, cell]) => [component, { level: cell.level }]),
      );
      const integration = await projectComponents(source("package", dir), dir, "out", "", { support: undeclared });
      expect(integration.deviations).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
