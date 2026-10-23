// Generate canonical fixtures (decode result minus `raw`) from the input
// fixtures using the adapter's own decoder — the same rule the opencode
// fixtures follow (canonical = decode minus raw). One-off, kept for
// reproducibility; run from the repo root inside vitest:
//   HKN_WRITE_CANONICAL=1 pnpm vitest run packages/adapter-pi/src/generate-canonical.test.ts
// Only inputs listed in the fixture directory's declined.json may fail to
// decode; any other decode error fails the run.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { applyCanonicalFixturePlan, planCanonicalFixtures } from "@hooknostic/testkit";

import { decodePi, PiDecodeError, type PiEnrichment } from "./decode.js";
import { piHarness } from "./harness.js";

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../fixtures/pi",
  piHarness.fixtureDir,
);

describe.skipIf(process.env["HKN_WRITE_CANONICAL"] !== "1")("canonical fixture generation", () => {
  it("writes canonical.json for every input.json", () => {
    const plan = planCanonicalFixtures({
      fixturesDir: FIXTURES_DIR,
      decode: (input, enrichment) =>
        decodePi(input, { targetId: "pi", harnessVersion: piHarness.referenceVersion }, enrichment as PiEnrichment),
      isDecline: (error) => error instanceof PiDecodeError,
    });
    applyCanonicalFixturePlan(FIXTURES_DIR, plan);
  });
});
