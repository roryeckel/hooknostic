import { defineConfig } from "@hooknostic/sdk";

/**
 * Combined Agent Plugins + Hooknostic packaging: the package root carries the
 * portable plugin.json / skills / MCP server, and Hooknostic projects a complete Claude
 * plugin into dist/claude while emitting hook-only artifacts for other
 * targets. The portable root is never modified.
 */
export default defineConfig({
  entry: "./src/hooks.ts",

  targets: {
    claude: { version: ">=2.1 <3", mode: "plugin", output: "./dist/claude" },
    codex: { version: ">=0.148 <1", mode: "local", output: "./dist/codex" },
    opencode: { version: ">=1.18 <2", mode: "local", output: "./dist/opencode" },
  },

  agentPlugin: {
    root: ".",
    targets: ["claude"],
    runtimePackage: {
      manifest: "./runtime/package.json",
      lockfile: "./runtime/package-lock.json",
    },
  },
});
