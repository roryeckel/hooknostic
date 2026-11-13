import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".capture/codex-hook-failure/probe.test.ts"],
    testTimeout: 180_000,
  },
});
