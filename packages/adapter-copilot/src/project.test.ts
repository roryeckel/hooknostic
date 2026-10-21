import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MCP_SCHEMA, type ProjectComponents } from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";

import { projectComponentProfiles, projectComponents, projectIntegration } from "./project.js";
import { COPILOT_SKILL_POLICY_VALIDATION } from "./skill-policy.js";

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
  { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "project", output: "." },
  { profiles: projectComponentProfiles },
).matrix!;

describe("Copilot project components", () => {
  it("rates the project invocation policy exact", () => {
    expect(support["agent-plugin.skills.invocation-policy"]).toMatchObject({ level: "exact" });
  });

  it("keeps a Copilot build older than the interactive capture unsupported", () => {
    const older = resolveAgentPluginProjection(
      {
        id: "copilot",
        version: `>=1.0 <${COPILOT_SKILL_POLICY_VALIDATION.version}`,
        delivery: "project",
        output: ".",
      },
      { profiles: projectComponentProfiles },
    ).matrix!;
    expect(older["agent-plugin.skills.invocation-policy"]).toMatchObject({ level: "unsupported" });
  });

  it("returns no hook file when a components-only project compiles none", () => {
    const integration = projectIntegration([], "out");
    expect(integration.files).toEqual([]);
    expect(integration.entries).toEqual([]);
    expect(integration.guidance.join(" ")).toMatch(/project root/);
  });

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

  it("reports executable modes on a skill it discovers in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-native-skill-"));
    try {
      const encoder = new TextEncoder();
      const native: ProjectComponents = {
        origin: "direct",
        skills: [
          {
            name: "native",
            source: join(dir, ".github", "skills", "native"),
            files: [
              {
                path: "SKILL.md",
                contents: encoder.encode("---\nname: native\ndescription: Native skill.\n---\nRun run.sh.\n"),
                mode: 0o644,
              },
              { path: "run.sh", contents: encoder.encode("#!/bin/sh\n"), mode: 0o755 },
            ],
          },
        ],
      };
      const integration = await projectComponents(native, dir, "out", "", { support });
      expect(integration.files.map((file) => file.path)).not.toContain(".agents/skills/native/SKILL.md");
      expect(integration.unappliedModes).toEqual([{ skill: "native", path: "run.sh" }]);
      expect(integration.degradations).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recognizes a native discovery directory reached through a junction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-native-link-"));
    try {
      await mkdir(join(dir, "shared", "probe"), { recursive: true });
      await mkdir(join(dir, ".github"), { recursive: true });
      symlinkSync(join(dir, "shared"), join(dir, ".github", "skills"), "junction");
      const encoder = new TextEncoder();
      const native: ProjectComponents = {
        origin: "direct",
        skills: [
          {
            name: "probe",
            source: join(dir, "shared", "probe"),
            files: [
              {
                path: "SKILL.md",
                contents: encoder.encode("---\nname: probe\ndescription: Linked skill.\n---\nRun run.sh.\n"),
                mode: 0o644,
              },
              { path: "run.sh", contents: encoder.encode("#!/bin/sh\n"), mode: 0o755 },
            ],
          },
        ],
      };
      const integration = await projectComponents(native, dir, "out", "", { support });
      expect(integration.files.map((file) => file.path)).not.toContain(".agents/skills/probe/SKILL.md");
      expect(integration.unappliedModes).toEqual([{ skill: "probe", path: "run.sh" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recognizes an individual skill reached through a junction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-skill-link-"));
    try {
      await mkdir(join(dir, "shared", "linkprobe"), { recursive: true });
      await mkdir(join(dir, ".github", "skills"), { recursive: true });
      symlinkSync(join(dir, "shared", "linkprobe"), join(dir, ".github", "skills", "linkprobe"), "junction");
      const encoder = new TextEncoder();
      const native: ProjectComponents = {
        origin: "direct",
        skills: [
          {
            name: "linkprobe",
            source: join(dir, "shared", "linkprobe"),
            files: [
              {
                path: "SKILL.md",
                contents: encoder.encode("---\nname: linkprobe\ndescription: Linked child.\n---\n"),
                mode: 0o644,
              },
            ],
          },
        ],
      };
      const integration = await projectComponents(native, dir, "out", "", { support });
      expect(integration.files.map((file) => file.path)).not.toContain(".agents/skills/linkprobe/SKILL.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("relinquishes ownership when a configured source becomes the destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-destination-"));
    try {
      await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
      await mkdir(join(dir, ".claude"), { recursive: true });
      symlinkSync(join(dir, ".agents", "skills"), join(dir, ".claude", "skills"), "junction");
      const source: ProjectComponents = {
        origin: "direct",
        skills: [
          {
            name: "review",
            source: join(dir, ".agents", "skills", "review"),
            files: [
              {
                path: "SKILL.md",
                contents: new TextEncoder().encode("---\nname: review\ndescription: Self source.\n---\n"),
                mode: 0o644,
              },
            ],
          },
        ],
      };
      const integration = await projectComponents(source, dir, "out", "", { support });
      expect(integration.files.map((file) => file.path)).not.toContain(".agents/skills/review/SKILL.md");
      expect(integration.relinquishPrefixes).toContain(".agents/skills/review");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retires a stale generated copy when the source moves to a native directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-relocated-"));
    try {
      await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
      await mkdir(join(dir, ".github", "skills", "review"), { recursive: true });
      const source: ProjectComponents = {
        origin: "direct",
        skills: [
          {
            name: "review",
            source: join(dir, ".github", "skills", "review"),
            files: [
              {
                path: "SKILL.md",
                contents: new TextEncoder().encode("---\nname: review\ndescription: Relocated.\n---\n"),
                mode: 0o644,
              },
            ],
          },
        ],
      };
      const integration = await projectComponents(source, dir, "out", "", { support });
      expect(integration.files.map((file) => file.path)).not.toContain(".agents/skills/review/SKILL.md");
      // No relinquishment: the older generated copy stays owned and is removed.
      expect(integration.relinquishPrefixes ?? []).not.toContain(".agents/skills/review");
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
