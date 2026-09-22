import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".capture/agent-plugin-mcp-placeholders/package-remote.test.ts"],
    testTimeout: 120_000,
  },
});
