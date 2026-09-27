# Combined Agent Plugins example

One Agent Plugins 1.0 package supplies a skill, a bundled stdio MCP server, and
portable hooks to Claude Code, Codex, and both OpenCode families.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/hooknostic.mjs check --config examples/agent-plugin/hooknostic.config.ts
node packages/cli/bin/hooknostic.mjs build --config examples/agent-plugin/hooknostic.config.ts
```

The author-owned materializer bundles `src/greet-mcp.mjs` and its dependencies into
`bundled/greet-mcp.mjs` inside each package. Consumers need Node, but no dependency
installation or workspace checkout. The default keeps strict component policies.

Follow the [packaging tutorial](../../docs/tutorials/04-packaging-with-agent-plugins.md)
for both marketplace manifests, installation, updates, verification, hookless packages,
and the optional Claude runtime-package variation. OpenCode v2 is `opencode`;
the explicit `legacy` target produces v1 output in `dist/opencode-v1`.

To check activation, ask the harness to run `echo HOOKNOSTIC_BLOCK_PROBE`:
the hook must return **Hooknostic marketplace probe blocked.** The command is harmless
even if activation failed. Ask it to use the `greet` skill and call the `greeter`
server's `greet` tool; the default MCP response is **Hello, friend!**
