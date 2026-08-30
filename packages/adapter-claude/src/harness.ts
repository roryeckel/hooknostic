import type { HarnessMetadata } from "@hooknostic/core";

/**
 * Claude Code version metadata -- the single source the repository's version
 * literals derive from. Profiles record what was validated; this records what
 * is recommended and what the tests exercise. Contract-audited: see
 * `describeAdapterContract` obligations in `@hooknostic/testkit`.
 */
export const claudeHarness: HarnessMetadata = {
  displayName: "Claude Code",
  recommendedRange: ">=2.1 <3",
  fixtureDir: "2.1",
  referenceVersion: "2.1.238",
};
