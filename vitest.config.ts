import { defineConfig } from "vitest/config";

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
