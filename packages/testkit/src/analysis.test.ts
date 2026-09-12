import { describe, expect, it } from "vitest";

import type { AdapterRegistry, CapabilityProfile } from "@hooknostic/core";
import { analyzeCapabilities, buildPluginIR } from "@hooknostic/core";
import type { HooknosticConfig } from "@hooknostic/sdk";
import { block, definePlugin, hook, preventStop, replaceInput } from "@hooknostic/sdk";

import { makeFakeAdapter } from "./fake-adapter.js";

// Synthetic profiles need a syntactically valid source; provenance is
// meaningless for a fake harness, so one shared stub keeps the noise down.
const SRC: CapabilityProfile["source"] = {
  date: "2026-01-01",
  validatedOn: [{ version: "1.0.0", date: "2026-01-01", method: "doc-derived", what: "synthetic" }],
};

const richProfile: CapabilityProfile = {
  range: ">=1.0 <2",
  source: SRC,
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
  source: SRC,
  matrix: {
    "tool.before.observe": { level: "exact" },
    "tool.before.block": { level: "approximate", rationale: "block is advisory only" },
    "session.start.observe": { level: "exact" },
    // no turn.stop at all, no input.replace, no context.add
  },
};

/**
 * Observation of the event itself is degraded — the shape a real harness takes
 * when its stop signal can fire twice for one turn. The hook author cannot
 * declare `<event>.observe`, so this is only reachable through the implicit
 * requirement the analyzer synthesizes.
 */
const hazyProfile: CapabilityProfile = {
  range: ">=1.0 <2",
  source: SRC,
  matrix: {
    "tool.before.observe": { level: "exact" },
    "turn.stop.observe": { level: "approximate", rationale: "an aborted turn signals twice" },
    "turn.stop.prevent": { level: "exact" },
  },
};

function registry(): AdapterRegistry {
  return {
    rich: makeFakeAdapter({ id: "rich", profiles: [richProfile] }),
    poor: makeFakeAdapter({ id: "poor", profiles: [poorProfile] }),
    hazy: makeFakeAdapter({ id: "hazy", profiles: [hazyProfile] }),
  };
}

