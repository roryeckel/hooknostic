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
    claude: { version: ">=2.1 <3", delivery: "package", output: "./dist/claude" },
    // Package hook delivery is established from Codex 0.153.
    codex: { version: ">=0.153 <1", delivery: "package", output: "./dist/codex" },
    // Package delivery emits an npm package: a `package.json` with
    // `exports["./server"]` and the compiled modules beside it. Name the
    // directory in a project's `opencode.json` `plugin` array; no registry
    // publication is required.
    opencode: { version: ">=1.18 <2", delivery: "package", output: "./dist/opencode" },
  },

  components: {
    root: ".",
    targets: ["claude", "codex", "opencode"],
    onUnsupported: "warn",
    runtimePackage: {
      manifest: "./runtime/package.json",
      lockfile: "./runtime/package-lock.json",
    },
  },
});
