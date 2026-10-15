import { describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginPackage,
} from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";

import { piAgentPluginProjector } from "./project-agent-plugin.js";

const encoder = new TextEncoder();
const target = { id: "pi", delivery: "package" as const, version: "0.84.4", output: "dist" };
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
      pi: { extensions: ["./hooknostic.js"], skills: ["./package/skills/review"] },
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
    expect(manifest.pi).toEqual({ skills: ["./package/skills/review"] });
    expect(plan.files.some((file) => file.path === "hooknostic.js")).toBe(false);
  });

  it("reports MCP and runtime dependencies as unsupported instead of declaring dead resources", async () => {
    const pkg = source();
    const plan = await piAgentPluginProjector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
      runtimePackage: { manifest: "runtime-package.json", lockfile: "runtime-package-lock.json" },
    });
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
    expect(plan.summary.components["agent-plugin.runtime-package"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
    expect(plan.summary.omissions.map((omission) => omission.component)).toEqual([
      "agent-plugin.mcp.stdio",
      "agent-plugin.runtime-package",
    ]);
    const manifest = JSON.parse(plan.files.find((file) => file.path === "package.json")!.contents as string);
    expect(manifest.pi).not.toHaveProperty("mcp");
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