function config(
  overrides?: Partial<Pick<HooknosticConfig, "targets" | "compatibility" | "runtime">>,
): HooknosticConfig {
  return {
    entry: "./src/hooks.ts",
    targets: {
      rich: { version: ">=1.0 <2", delivery: "package", output: "./dist/rich" },
      poor: { version: ">=1.0 <2", delivery: "package", output: "./dist/poor" },
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
      config({ targets: { rich: { version: ">=1.0 <2", delivery: "package", output: "./d" } } }),
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
      config({ targets: { poor: { version: ">=1.0 <2", delivery: "package", output: "./d" } } }),
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
            delivery: "package",
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

    // A declared capability CAN be made optional, but only helps alongside a
    // feature-detect -- an optional capability below the floor is reported
    // unavailable too. The remediation has to say both halves or it reads like
    // declaring it is the whole fix.
    const remediation = strict.targets.poor?.diagnostics.find((d) => d.code === "HN201")?.remediation;
    expect(remediation).toContain('targets.poor.compatibility: { minimum: "approximate" }');
    expect(remediation).toContain("branch on `ctx.capabilities.has()`");
  });

  it("tells you how to fix a degraded event observation, which you cannot declare", () => {
    // The implicit `<event>.observe` requirement is the one an author never
    // wrote and cannot make optional -- DeclarableCapability excludes it by
    // construction. This branch previously shared its remediation with the
    // genuinely-unsupported case and so advised four fixes, of which the first
    // was impossible here and the rest amounted to dropping the harness. A real
    // consumer hit it writing a turn.stop hook for OpenCode, which is the most
    // likely second hook anyone writes.
    const stopHook = () => [
      hook("turn.stop", {
        id: "verify",
        capabilities: { "turn.stop.prevent": "required" },
        async run() {
          return preventStop("not yet");
        },
      }),
    ];
    const hazyTarget = { hazy: { version: ">=1.0 <2", delivery: "package" as const, output: "./d" } };

    const strict = analyzeCapabilities(ir(stopHook()), config({ targets: hazyTarget }), registry());
    expect(strict.ok).toBe(false);
    const hn201 = strict.targets.hazy?.diagnostics.find((d) => d.code === "HN201");
    expect(hn201).toMatchObject({
      severity: "error",
      capability: "turn.stop.observe",
      support: "approximate",
      rationale: "an aborted turn signals twice",
    });
    // Substring matching is too loose here -- "minimum" also matches
    // `onBelowMinimum` and "optional" matches `optionalUnavailable`, so both
    // assertions could pass on the wrong string. Pin the actual advice: the
    // level observed, the target it belongs under, and no suggestion to declare
    // a capability the author cannot declare.
    expect(hn201?.remediation).toContain('targets.hazy.compatibility: { minimum: "approximate" }');
    expect(hn201?.remediation).not.toMatch(/declare the capability optional/);

    // And taking the advice has to actually build.
    const relaxed = analyzeCapabilities(
      ir(stopHook()),
      config({
        targets: {
          hazy: {
            version: ">=1.0 <2",
            delivery: "package",
            output: "./d",
            compatibility: { minimum: "approximate" },
          },
        },
      }),
      registry(),
    );
    expect(relaxed.ok).toBe(true);
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
      config({ targets: { rich: { version: ">=1.0 <2", delivery: "package", output: "./d" } } }),
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
      config({ targets: { rich: { version: ">=9.0", delivery: "package", output: "./d" } } }),
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
    expect(analysis.diagnostics.find((d) => d.code === "HN501" && d.target === "surprise")).toBeDefined();
  });

  it("reports HN501 when a configured target has no registered adapter", () => {
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "s", async run() {} })]),
      config({ targets: { mystery: { version: "1", delivery: "package", output: "./d" } } }),
      registry(),
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.diagnostics[0]).toMatchObject({ code: "HN501", target: "mystery" });
  });

  it("does not treat inherited registry properties as adapters", () => {
    const targets = Object.fromEntries([
      ["toString", { version: "1", delivery: "package", output: "./d" }],
    ]) as HooknosticConfig["targets"];
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "s", async run() {} })]),
      config({ targets }),
      registry(),
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.diagnostics[0]).toMatchObject({ code: "HN501", target: "toString" });
  });

  it("rejects unsupported deliveries during analysis", () => {
    const adapters = {
      localOnly: makeFakeAdapter({
        id: "localOnly",
        profiles: [richProfile],
        supportedDeliveries: ["project"],
      }),
    };
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "s", async run() {} })]),
      config({
        targets: {
          localOnly: { version: ">=1.0 <2", delivery: "package", output: "./dist" },
        },
      }),
      adapters,
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.targets.localOnly?.diagnostics[0]).toMatchObject({
      code: "HN204",
      severity: "error",
      target: "localOnly",
      message: 'target "localOnly" delivery "package" is unsupported by adapter "localOnly".',
      remediation: "use one of the supported deliveries: project.",
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

describe("hook target scopes", () => {
  it("accepts scopes that name configured targets", () => {
    const analysis = analyzeCapabilities(
      ir([
        hook("session.start", { id: "a", targets: { include: ["rich"] }, async run() {} }),
        hook("session.start", { id: "b", targets: { exclude: ["poor"] }, async run() {} }),
      ]),
      config(),
      registry(),
    );
    expect(analysis.ok).toBe(true);
    expect(analysis.diagnostics).toEqual([]);
  });

  it("rejects include/exclude names that are not configured targets, even under --target narrowing", () => {
    const analysis = analyzeCapabilities(
      ir([
        hook("session.start", { id: "typo-include", targets: { include: ["rcih"] }, async run() {} }),
        hook("session.start", { id: "typo-exclude", targets: { exclude: ["por"] }, async run() {} }),
      ]),
      config(),
      registry(),
      ["rich"],
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.diagnostics.filter((d) => d.code === "HN501")).toEqual([
      expect.objectContaining({ hookId: "typo-include", target: "rcih", severity: "error" }),
      expect.objectContaining({ hookId: "typo-exclude", target: "por", severity: "error" }),
    ]);
    expect(analysis.diagnostics[0]?.remediation).toContain("rich, poor");
  });

  it("rejects an empty include list because the hook could never apply", () => {
    const analysis = analyzeCapabilities(
      ir([hook("session.start", { id: "dead", targets: { include: [] }, async run() {} })]),
      config(),
      registry(),
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.diagnostics[0]).toMatchObject({ code: "HN501", hookId: "dead", severity: "error" });
  });
});
