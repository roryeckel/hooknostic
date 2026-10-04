import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".capture/codex-code-mode/probe.test.ts"],
    testTimeout: 180_000,
  },
});
