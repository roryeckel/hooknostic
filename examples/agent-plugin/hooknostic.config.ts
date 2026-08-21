import { defineConfig } from "@hooknostic/sdk";

/**
 * Combined Agent Plugins + Hooknostic packaging: the package root carries the
 * portable plugin.json / skills, and hooknostic compiles the lifecycle hooks
 * into a legal client-extension directory (com.anthropic.claude-code/) plus
 * per-target dist outputs. plugin.json metadata (version/description) is
 * reused; the root schema is never modified (ADR-0004).
 */
export default defineConfig({
  entry: "./src/hooks.ts",

  targets: {
    claude: { version: ">=2.1", mode: "plugin", output: "./dist/claude" },
    codex: { version: ">=0.148", mode: "local", output: "./dist/codex" },
    opencode: { version: ">=1.18", mode: "local", output: "./dist/opencode" },
  },

  agentPlugin: { root: "." },
});
