import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".capture/claude-project-mcp-environment/probe.test.ts", ".capture/claude-project-mcp-environment/stdio.test.ts"],
    testTimeout: 120_000,
  },
});
