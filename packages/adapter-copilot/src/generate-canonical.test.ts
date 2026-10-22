// Regenerate canonical fixtures (decode result minus `raw`) from the input
// fixtures using the adapter's own decoder. Run from the repo root:
//   HKN_WRITE_CANONICAL=1 pnpm exec vitest run packages/adapter-copilot/src/generate-canonical.test.ts
// Only inputs listed in the fixture directory's declined.json may fail to
// decode.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { applyCanonicalFixturePlan, planCanonicalFixtures } from "@hooknostic/testkit";

import { CopilotDecodeError, decodeCopilot } from "./decode.js";
import { copilotHarness } from "./harness.js";

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../fixtures/copilot",
  copilotHarness.fixtureDir,
);

describe.skipIf(process.env["HKN_WRITE_CANONICAL"] !== "1")("canonical fixture generation", () => {
  it("writes canonical.json for every input.json", () => {
    const plan = planCanonicalFixtures({
      fixturesDir: FIXTURES_DIR,
      decode: (input, enrichment) => {
        const hint = (enrichment as { nativeEvent?: string } | undefined)?.nativeEvent;
        return decodeCopilot(input, { targetId: "copilot", harnessVersion: copilotHarness.referenceVersion }, hint);
      },
      isDecline: (error) => error instanceof CopilotDecodeError,
    });
    applyCanonicalFixturePlan(FIXTURES_DIR, plan);
  });
});
