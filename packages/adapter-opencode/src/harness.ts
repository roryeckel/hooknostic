import type { HarnessMetadata } from "@hooknostic/core";

/**
 * OpenCode version metadata -- the single source the repository's version
 * literals derive from. Profiles record what was validated; this records what
 * is recommended and what the tests exercise. Contract-audited: see
 * `describeAdapterContract` obligations in `@hooknostic/testkit`.
 */
export const opencodeHarness: HarnessMetadata = {
  displayName: "OpenCode",
  recommendedRange: ">=1.18 <2",
  fixtureDir: "1.18",
  referenceVersion: "1.18.18",
};
