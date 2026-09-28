import { describe, expect, it } from "vitest";

import { codeModeReferenceVersion } from "./verify-code-mode.mjs";

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
});
