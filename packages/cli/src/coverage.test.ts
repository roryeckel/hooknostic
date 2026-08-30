/**
 * Every shipped adapter must pass the same contract.
 *
 * The obligations themselves live in `@hooknostic/testkit` rather than here, so
 * that an adapter published from another repository is held to them too. This
 * file is only the registration point: adding a fourth adapter means adding a
 * row, and forgetting to is the one failure this arrangement still cannot catch.
 */
import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@hooknostic/core";
import { claudeAdapter } from "@hooknostic/adapter-claude";
import { codexAdapter } from "@hooknostic/adapter-codex";
import { opencodeAdapter } from "@hooknostic/adapter-opencode";
import { describeAdapterContract, fixturePath } from "@hooknostic/testkit";
import { defaultAdapterRegistry } from "./registry.js";

const SUBJECTS: { adapter: HarnessAdapter; fixtureDir: [string, string]; version: string }[] = [
  { adapter: claudeAdapter(), fixtureDir: ["claude", "2.1"], version: ">=2.1 <3" },
  { adapter: codexAdapter(), fixtureDir: ["codex", "0.148"], version: ">=0.148 <1" },
  { adapter: opencodeAdapter(), fixtureDir: ["opencode", "1.18"], version: ">=1.18 <2" },
];

for (const { adapter, fixtureDir, version } of SUBJECTS) {
  describeAdapterContract(adapter, {
    fixturesDir: fixturePath(fixtureDir[0], fixtureDir[1], "."),
    version,
  });
}

describe("shipped adapter registration", () => {
  it("holds every adapter in the default registry to the contract", () => {
    // The gap this closes: a new adapter added to the registry but not to
    // SUBJECTS builds and ships while its fixture coverage, rationales and
    // provenance are audited by nothing, with the suite green.
    expect(SUBJECTS.map((s) => s.adapter.id).sort()).toEqual(
      Object.keys(defaultAdapterRegistry()).sort(),
    );
  });
});
