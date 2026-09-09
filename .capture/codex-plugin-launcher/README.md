# Codex plugin launcher probe

Evidence class: **live-probe**, through the offline playback lane rather than a
one-off capture. Tested `codex-cli` **0.153.2** on **2026-09-08**, on native
Windows. **No model call**: the session runs against a loopback playback server,
the same lane `.capture/harness-playback` describes and that the Claude
projection claim already rests on.

Re-run with:

```
HOOKNOSTIC_PLAYBACK=codex pnpm exec vitest run \
  packages/cli/test/harness-playback.test.ts -t "generated launcher"
```

## Question

`.capture/codex-native-mcp` established that the native MCP route expands no
Agent Plugins placeholder and that `PLUGIN_ROOT` and `PLUGIN_DATA` are **unset**
in the spawned process, and that a declared `cwd: "."` reaches the installed
plugin root with a relative argument resolving against it.

What that leaves open is whether a *real installed plugin* starts its server
through an interposed launcher reached by exactly that relative argv, and
whether both variables then arrive. Nothing established it, and — worth stating
— nothing established it of the previous direct-spawn output either.

## Method

A projected plugin is installed into an isolated `CODEX_HOME`
(`.capture/codex-isolated-home`) from a local marketplace, then driven with one
`codex exec` turn against a loopback model server. Its single stdio server is a
fixture that writes `process.cwd()`, `process.env.PLUGIN_ROOT`,
`process.env.PLUGIN_DATA` and its own argv to a marker file, then answers
`initialize` and `tools/list`.

The declaration is deliberately the shape this route used to drop outright:

```json
{ "type": "stdio", "command": "node",
  "args": ["${PLUGIN_ROOT}/plugin-mcp-env-fixture.mjs", "${PLUGIN_DATA}"],
  "env": { "CAPTURE_PATH": "${PLUGIN_ROOT}/mcp-environment.json" },
  "cwd": "./mcp-working-dir" }
```

## Observations

The marker file was written inside the installed plugin root, and:

| Field | Result |
|---|---|
| `PLUGIN_ROOT` | the absolute install root, `…/plugins/cache/<marketplace>/<plugin>/1.0.0` |
| `PLUGIN_DATA` | a non-empty absolute path |
| `argv` | the expanded `PLUGIN_DATA`, not the literal `${PLUGIN_DATA}` |
| `cwd` | `<install root>/mcp-working-dir`, the declared subdirectory |

So the launcher is reached through `node ./runtime/mcp-launcher.mjs <index>` with
`cwd: "."`, it binds both variables, it expands `args` and `env` values, and it
establishes the declared working directory before the server starts.

**The lane is a gate, not a snapshot.** Removing the launcher's two `env`
assignments and re-running it fails the lane. That is what makes it worth more
than a one-off capture: a regression here is caught by CI rather than by a
future reader noticing the record is stale.

## Consequences

- `agent-plugin.mcp.stdio` on Codex is honestly `emulated` rather than
  overstated: the contract is delivered, but by generated code and into a data
  directory Hooknostic chose.
- A server naming `${PLUGIN_DATA}` is no longer dropped.

## Not established

- Whether a *tool call* through such a server completes end to end. The lane
  proves the server is spawned with the right environment and answers
  `initialize`/`tools/list`; it does not drive a `tools/call`.
- Whether Codex will ever bind these variables itself on the native route, which
  would move the data directory. The launcher defers to a client that already
  sets a matching `PLUGIN_ROOT` and an absolute `PLUGIN_DATA`, so that case is
  handled rather than merely noted.
- Linux and macOS behaviour. Windows only.
