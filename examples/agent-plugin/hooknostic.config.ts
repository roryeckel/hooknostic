import { join } from "node:path";

import { defineConfig, definePackageMaterializer } from "@hooknostic/sdk";

const bundledMcp = definePackageMaterializer({
  id: "example-bundled-mcp",
  plan({ root, inputs, outputDir }) {
    return {
      command: process.execPath,
      args: [join(root, "build/bundle-mcp.mjs"), inputs.server!.absolutePath, outputDir],
    };
  },
});

/**
 * Combined Agent Plugins + Hooknostic packaging: the package root carries the
 * portable plugin.json / skills / MCP server, and Hooknostic projects a complete
 * native plugin per harness — skills, MCP and hooks in one installable unit —
 * without ever modifying the portable root.
 *
 * The MCP server is bundled once by an author-owned materializer. Every
 * installed output runs without a package-manager install or source checkout.
 */
export default defineConfig({
  entry: "./src/hooks.ts",

  targets: {
    claude: { version: ">=2.1 <3", delivery: "package", output: "./dist/claude" },
    // Package hook delivery is established from Codex 0.153.
    codex: { version: ">=0.153 <1", delivery: "package", output: "./dist/codex" },
    // Each family emits its own native package loader; never interchange them.
    opencode: { version: ">=2.0.17 <3", delivery: "package", output: "./dist/opencode" },
    legacy: { adapter: "opencode", version: ">=1.18 <2", delivery: "package", output: "./dist/opencode-v1" },
  },

  components: {
    root: ".",
    targets: ["claude", "codex", "opencode", "legacy"],
    exclude: ["build/**", "runtime/**", ".claude-plugin/**", ".agents/plugins/**"],
    materialize: [{ provider: bundledMcp, inputs: { server: "src/greet-mcp.mjs" }, into: "bundled" }],
  },
});
