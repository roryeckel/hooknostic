import { describe, expect, it } from "vitest";
import type { CapabilityProfile } from "./adapter.js";
import { resolveCapabilityMatrix } from "./matrix.js";

const older: CapabilityProfile = {
  range: ">=1.0 <1.5",
  matrix: {
    "tool.before.observe": { level: "exact" },
    "tool.before.block": { level: "emulated", rationale: "older mechanism" },
    // no input.replace in older versions
  },
};

const newer: CapabilityProfile = {
  range: ">=1.5 <2",
  matrix: {
    "tool.before.observe": { level: "exact" },
    "tool.before.block": { level: "exact" },
    "tool.before.input.replace": { level: "exact" },
  },
};

describe("resolveCapabilityMatrix", () => {
  it("selects the single intersecting profile", () => {
    const result = resolveCapabilityMatrix("fake", [older, newer], ">=1.6 <1.9");
    expect(result.diagnostics).toEqual([]);
    expect(result.profilesUsed).toEqual([newer]);
    expect(result.matrix?.["tool.before.block"]?.level).toBe("exact");
  });

  it("resolves overlapping ranges to the least-capable guaranteed intersection", () => {
    const result = resolveCapabilityMatrix("fake", [older, newer], ">=1.0");
    expect(result.diagnostics).toEqual([]);
    expect(result.profilesUsed).toHaveLength(2);
    // block: emulated in older, exact in newer → emulated is the guarantee
    expect(result.matrix?.["tool.before.block"]?.level).toBe("emulated");
    // input.replace: missing (unsupported) in older → not guaranteed at all
    expect(result.matrix?.["tool.before.input.replace"]).toBeUndefined();
    expect(result.matrix?.["tool.before.observe"]?.level).toBe("exact");
  });

  it("reports HN203 when the range is outside all validated data", () => {
    const result = resolveCapabilityMatrix("fake", [older, newer], ">=3.0");
    expect(result.matrix).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({
      code: "HN203",
      severity: "error",
      target: "fake",
    });
  });

  it("reports HN203 for an invalid semver range", () => {
    const result = resolveCapabilityMatrix("fake", [older], "not-a-range");
    expect(result.diagnostics[0]).toMatchObject({ code: "HN203", severity: "error" });
  });
});
