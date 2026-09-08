# Codex native MCP route probe

Evidence class: **live-probe**. Tested `codex-cli` **0.153.2** on **2026-09-08**,
on native Windows. Observations are `codex mcp list` / `codex mcp get` against an
installed plugin. No session is started, so nothing here costs a model call.

## Question

`.capture/codex-agent-plugin` established that on the **portable** route — a root
`plugin.json` beside `mcp.json` — "Codex implements the Agent Plugins placeholder
contract itself": `PLUGIN_ROOT` and `PLUGIN_DATA` appeared bound in `env`, and
`cwd` was set to the installed plugin root.

`.capture/codex-plugin-hooks` then forced the projection onto the **native**
route (`.codex-plugin/plugin.json` with `mcpServers: "./.mcp.json"`), because a
portable manifest outranks the native one and suppresses hooks. Does the native
route implement the same contract? That capture left it open, recording only that
`codex mcp get` reported `cwd: -` for a server that declared none.

## Method

One package `natenv`, installed from a temporary local marketplace registered
with `codex plugin marketplace add` and removed afterwards, with a native
manifest pointing at a native `.mcp.json`. Two rounds, varying the declared
`cwd`, `env` and placeholder use; each server read back with `codex mcp get`.

## Observations

**The native route implements none of the placeholder contract.** From the first
round:

| Declared | Read back |
|---|---|
| `args: ["${PLUGIN_ROOT}/server.mjs", "${PLUGIN_DATA}/state"]` | `args: ${PLUGIN_ROOT}/server.mjs ${PLUGIN_DATA}/state` |
| no `env` | `env: -` |
| no `cwd` | `cwd: -` |

The placeholders reach the server as literal text, and neither variable is bound
in the environment. This is the opposite of the portable route, and it is the
consequence of the manifest switch that `.capture/codex-plugin-hooks` forced.

**`cwd` is read, and resolves against the plugin root.** The declared string is
joined to the install directory verbatim — it is not expanded first:

| Declared `cwd` | Read back |
|---|---|
| `${PLUGIN_ROOT}/worker` | `…\natenv\1.0.0\${PLUGIN_ROOT}/worker` |
| `./worker` | `…\natenv\1.0.0\./worker` |
| `.` | `…\natenv\1.0.1\.` |
| `worker` | `…\natenv\1.0.1\worker` |

So a **relative** `cwd` is the one anchor this route provides, and the last two
rows are what a projection can use: `.` reaches the plugin root, and a plain
relative path reaches a directory inside it.

**`env` round-trips.** A server declaring `TOKEN` and `REF` read back
`env: REF=*****, TOKEN=*****` (values masked by the CLI display). Author-declared
environment survives; nothing is added to it.

**The manifest tolerates the portable metadata fields.** A native manifest
carrying `author`, `license`, `homepage` and `keywords` alongside `name`,
`version`, `description` and `mcpServers` installed normally and resolved its
version from the manifest (the install root's final segment moved from `1.0.0` to
`1.0.1` when the version changed), so carrying those fields through cannot lose
information whether Codex reads them or ignores them.

## Consequences

- The Codex projector carries the placeholder contract itself: every stdio server
  gets an explicit plugin-root-relative `cwd`, and `${PLUGIN_ROOT}` / `./` paths
  in `command` and `args` are rewritten relative to it. Without this a package
  that references its own shipped code — the ordinary case — registers an argv
  that cannot resolve.
- `${PLUGIN_DATA}` has no representation on this route and no way to be
  synthesized, so a server using it is dropped with an omission rather than
  emitted with literal text in its argv.
- `agent-plugin.mcp.stdio` is `emulated` rather than `exact` on Codex: the
  anchoring is achieved by a different mechanism than the spec's, and one
  portable shape is not representable.
- The portable manifest's `author`, `homepage`, `repository`, `license` and
  `keywords` are carried into the native manifest rather than dropped.

## Not established

- Whether the recorded `cwd` is honoured at spawn. It is read and stored, and it
  is the same field the portable route populated, but no server was started —
  that needs a session.
- Whether Codex reads the metadata fields it accepts.
- Linux and macOS behaviour. Windows only.
