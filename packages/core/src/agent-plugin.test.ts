import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  type AgentPluginPackage,
  type AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import { analyzeAgentPluginProjection, resolveAgentPluginProjection } from "./agent-plugin.js";
import type { HarnessAdapter, TargetSpec } from "./adapter.js";

const target: TargetSpec = { id: "test", version: ">=2.1 <3", delivery: "package", output: "dist" };
const projector: AgentPluginProjector<TargetSpec> = {
  namespace: "example.test",
  profiles: [
    {
      range: ">=2.1 <2.5",
      components: { "agent-plugin.skills": { level: "exact" } },
      source: {
        date: "2026-09-04",
        validatedOn: [{ version: "2.1.0", date: "2026-09-04", method: "captured", what: "first range" }],
      },
    },
    {
      range: ">=2.5 <3",
      components: { "agent-plugin.skills": { level: "approximate", rationale: "loses metadata" } },
      source: {
        date: "2026-09-04",
        validatedOn: [{ version: "2.5.0", date: "2026-09-04", method: "captured", what: "second range" }],
      },
    },
  ],
  async project() {
    return { files: [], issues: [], summary: { components: {}, omissions: [], copiedPaths: [] } };
  },
};

const manifestOnlyExtensionSource: AgentPluginPackage = {
  specVersion: "1.0.0",
  root: "/portable",
  manifest: {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
    name: "manifest-only-extension",
    extensions: { "example.test": { enabled: true } },
  },
  skills: [],
  files: [],
  contentDigest: "sha256:test",
};

const adapterWithProjector = { id: "test", agentPluginProjector: projector } as HarnessAdapter;

describe("resolveAgentPluginProjection", () => {
  it("takes the least capable support across every intersected profile", () => {
    const result = resolveAgentPluginProjection(target, projector);
    expect(result.diagnostics).toEqual([]);
    expect(result.matrix?.["agent-plugin.skills"]).toMatchObject({ level: "approximate" });
  });

  it("rejects version ranges not fully covered by projection evidence", () => {
    const result = resolveAgentPluginProjection({ ...target, version: ">=2 <4" }, projector);
    expect(result.matrix).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "HN203", severity: "error" }));
  });

  it("reports HN205 for a manifest-only client extension without projector support", () => {
    const result = analyzeAgentPluginProjection(
      manifestOnlyExtensionSource,
      adapterWithProjector,
      target,
      "error",
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN205",
        severity: "error",
        component: "agent-plugin.client-extension.files",
      }),
    );
  });
});
