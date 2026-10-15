import type { HarnessMetadata } from "@hooknostic/core";

/**
 * pi version metadata -- the single source the repository's version literals
 * derive from (ADR-0008). pi is distributed as
 * `@earendil-works/pi-coding-agent` (the former `@mariozechner/pi-coding-agent`
 * is deprecated upstream); the adapter id stays "pi".
 */
export const piHarness: HarnessMetadata = {
  displayName: "pi",
  recommendedRange: ">=0.84 <1",
  fixtureDir: "0.84",
  referenceVersion: "0.84.4",
};
