import { describe, expect, it } from "vitest";

import { packageReferenceVersion, requirePackageSupport } from "./verify-marketplaces.mjs";

describe("marketplace verification gate", () => {
  it("refuses an unavailable package route instead of reporting a passing scenario", () => {
    expect(() => requirePackageSupport("unsupported")).toThrow("package-capable");
    expect(() => requirePackageSupport(undefined)).toThrow("package-capable");
    expect(() => requirePackageSupport("emulated")).not.toThrow();
  });

  it("uses package evidence rather than the older project reference", () => {
    const adapter = {
      id: "codex",
      harness: { referenceVersion: "1.0.0" },
      agentPluginProjector: {
        profiles: [
          {
            source: {
              validatedOn: [{ artifact: ".capture/codex-plugin-hooks", method: "live-probe", version: "2.0.0" }],
            },
          },
        ],
      },
    };
    expect(packageReferenceVersion(adapter)).toBe("2.0.0");
    expect(() => packageReferenceVersion({ id: "codex" })).toThrow("missing marketplace");
  });
});
