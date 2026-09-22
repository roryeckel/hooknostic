# Agent Plugin MCP placeholder expansion

Evidence class: **live-probe**. Tested Claude Code **2.1.278**, codex-cli
**0.154.0**, and OpenCode **1.18.32** on **2026-09-21**, on native Windows.
The observations are spawned-child records, loopback HTTP request effects, and
Claude's own MCP status lines, not router logs or inferred configuration.

## Question

Agent Plugins 1.0 expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in stdio
arguments, environment values, and cwd. A client must leave every other
placeholder-like value literal, must not expand `command`, and must not expand
remote URLs, header names, or header values. Does Claude preserve that contract
when it loads a projected package?

## Method

`probe.mjs` builds one synthetic package for Claude, Codex, and OpenCode. The
stdio server records the command wrapper that ran, its arguments, selected
environment values, and cwd before completing an MCP handshake. The parent sets
known synthetic variables while leaving another reference unset. Each reference
also appears in the `${NAME:-default}` form. The command is
`./${SYNTHETIC_COMMAND}.cmd`, and the package ships both a wrapper with that
literal name and `expanded-command.cmd`. Literal and expanded cwd directories
both exist too. So the child's own effect shows which spelling the harness used.

The same driver also creates a native-Claude control from the projected package,
with the package's placeholder-like text written directly into every native
field. Codex reaches three remote servers on a loopback endpoint during an
isolated session. Its model endpoint is also loopback and intentionally returns
HTTP 503 after MCP startup. OpenCode and Claude use credential-free health
checks for the stdio matrix.

The driver's Claude health check runs synchronously, so its in-process loopback
server cannot answer a remote connection during that check. That is why the
Claude cases in `observations.json` record no remote requests.
`package-remote.test.ts` measures Claude's remote behavior instead. It supplies
native package servers with known, reserved, unset, and defaulted references,
plus a placeholder-like header name with the variable both set and unset. It
drives one headless turn against the repository's loopback Anthropic playback
server and asserts on the URL and Authorization header the loopback MCP server
received. For the header-name servers, which never reach the transport, it
asserts on `claude mcp list`'s status line. The projection copies remote `url`
and headers into `.mcp.json` unchanged, so these are the fields a projected
package presents. No model credential or external endpoint is used.

Reproduce from the repository root:

```powershell
pnpm run bundle
node .capture/agent-plugin-mcp-placeholders/probe.mjs
pnpm exec vitest run --config .capture/agent-plugin-mcp-placeholders/vitest.config.ts
```

## Observations

- **Set references expand.** Claude expanded every set `${NAME}` it was given
  and left the unset `${HOOKNOSTIC_UNSET}` literal.
- **Default forms follow the documented rule.** `${NAME:-default}` became the
  value when the name was set and the default when it was not.
- **The projected package shows the same behavior**, in every field:
  - Claude ran `expanded-command.cmd`: it expanded the command.
  - It expanded the known argument, the known environment value, and both
    default forms.
  - It expanded the `./${SYNTHETIC_CWD}` working directory. The projection
    passes that directory to the generated launcher as an argument, and Claude
    expanded the argument before the launcher ran.
- **Remote URLs and header values follow the same rule.** Known synthetic
  references, ambient `PLUGIN_ROOT`/`PLUGIN_DATA` values, and both default
  forms expanded. The unset reference remained literal.
- **Header names stay literal.** Claude does not expand a header name. With the
  variable set or unset, it refused both servers with
  `Invalid header name: 'X-Probe-${…}'` and sent nothing. That is conformant:
  the specification forbids expanding a header name. The literal is simply not
  a legal HTTP header token, on any harness.

This is Claude's documented native `.mcp.json` expansion, not something
specific to plugins or to the projection. Its MCP documentation names no
escape.

Codex and OpenCode kept the command literal: each ran the wrapper literally
named `${SYNTHETIC_COMMAND}.cmd`. They kept every stdio reference literal too,
default forms included. Codex also preserved known, reserved, and unset
references in remote URLs and headers. The existing OpenCode projection
contributes remote fields verbatim after its native interpolation phase
(`.capture/opencode-agent-plugin`), so no package reference is resolved there.

`observations.json` records the normalized stdio matrix, and
`remote-observations.json` records Claude's raw loopback requests and
header-name status lines. Absolute roots, data directories, and loopback ports
are normalized to stable markers. No account name or credential is recorded.

## Consequences

- **Claude's native substitution is broader than the portable contract.** Any
  set environment variable is substituted into package text that the standard
  requires to reach the server literally.
- **The Claude projection keeps its native declaration** and does not hide
  package text from Claude. An author who writes `${API_KEY}` almost always
  means expansion, and hiding the text would cost every package Claude's own
  view of its servers (ADR-0011, fifteenth amendment).
  - Instead, each affected server is reported as the
    `claude:mcp-environment-expansion` deviation, HN106 (ADR-0019).
  - The server is still emitted. The build fails only under
    `components.onDeviation: "error"`.
- **What the report covers on a stdio server:** the command, args, env values,
  and cwd, except the two plugin placeholders that the projection translates to
  Claude's spellings in args, env, and cwd.
- **What it covers on a remote server:** every reference in the URL or a header
  value, the plugin placeholders included, because the standard expands nothing
  there. Header names are not covered, because Claude keeps them literal.
- **The loader accepts a placeholder-like command in a package**, since the
  schema admits one and the specification never expands it. Codex and OpenCode
  launch it literally.

## Not measured

- POSIX behavior. This capture is Windows-only.
- Placeholder-like `env` keys.
