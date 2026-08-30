import type { HarnessMetadata } from "@hooknostic/core";

/**
 * Codex CLI version metadata -- the single source the repository's version
 * literals derive from. Profiles record what was validated; this records what
 * is recommended and what the tests exercise. Contract-audited: see
 * `describeAdapterContract` obligations in `@hooknostic/testkit`.
 */
export const codexHarness: HarnessMetadata = {
  displayName: "Codex CLI",
  recommendedRange: ">=0.148 <1",
  fixtureDir: "0.148",
  referenceVersion: "0.148.0",
};
