import { defineConfig } from "@hooknostic/sdk";

/**
 * Combined Agent Plugins + Hooknostic packaging: the package root carries the
 * portable plugin.json / skills / MCP server, and Hooknostic projects a complete
 * native plugin per harness — skills, MCP and hooks in one installable unit —
 * without ever modifying the portable root.
 *
 * `onUnsupported: "warn"` because the package is heterogeneous on purpose: only
 * Claude installs a `runtimePackage`, so the other two record the omission
 * rather than failing. The default is "error".
 */
export default defineConfig({
  entry: "./src/hooks.ts",

  targets: {
    claude: { version: ">=2.1 <3", mode: "plugin", output: "./dist/claude" },
    // Projected Codex targets are mode "plugin": "local" emits repository-level
    // hooks the native manifest cannot reference.
    codex: { version: ">=0.148 <1", mode: "plugin", output: "./dist/codex" },
    // OpenCode's project plugin IS local — `.opencode/plugins/` is read from the
    // project directory, so there is nothing to install.
    opencode: { version: ">=1.18 <2", mode: "local", output: "./dist/opencode" },
  },

  agentPlugin: {
    root: ".",
    targets: ["claude", "codex", "opencode"],
    onUnsupported: "warn",
    runtimePackage: {
      manifest: "./runtime/package.json",
      lockfile: "./runtime/package-lock.json",
    },
  },
});
