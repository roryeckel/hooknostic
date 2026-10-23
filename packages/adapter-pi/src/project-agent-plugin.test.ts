import { describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginPackage,
} from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";

import { piHarness } from "./harness.js";
import { registrations } from "./mcp-test-helpers.js";
import { PI_LEGACY_RANGE } from "./profile.js";
import { piAgentPluginProjector } from "./project-agent-plugin.js";

const encoder = new TextEncoder();
const target = { id: "pi", delivery: "package" as const, version: piHarness.referenceVersion, output: "dist" };
const support = resolveAgentPluginProjection(target, piAgentPluginProjector).matrix!;

function source(): AgentPluginPackage {
  return {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: {
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
      name: "portable-tools",
      version: "1.2.3",
      description: "Portable tools",
      license: "MIT",
    },
    skills: [
      { name: "review", description: "Review", directory: "skills/review", manifestPath: "skills/review/SKILL.md" },
    ],
    mcp: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { echo: { type: "stdio", command: "node" } } },
    files: [
      "plugin.json",
      "mcp.json",
      "skills/review/SKILL.md",
      "skills/review/notes.md",
      "skills/broken/SKILL.md",
    ].map((path) => ({ path, contents: encoder.encode(path), mode: 0o644 })),
    directories: ["skills/review", "skills/broken", "empty"],
    contentDigest: "sha256:test",
  };
}

const project = (pkg: AgentPluginPackage, hooks: { path: string; contents: string }[] = []) =>
  piAgentPluginProjector.project(pkg, { target, hookArtifacts: hooks, support, onUnsupported: "warn" });

