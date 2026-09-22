# Agent Plugin MCP placeholder expansion

Evidence class: **live-probe**. Tested Claude Code **2.1.278**, codex-cli
**0.154.0**, and OpenCode **1.18.32** on **2026-09-21**, on native Windows.
The observations are spawned-child records and loopback HTTP request effects,
not router logs or inferred configuration.

## Question

Agent Plugins 1.0 expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in stdio
arguments, environment values, and cwd. A client must leave every other
placeholder-like value literal, must not expand `command`, and must not expand
remote URLs or header values. Does Claude preserve that contract when it loads a
projected package?

## Method

`probe.mjs` builds one synthetic package for Claude, Codex, and OpenCode. The
stdio server records the command wrapper that ran, its arguments, selected
environment values, and cwd before completing an MCP handshake. The parent sets
known synthetic variables while leaving another reference unset. Literal and
expanded command wrappers and cwd directories both exist, so the child effect
identifies which spelling the harness used.

The same driver also creates a native-Claude control from the projected
package. The control writes the package's placeholder-like text into every
native field, `command` included, which the portable loader never lets a package
reach. Codex reaches three remote servers on a loopback endpoint during an
isolated session; its model endpoint is also loopback and intentionally returns
HTTP 503 after MCP startup. OpenCode and Claude use credential-free health
checks for the stdio matrix.

`package-remote.test.ts` isolates Claude's remote-package behavior, which
`claude mcp list` does not exercise. It supplies three native package servers
with known, reserved, and unset references, drives one headless turn against
the repository's loopback Anthropic playback server, and asserts on the URL and
Authorization header received by a loopback MCP server. The projection copies
remote `url` and header values into `.mcp.json` unchanged, so these are the
fields a projected package presents. No model credential or external endpoint
is used.

Reproduce from the repository root:

```powershell
pnpm run bundle
node .capture/agent-plugin-mcp-placeholders/probe.mjs
pnpm exec vitest run --config .capture/agent-plugin-mcp-placeholders/vitest.config.ts
```

## Observations

Claude expanded every set `${NAME}` it was given and left the unset
`${HOOKNOSTIC_UNSET}` literal. In the native control that included the command,
arguments, and environment values. In the projected package, the known argument
and environment value expanded, and so did the `./${SYNTHETIC_CWD}` working
directory: the projection passes it to the generated launcher as an argument,
and Claude expanded that argument before the launcher ran. The remote probe
showed the same rule in URLs and header values: known synthetic references and
ambient `PLUGIN_ROOT`/`PLUGIN_DATA` values expanded, and the unset reference
remained literal.

This is Claude's documented native `.mcp.json` behavior rather than something
specific to plugins or to the projection: its MCP documentation describes
`${VAR}` and `${VAR:-default}` expansion in `command`, `args`, `env`, `url`, and
`headers`, and names no escape. The `:-default` form was not probed.

Codex and OpenCode preserved the known and unset stdio references literally.
Codex also preserved known, reserved, and unset references in remote URLs and
headers. The existing OpenCode projection contributes remote fields verbatim
after its native interpolation phase (`.capture/opencode-agent-plugin`), so no
package reference is resolved there.

`observations.json` records the normalized stdio matrix, and
`remote-observations.json` records Claude's raw loopback requests. Absolute
roots and data directories are normalized to stable markers, and no account
name or credential is recorded.

## Consequences

- Claude's native substitution is broader than the portable contract. Any set
  environment variable is substituted into package text the standard requires
  to reach the server literally.
- The Claude projection keeps its native declaration and does not hide package
  text from Claude. An author who writes `${API_KEY}` almost always means
  expansion, and hiding the text would cost every package Claude's own view of
  its servers (ADR-0011, fifteenth amendment). Instead, each server containing
  such text is reported as an `HN205` warning. The server is still emitted.
- The warning covers stdio args, env values, and cwd, minus the two plugin
  placeholders the projection translates to Claude's spellings. It covers every
  reference in a remote URL or header value, the plugin placeholders included,
  because the standard expands nothing there.
- A portable stdio `command` containing `${...}` never reaches a projector: the
  package loader already rejects it, because the standard excludes command
  from substitution.

## Not measured

- POSIX behavior. This capture is Windows-only.
- Placeholder-like header names and `env` keys.
- The `${VAR:-default}` form.
