import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".capture/codex-hook-matcher/probe.test.ts"],
    testTimeout: 120_000,
  },
});
