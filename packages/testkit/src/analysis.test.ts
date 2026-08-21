import { describe, expect, it } from "vitest";
import { definePlugin, hook, block, replaceInput, preventStop } from "@hooknostic/sdk";
import type { HooknosticConfig } from "@hooknostic/sdk";
import { analyzeCapabilities, buildPluginIR } from "@hooknostic/core";
import type { AdapterRegistry, CapabilityProfile } from "@hooknostic/core";
import { makeFakeAdapter } from "./fake-adapter.js";

const richProfile: CapabilityProfile = {
  range: ">=1.0 <2",
  matrix: {
    "tool.before.observe": { level: "exact" },
    "tool.before.block": { level: "exact" },
    "tool.before.input.replace": { level: "exact" },
    "tool.before.context.add": { level: "emulated", rationale: "injected via output channel" },
    "session.start.observe": { level: "exact" },
    "session.start.context.add": { level: "exact" },
    "turn.stop.observe": { level: "exact" },
    "turn.stop.prevent": { level: "exact" },
  },
};

const poorProfile: CapabilityProfile = {
  range: ">=1.0 <2",
  matrix: {
    "tool.before.observe": { level: "exact" },
    "tool.before.block": { level: "approximate", rationale: "block is advisory only" },
    "session.start.observe": { level: "exact" },
    // no turn.stop at all, no input.replace, no context.add
  },
};

function registry(): AdapterRegistry {
  return {
    rich: makeFakeAdapter({ id: "rich", profiles: [richProfile] }),
    poor: makeFakeAdapter({ id: "poor", profiles: [poorProfile] }),
  };
}

function config(overrides?: Partial<HooknosticConfig>): HooknosticConfig {
  return {
    entry: "./src/hooks.ts",
    targets: {
      rich: { version: ">=1.0 <2", mode: "plugin", output: "./dist/rich" },
      poor: { version: ">=1.0 <2", mode: "plugin", output: "./dist/poor" },
    },
    ...overrides,
  };
}

function ir(hooks: Parameters<typeof definePlugin>[0]["hooks"]) {
  const result = buildPluginIR(definePlugin({ name: "test", hooks }));
  expect(result.diagnostics).toEqual([]);
  return result.ir!;
}

