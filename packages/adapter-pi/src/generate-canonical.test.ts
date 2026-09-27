// Generate canonical fixtures (decode result minus `raw`) from the input
// fixtures using the adapter's own decoder — the same rule the opencode
// fixtures follow (canonical = decode minus raw). One-off, kept for
// reproducibility; run from the repo root inside vitest:
//   HKN_WRITE_CANONICAL=1 pnpm vitest run packages/adapter-pi/src/generate-canonical.test.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { decodePi } from "./decode.js";
import { piHarness } from "./harness.js";

const FIXTURES_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/pi/0.84");

describe.skipIf(process.env["HKN_WRITE_CANONICAL"] !== "1")("canonical fixture generation", () => {
  it("writes canonical.json for every input.json", () => {
    for (const file of readdirSync(FIXTURES_DIR)) {
      if (!file.endsWith(".input.json")) continue;
      const input = JSON.parse(readFileSync(`${FIXTURES_DIR}/${file}`, "utf8"));
      const decoded = decodePi(input, { targetId: "pi", harnessVersion: piHarness.referenceVersion });
      const { raw: _raw, ...canonical } = decoded;
      writeFileSync(
        `${FIXTURES_DIR}/${file.replace(".input.json", ".canonical.json")}`,
        JSON.stringify(canonical, null, 2) + "\n",
        "utf8",
      );
    }
  });
});
