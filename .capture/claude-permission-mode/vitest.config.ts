import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".capture/claude-permission-mode/probe.test.ts"],
    testTimeout: 900_000,
  },
});