describe("analyzeCapabilities", () => {
  it("passes when every required capability is exact", () => {
    const analysis = analyzeCapabilities(
      ir([
        hook("tool.before", {
          id: "guard",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return block("no");
          },
        }),
      ]),
      config({ targets: { rich: { version: ">=1.0 <2", mode: "plugin", output: "./d" } } }),
      registry(),
    );
    expect(analysis.ok).toBe(true);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.targets.rich?.counts.exact).toBe(2); // observe + block
  });

  it("errors with HN201 when a required capability is unsupported", () => {
    const analysis = analyzeCapabilities(
      ir([
        hook("tool.before", {
          id: "rewrite",
          capabilities: { "tool.before.input.replace": "required" },
          async run() {
            return replaceInput({});
          },
        }),
      ]),
      config(),
      registry(),
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.targets.rich?.ok).toBe(true);
    expect(analysis.targets.poor?.ok).toBe(false);
    const hn201 = analysis.targets.poor?.diagnostics.find((d) => d.code === "HN201");
    expect(hn201).toMatchObject({
      severity: "error",
      hookId: "rewrite",
      capability: "tool.before.input.replace",
      target: "poor",
      support: "unsupported",
    });
    expect(hn201?.remediation).toContain("optional");
  });

  it("errors with HN202 when the event itself is unavailable", () => {
    const analysis = analyzeCapabilities(
      ir([
        hook("turn.stop", {
          id: "keep-going",
          capabilities: { "turn.stop.prevent": "required" },
          async run() {
            return preventStop();
          },
        }),
      ]),
      config(),
      registry(),
    );
    expect(analysis.targets.poor?.diagnostics.find((d) => d.code === "HN202")).toMatchObject({
      hookId: "keep-going",
      event: "turn.stop",
      capability: "turn.stop.observe",
      severity: "error",
    });
  });

  it("applies minimum-fidelity policy: approximate under default policy errors, per-target override warns", () => {
    const hooks = () => [
      hook("tool.before", {
        id: "guard",
        capabilities: { "tool.before.block": "required" },
        async run() {
          return block("no");
        },
      }),
    ];

    const strict = analyzeCapabilities(
      ir(hooks()),
      config({ targets: { poor: { version: ">=1.0 <2", mode: "plugin", output: "./d" } } }),
      registry(),
    );
    expect(strict.ok).toBe(false);
    expect(strict.targets.poor?.diagnostics.find((d) => d.code === "HN201")).toMatchObject({
      severity: "error",
      support: "approximate",
      rationale: "block is advisory only",
    });

    const relaxed = analyzeCapabilities(
      ir(hooks()),
      config({
        targets: {
          poor: {
            version: ">=1.0 <2",
            mode: "plugin",
            output: "./d",
            compatibility: { minimum: "approximate", onBelowMinimum: "warn" },
          },
        },
      }),
      registry(),
    );
    expect(relaxed.ok).toBe(true);
    // approximate meets the approximate minimum → degradation info, not a warn
    expect(relaxed.targets.poor?.diagnostics.find((d) => d.code === "HN101")).toMatchObject({
      severity: "info",
      support: "approximate",
    });
  });

  it("records optional misses as HN102 info without failing the build", () => {
    const analysis = analyzeCapabilities(
      ir([
        hook("tool.before", {
          id: "enhance",
          capabilities: { "tool.before.input.replace": "optional" },
          async run(_e, ctx) {
            if (ctx.capabilities.has("tool.before.input.replace")) return replaceInput({});
            return;
          },
        }),
      ]),
      config(),
      registry(),
    );
    expect(analysis.ok).toBe(true);
    expect(analysis.targets.poor?.diagnostics.find((d) => d.code === "HN102")).toMatchObject({
      severity: "info",
      capability: "tool.before.input.replace",
      requested: "optional",
    });
    expect(analysis.targets.rich?.diagnostics.find((d) => d.code === "HN102")).toBeUndefined();
  });

  it("records degraded (emulated) required capabilities as HN101 info under default policy", () => {
    const analysis = analyzeCapabilities(
      ir([
        hook("tool.before", {
          id: "annotate",
          capabilities: { "tool.before.context.add": "required" },
          async run() {},
        }),
      ]),
      config({ targets: { rich: { version: ">=1.0 <2", mode: "plugin", output: "./d" } } }),
      registry(),
    );
    expect(analysis.ok).toBe(true);
    expect(analysis.targets.rich?.diagnostics.find((d) => d.code === "HN101")).toMatchObject({
      severity: "info",
      support: "emulated",
      rationale: "injected via output channel",
    });
    expect(analysis.targets.rich?.counts.emulated).toBe(1);
  });

  it("skips intentionally excluded targets without diagnostics", () => {
    const analysis = analyzeCapabilities(
      ir([
        hook("turn.stop", {
          id: "rich-only",
          targets: { include: ["rich"] },
          capabilities: { "turn.stop.prevent": "required" },
          async run() {
            return preventStop();
          },
        }),
      ]),
      config(),
      registry(),
    );
    expect(analysis.ok).toBe(true);
    expect(analysis.targets.poor?.diagnostics).toEqual([]);
    expect(analysis.targets.poor?.resolutions).toEqual([]);
  });

  it("reports HN203 through analysis when the version range is outside adapter data", () => {
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "s", async run() {} })]),
      config({ targets: { rich: { version: ">=9.0", mode: "plugin", output: "./d" } } }),
      registry(),
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.targets.rich?.diagnostics[0]).toMatchObject({ code: "HN203" });
  });

  it("rejects CLI selection of targets absent from config", () => {
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "s", async run() {} })]),
      config(),
      registry(),
      ["rich", "surprise"],
    );
    expect(analysis.ok).toBe(false);
    expect(
      analysis.diagnostics.find((d) => d.code === "HN501" && d.target === "surprise"),
    ).toBeDefined();
  });

  it("reports HN501 when a configured target has no registered adapter", () => {
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "s", async run() {} })]),
      config({ targets: { mystery: { version: "1", mode: "plugin", output: "./d" } } }),
      registry(),
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.diagnostics[0]).toMatchObject({ code: "HN501", target: "mystery" });
  });

  it("rejects unsupported artifact modes during analysis", () => {
    const adapters = {
      localOnly: makeFakeAdapter({
        id: "localOnly",
        profiles: [richProfile],
        supportedModes: ["local"],
      }),
    };
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "s", async run() {} })]),
      config({
        targets: {
          localOnly: { version: ">=1.0 <2", mode: "plugin", output: "./dist" },
        },
      }),
      adapters,
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.targets.localOnly?.diagnostics[0]).toMatchObject({
      code: "HN204",
      severity: "error",
      target: "localOnly",
    });
  });

  it("rejects a directly supplied empty target selection", () => {
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "s", async run() {} })]),
      config(),
      registry(),
      [],
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.diagnostics[0]).toMatchObject({ code: "HN501", severity: "error" });
  });
});
