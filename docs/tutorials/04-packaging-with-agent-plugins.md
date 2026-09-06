# Tutorial 4 — Projecting an Agent Plugin

**Example:** [`examples/agent-plugin`](../../examples/agent-plugin/) ·
**You'll learn:** compiling an Agent Plugins 1.0 package into a complete Claude Code
plugin, with or without Hooknostic hooks.

[Agent Plugins](https://agent-plugins.org/specification) standardizes a portable
manifest, Agent Skills, MCP servers, and namespaced client extensions. Hooknostic reads
that package as input and asks a harness adapter to project its components into the
harness's native plugin layout. The portable package stays unchanged.

## Combined package layout

```text
examples/agent-plugin/
├── plugin.json
├── mcp.json
├── runtime.package.json
├── runtime.package-lock.json
├── skills/greet/SKILL.md
├── hooknostic.config.ts
├── src/
│   ├── greet-mcp.mjs
│   └── hooks.ts
└── dist/
    ├── claude/                 ← complete Claude plugin: package + native hooks
    ├── codex/                  ← Hooknostic local-hook artifact only
    └── opencode/               ← Hooknostic local-hook artifact only
```

The projection is explicit:

```ts
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
    exclude: ["node_modules", "node_modules/**"],
    runtimePackage: {
      manifest: "./runtime.package.json",
      lockfile: "./runtime.package-lock.json",
    },
  },
});
```

The portable `mcp.json` declares a local `greeter` server. Its `greet` tool is
implemented with the official MCP TypeScript SDK in `src/greet-mcp.mjs` and served over
stdio. `${PLUGIN_ROOT}` keeps the entry path portable; projection translates it to the
native plugin-root variable.

The source package's `package.json` is for building this example. `runtimePackage`
keeps the MCP server's production dependencies separate: Claude projection writes the
configured manifest and npm lockfile as `dist/claude/package.json` and
`dist/claude/package-lock.json`. On marketplace installation, Claude runs the locked,
script-free npm install in its cached plugin copy. This contract supports pure-JavaScript
npm dependencies; packages that need lifecycle scripts are not supported.

Only `claude` receives the portable package. Codex already consumes Agent Plugins
natively, while this config continues to emit its separate local hook artifact.
OpenCode package projection is intentionally deferred.

Exclusions apply before discovery and packaging. Excluding `mcp.json`, a skill
directory, or its required `SKILL.md` removes that component without an unsupported
component warning; excluding an auxiliary skill file keeps the skill and omits only
that file. The mandatory `plugin.json` cannot be excluded.

## Hookless packages

`entry` is optional. A skills-only or MCP-only package can use:

```ts
export default defineConfig({
  agentPlugin: { root: ".", targets: ["claude"] },
  targets: {
    claude: { version: ">=2.1 <3", mode: "plugin", output: "./dist/claude" },
  },
});
```

Hooknostic does not bundle a runtime in this mode. It copies the distributable package,
converts `plugin.json` to `.claude-plugin/plugin.json`, copies valid `skills/` trees,
and converts `mcp.json` to `.mcp.json`.

## Claude-specific overlays

Files under `com.anthropic.claude-code/` are consumed as an overlay and appear at the
root of the emitted Claude plugin. Ordinary overlay files replace their portable-base
counterpart. Manifests, MCP server maps, and hook maps are merged structurally:

- portable identity metadata wins;
- extension-only Claude manifest fields remain;
- duplicate MCP server names fail with `HN503`;
- existing native hooks run first, followed by Hooknostic's dispatcher;
- collisions with Hooknostic's reserved runtime path fail with `HN503`.

Agent Plugin MCP placeholders in arguments, environment values, and working directories
become Claude's persistent variables: `${PLUGIN_ROOT}` → `${CLAUDE_PLUGIN_ROOT}` and
`${PLUGIN_DATA}` → `${CLAUDE_PLUGIN_DATA}`. A stdio command must be a bare executable or
start with `./`; the latter becomes a Claude plugin-root command. Streamable HTTP becomes
Claude's native `http` transport; SSE, literal URLs, and literal headers are preserved.

## Unsupported and invalid components

Invalid package structure is always `HN503`: a bad root manifest is fatal, while an
invalid individual skill or MCP server is reported and skipped. For filesystem safety,
Hooknostic is deliberately stricter than the Agent Plugins component failure boundary:
any non-excluded symlink that resolves outside the package root rejects the whole
package before component contents are parsed. A valid component the target cannot
represent is `HN205`. The default is an error; use `onUnsupported: "warn"` to omit only
that component and record the omission in build-report schema v2.

```bash
node ../../packages/cli/bin/hooknostic.mjs build
claude plugin validate --strict dist/claude
```

See [ADR-0011](../decisions/0011-agent-plugin-native-projection.md) for the architectural
boundary and [Installing built output](../installing-artifacts.md) for installation.