describe("Agent Plugin to pi package projection", () => {
  it("reports every unsupported agent component when warning policy permits the package", async () => {
    const plan = await piAgentPluginProjector.project(source(), {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
      agents: [
        {
          name: "reviewer",
          description: "Reviews code",
          instructions: "Review it.",
          mode: "all",
          native: { pi: {} },
          source: "/portable/agents/reviewer.md",
        },
      ],
      defaultAgent: "reviewer",
    });
    for (const component of ["agents.definition", "agents.primary", "agents.native", "agents.default"] as const) {
      expect(support[component]?.level, component).toBe("unsupported");
      expect(plan.summary.components[component], component).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
      expect(plan.summary.omissions).toContainEqual(expect.objectContaining({ component, reason: expect.any(String) }));
    }
  });

  it("declares accepted skills and hooks in one native manifest, preserving their files", async () => {
    const plan = await project(source(), [
      { path: "hooknostic.js", contents: "export default function () {}" },
      { path: "package.json", contents: "{}" },
    ]);
    const manifest = JSON.parse(plan.files.find((file) => file.path === "package.json")!.contents as string);
    expect(manifest).toMatchObject({
      name: "portable-tools",
      version: "1.2.3",
      description: "Portable tools",
      license: "MIT",
      type: "module",
      pi: { extensions: ["./hooknostic.js", "./hooknostic-mcp.js"], skills: ["./package/skills/review"] },
    });
    expect(plan.files.find((file) => file.path === "hooknostic.js")?.contents).toContain("export default");
    expect(plan.files.find((file) => file.path === "package/skills/review/SKILL.md")?.contents).toEqual(
      encoder.encode("skills/review/SKILL.md"),
    );
    expect(plan.files.some((file) => file.path === "package/skills/broken/SKILL.md")).toBe(false);
    expect(plan.directories).not.toContain("package/skills/broken");
    expect(plan.summary.copiedPaths).toContain("package/skills/review/SKILL.md");
    expect(plan.summary.copiedPaths).not.toContain("package/skills/broken/SKILL.md");
    expect(plan.summary.components["agent-plugin.skills"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(plan.issues).toEqual([]);
  });

  it("does not point a components-only package at a missing hook module", async () => {
    const plan = await project(source());
    const manifest = JSON.parse(plan.files.find((file) => file.path === "package.json")!.contents as string);
    expect(manifest.pi).toEqual({ extensions: ["./hooknostic-mcp.js"], skills: ["./package/skills/review"] });
    expect(plan.files.some((file) => file.path === "hooknostic.js")).toBe(false);
  });

  it("registers 1.x MCP servers through the launcher and reports runtime dependencies as unsupported", async () => {
    const plan = await piAgentPluginProjector.project(source(), {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
      runtimePackage: { manifest: "runtime-package.json", lockfile: "runtime-package-lock.json" },
    });
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(plan.summary.components["agent-plugin.runtime-package"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
    expect(plan.summary.omissions.map((omission) => omission.component)).toEqual(["agent-plugin.runtime-package"]);
    const extension = plan.files.find((file) => file.path === "hooknostic-mcp.js")!.contents as string;
    expect(registrations(extension)).toEqual([{ name: "echo", type: "stdio", index: 0 }]);
    expect(extension).toContain('resolve(here, "hooknostic-runtime/mcp-launcher.mjs")');
    expect(
      JSON.parse(plan.files.find((file) => file.path === "hooknostic-runtime/mcp-servers.json")!.contents as string),
    ).toEqual({
      plugin: "portable-tools",
      servers: [{ name: "echo", command: "node" }],
    });
    expect(plan.files.some((file) => file.path === "hooknostic-runtime/mcp-launcher.mjs")).toBe(true);
    expect(plan.issues).toEqual([]);
  });

  it("declares no MCP resources for a 0.84 target, which has no native MCP channel", async () => {
    const legacy = { ...target, version: PI_LEGACY_RANGE };
    const plan = await piAgentPluginProjector.project(source(), {
      target: legacy,
      hookArtifacts: [],
      support: resolveAgentPluginProjection(legacy, piAgentPluginProjector).matrix!,
      onUnsupported: "warn",
    });
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
    expect(plan.summary.omissions).toEqual([
      { component: "agent-plugin.mcp.stdio", name: "echo", reason: expect.stringContaining("no native MCP channel") },
    ]);
    const manifest = JSON.parse(plan.files.find((file) => file.path === "package.json")!.contents as string);
    expect(manifest.pi).toEqual({ skills: ["./package/skills/review"] });
    expect(
      plan.files.some((file) => file.path.startsWith("hooknostic-runtime/") || file.path === "hooknostic-mcp.js"),
    ).toBe(false);
  });

  it("omits SSE on 1.x and reports a server pi would reject inside a supported transport", async () => {
    const pkg = source();
    pkg.mcp = {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        events: { type: "sse", url: "https://example.test/sse" },
        "bad name": { type: "stdio", command: "node" },
        remote: { type: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "Bearer $X" } },
      },
    };
    const plan = await project(pkg);
    expect(plan.summary.components["agent-plugin.mcp.sse"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
    expect(plan.summary.components["agent-plugin.mcp.streamable-http"]).toEqual({
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
    // Core reports the unsupported SSE cell; the rejected name has no other diagnostic.
    expect(plan.issues).toEqual([
      expect.objectContaining({ severity: "warn", component: "agent-plugin.mcp.stdio", path: "mcp.json#bad name" }),
    ]);
    // A remote server alone needs no launcher.
    expect(plan.files.some((file) => file.path.startsWith("hooknostic-runtime/"))).toBe(false);
    expect(registrations(plan.files.find((file) => file.path === "hooknostic-mcp.js")!.contents as string)).toEqual([
      { name: "remote", type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer $X" } },
    ]);
  });

  it("preserves the author's module boundary and rejects materializer collisions", async () => {
    const pkg = source();
    pkg.files.push({ path: "package.json", contents: encoder.encode('{"type":"module"}'), mode: 0o644 });
    const plan = await piAgentPluginProjector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
      materializedTrees: [
        {
          provider: "test",
          into: "skills/review",
          files: [{ path: "SKILL.md", contents: encoder.encode("bad"), mode: 0o644 }],
        },
      ],
    });
    expect(plan.files.filter((file) => file.path === "package/package.json")).toHaveLength(1);
    expect(
      plan.issues.some((issue) => issue.severity === "error" && issue.path === "package/skills/review/SKILL.md"),
    ).toBe(true);
  });
});
