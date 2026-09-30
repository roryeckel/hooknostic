import { describe, expect, it } from "vitest";

import type { HooknosticConfig } from "@hooknostic/sdk";
import { definePlugin, hook } from "@hooknostic/sdk";

import { opencodeV1Adapter, opencodeV2Harness } from "../../adapter-opencode/src/index.js";
import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { analyzeCapabilities } from "./analysis.js";
import { buildPluginIR } from "./ir.js";

// Which real targets can honour a hook scoped to one agent (ADR-0029). The
// levels come from each adapter's captured evidence; this pins that the
// analysis turns them into a build decision, with the reason attached.
const { ir } = buildPluginIR(
  definePlugin({
    name: "scoped",
    hooks: [hook("tool.before", { id: "reviewer-guard", agents: { include: ["reviewer"] }, async run() {} })],
  }),
);

function analyze(id: string, version: string, v1 = false) {
  const registry = defaultAdapterRegistry();
  if (v1) registry.opencode = opencodeV1Adapter();
  const config = {
    targets: { [id]: { version, delivery: "project", output: `.hooknostic/artifacts/${id}` } },
  } as unknown as HooknosticConfig;
  return analyzeCapabilities(ir!, config, registry).diagnostics.filter(
    (diagnostic) => diagnostic.capability === "tool.before.agent.identity",
  );
}

describe("agent-scoped hooks across targets", () => {
  it.each([
    ["claude", ">=2.1 <3"],
    ["codex", ">=0.156.1 <1"],
    ["opencode", opencodeV2Harness.recommendedRange],
  ])("builds for %s %s, where events inside a subagent name it", (id, version) => {
    expect(analyze(id, version)).toEqual([]);
  });

  it("refuses Codex below 0.156.1, where no hook fired inside a subagent", () => {
    expect(analyze("codex", ">=0.148 <1")).toEqual([
      expect.objectContaining({
        code: "HN201",
        severity: "error",
        rationale: expect.stringContaining("no hook fired inside a spawned subagent"),
      }),
    ]);
  });

  it("refuses OpenCode v1, whose tool events name no agent", () => {
    expect(analyze("opencode", ">=1.18 <2", true)).toEqual([
      expect.objectContaining({
        code: "HN201",
        severity: "error",
        rationale: expect.stringContaining("carry only tool, sessionID and callID"),
      }),
    ]);
  });
});
