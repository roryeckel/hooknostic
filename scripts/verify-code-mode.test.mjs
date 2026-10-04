import { describe, expect, it } from "vitest";

import { CODE_MODE_GATE_TESTS, codeModeReferenceVersion, requireGateCoverage } from "./verify-code-mode.mjs";

function report(results) {
  return { testResults: [{ assertionResults: results.map(([title, status]) => ({ title, status })) }] };
}

function adapterWith(validatedOn) {
  return {
    id: "codex",
    supportedHarnessVersions: () => [">=1 <3"],
    capabilities: () => ({ profilesUsed: [{ source: { validatedOn } }] }),
  };
}

describe("Code Mode verification gate", () => {
  it("uses the Code Mode capture rather than any other record", () => {
    const adapter = adapterWith([
      { artifact: ".capture/codex-plugin-hooks", method: "live-probe", version: "1.0.0" },
      { artifact: ".capture/codex-code-mode", method: "live-probe", version: "2.1.0" },
      { artifact: ".capture/codex-code-mode", method: "captured", version: "2.0.0" },
    ]);
    expect(codeModeReferenceVersion(adapter)).toBe("2.0.0");
  });

  it("refuses to run without the capture instead of choosing a version", () => {
    expect(() =>
      codeModeReferenceVersion(
        adapterWith([{ artifact: ".capture/codex-code-mode", method: "live-probe", version: "2.1.0" }]),
      ),
    ).toThrow("missing Code Mode capture");
  });

  it("passes only when every gate test ran and passed", () => {
    expect(() => requireGateCoverage(report(CODE_MODE_GATE_TESTS.map((title) => [title, "passed"])))).not.toThrow();
  });

  it("fails when a drive was renamed away, even though the version check passed", () => {
    const [versionCheck, ...drives] = CODE_MODE_GATE_TESTS;
    const renamed = report([
      [versionCheck, "passed"],
      [`${drives[0]} (renamed)`, "passed"],
      [drives[1], "passed"],
    ]);
    expect(() => requireGateCoverage(renamed)).toThrow("(absent)");
  });

  it("fails when a drive skipped", () => {
    const skipped = report(CODE_MODE_GATE_TESTS.map((title, index) => [title, index === 2 ? "skipped" : "passed"]));
    expect(() => requireGateCoverage(skipped)).toThrow("(skipped)");
  });
});
