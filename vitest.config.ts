import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { defineConfig } from "vitest/config";

// Baseline fixtures compare paths returned by child Node processes, which use
// real paths (macOS /private/var and Windows long names). Tests of aliases create
// explicit symlinks/junctions so those regressions remain covered on every OS.
const testTemp = realpathSync.native(tmpdir());
process.env.TMPDIR = process.env.TMP = process.env.TEMP = testTemp;

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      // Repo scripts with load-bearing logic (release notes composition).
      "scripts/**/*.test.mjs",
    ],
    // Smoke tests drive real installed harnesses and are opt-in via env flag.
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
  },
});
