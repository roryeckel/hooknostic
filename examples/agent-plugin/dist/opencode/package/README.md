# Combined Agent Plugins example

One Agent Plugins 1.0 package supplies a skill, a bundled stdio MCP server, and
portable hooks to Claude Code, Codex, and both OpenCode families. The same default
configuration delivers the hooks and skill to Pi, explicitly accepting only
`pi:mcp-stdio-omitted` because Pi has no native MCP channel.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/hooknostic.mjs check --config examples/agent-plugin/hooknostic.config.ts
node packages/cli/bin/hooknostic.mjs build --config examples/agent-plugin/hooknostic.config.ts
```

The author-owned materializer bundles `src/greet-mcp.mjs` and its dependencies into
`bundled/greet-mcp.mjs` inside each package. Consumers need Node, but no dependency
installation or workspace checkout. Other unsupported components remain errors;
Pi's accepted omission remains informational in the build report, with
`unsupported` support and the server counted as skipped.

Follow the [packaging tutorial](../../docs/tutorials/04-packaging-with-agent-plugins.md)
for both marketplace manifests, installation, updates, verification, hookless packages,
and the optional Claude runtime-package variation. OpenCode v2 is `opencode`;
the explicit `legacy` target produces v1 output in `dist/opencode-v1`.

For Pi, run `pi install -l` with the absolute path to the built `dist/pi`
package from the project where you want to use it, then follow Pi's activation prompts. The package
declares its generated extension and `greet` skill in `package.json`. It does
not declare a native MCP server. The shared materializer still runs for the
other targets. See
[Pi installation](../../docs/installing-artifacts.md#pi).

To check activation, ask the harness to run `echo HOOKNOSTIC_BLOCK_PROBE`:
the hook must return **Hooknostic marketplace probe blocked.** The command is harmless
even if activation failed. Ask it to use the `greet` skill and call the `greeter`
server's `greet` tool; the default MCP response is **Hello, friend!**
On Pi, check the blocking hook and `greet` skill; the MCP check applies to the
other outputs.
