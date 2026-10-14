import { describe, expect, it } from "vitest";

import { matchesDeclaredRanges } from "./check-version-literals.mjs";

describe("documented version ranges", () => {
  const split = new Set([">=1.2 <2 <1.3.4", ">=1.2 <2 >=1.3.4"]);

  it.each([">=1.2 <2", ">=1.2.0 <2.0.0-0"])("retains the complete declared profile union %s", (range) => {
    expect(matchesDeclaredRanges(range, split)).toBe(true);
  });

  it.each([">=1.1 <2", ">=1.2 <3", ">=1.3 <2", ">=1.3.5 <2", ">=invalid"])(
    "rejects undeclared coverage or arbitrary new boundaries %s",
    (range) => expect(matchesDeclaredRanges(range, split)).toBe(false),
  );

  it("rejects a union with a gap between declared profiles", () => {
    expect(matchesDeclaredRanges(">=1.2 <2", new Set([">=1.2 <1.3", ">=1.4 <2"]))).toBe(false);
  });

  it("retains each authored profile range", () => {
    for (const range of split) expect(matchesDeclaredRanges(range, split)).toBe(true);
  });
});
