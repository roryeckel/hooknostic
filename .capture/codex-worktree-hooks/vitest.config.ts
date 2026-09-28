import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".capture/codex-worktree-hooks/probe.test.ts"],
    testTimeout: 300_000,
  },
});
