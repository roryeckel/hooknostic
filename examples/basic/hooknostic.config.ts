import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  entry: "./src/hooks.ts",

  compatibility: {
    minimum: "emulated",
    onBelowMinimum: "error",
    optionalUnavailable: "info",
  },

  targets: {
    claude: { version: ">=2.1 <3", mode: "plugin", output: "./dist/claude" },
    codex: { version: ">=0.148 <1", mode: "local", output: "./dist/codex" },
    opencode: {
      version: ">=1.18 <2",
      mode: "local",
      output: "./dist/opencode",
      compatibility: { minimum: "approximate", onBelowMinimum: "warn" },
    },
  },
});
