import type { HarnessMetadata } from "@hooknostic/core";

/**
 * GitHub Copilot CLI version metadata -- the single source the repository's
 * version literals derive from (ADR-0008). The reference build is the one every
 * fixture was captured on and every native claim was probed against.
 */
export const copilotHarness: HarnessMetadata = {
  displayName: "GitHub Copilot CLI",
  recommendedRange: ">=1.0 <2",
  fixtureDir: "1.0",
  referenceVersion: "1.0.101",
};
