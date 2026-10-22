# Combined Agent Plugins example

One Agent Plugins 1.0 package supplies a skill, a bundled stdio MCP server, and
portable hooks to Claude Code, Codex, GitHub Copilot CLI, both OpenCode families, and Pi 1.x, where a
generated extension registers the MCP server with Pi's native MCP client.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/hooknostic.mjs check --config examples/agent-plugin/hooknostic.config.ts
node packages/cli/bin/hooknostic.mjs build --config examples/agent-plugin/hooknostic.config.ts
```

The author-owned materializer bundles `src/greet-mcp.mjs` and its dependencies into
`bundled/greet-mcp.mjs` inside each package. Consumers need Node, but no dependency
installation or workspace checkout. Unsupported components remain errors.

Follow the [packaging tutorial](../../docs/tutorials/04-packaging-with-agent-plugins.md)
for both marketplace manifests, installation, updates, verification, hookless packages,
and the optional Claude runtime-package variation. OpenCode v2 is `opencode`;
the explicit `legacy` target produces v1 output in `dist/opencode-v1`.

For Copilot, load the built package for one session with
`copilot --plugin-dir ./dist/copilot`, or install it through the included
`.github/plugin/marketplace.json` with `copilot plugin marketplace add .` and
`copilot plugin install combined-example@hooknostic-example`; see
[Copilot installation](../../docs/installing-artifacts.md#github-copilot-cli).

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
