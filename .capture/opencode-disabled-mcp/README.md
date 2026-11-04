# OpenCode: a host's disabled MCP server

Question: when a host launches OpenCode with its own configuration layer and
declares a server `enabled: false`, does a plugin that registers a server of the
same name re-enable it? And what does the plugin API actually report about that
entry, so a generated module can leave it alone instead of guessing?

Evidence only. The behaviour this justifies is one amendment to
[ADR-0015](../../docs/decisions/0015-project-integration.md); the support levels
do not change.

## How to reproduce

Model-free, from the repository root:

```powershell
# v2 shape: a server plugin records its MCP editor, then /api/mcp is read
$env:HKN_OPENCODE_BINARY = "<native opencode.exe>"
node .capture/opencode-disabled-mcp/drive.mjs shape content   # OPENCODE_CONFIG_CONTENT layer
node .capture/opencode-disabled-mcp/drive.mjs shape file      # global config file layer

# v1 shape: the config hook writes what it received, then `debug config` is read
node .capture/opencode-disabled-mcp/drive.mjs v1
```

`v1` needs an `opencode-ai@1.18.18` install (`npm install --prefix <scratch>
opencode-ai@1.18.18`) and its native `bin/opencode.exe`. Every run creates a
fresh OS-temp directory printed to stdout, redirects `HOME`, `USERPROFILE` and
all four XDG homes into it, and strips inherited `OPENCODE*` and credential
variables before adding its own layer. **No model is contacted**: the v2 path
uses `serve` plus `/api/mcp`, the v1 path uses `debug config`, and neither
starts a session or a TUI.

Two method notes that make a from-scratch run readable:

- **A v2 server plugin's domain boots asynchronously.** The first `/api/mcp`
  request after `serve` answers `{"data":[]}` and the plugin has not run yet, so
  the driver re-requests until the probe's trace appears. A single early request
  looks like "no plugin loaded".
- The scratch project is not a git worktree and holds only the probe plugin, so
  the same `serve` that has no session and no model is the whole environment.

## v2 findings (2.0.17 and 2.2.0)

Identical on both builds, and identical whether the host layer is
`OPENCODE_CONFIG_CONTENT` or `$XDG_CONFIG_HOME/opencode/opencode.json`.

The host layer declared four entries: a remote pair and a local pair, one of
each enabled and disabled. After normalisation, `editor.get(name)` returned:

| Host layer entry | `editor.get(name)` |
| --- | --- |
| remote, `enabled: true` | `{ type: "remote", url, disabled: false, timeout: {} }` |
| remote, `enabled: false` | `{ type: "remote", url, disabled: true, timeout: {} }` |
| local, `enabled: true` | `{ type: "local", command, disabled: false, timeout: {} }` |
| local, `enabled: false` | `{ type: "local", command, disabled: true, timeout: {} }` |
| name declared nowhere (`absent`) | `undefined`, no throw |

- The value is **synchronous** (not a thenable) and **normalised**: the
  config-side `enabled` is reported as `disabled`, and `enabled` is absent.
- **A local entry carries `disabled` exactly as a remote one does.** No second
  signal is needed for the common case of a host disabling a *local* server.
- **`get` on an undeclared name returns `undefined`.** It does not throw, so a
  guard can read `editor.get(name)?.disabled` for every declaration; there is no
  need for one `list()` plus a name set.
- `editor.list()` returns `[name, entry]` pairs and agrees with `get`. After
  `editor.set("remoteDisabled", …)` both report the replacement, so the guard's
  read and the following write see the same document.
- `ctx.mcp.list()` renders a host-disabled server as
  `{ "status": { "status": "disabled" } }`. Recorded as an observation; no test
  asserts that string, because the rendering is not what the rule is about.
- The normalised entry also reports `timeout: {}` for an entry whose layer set
  no timeout. Only `disabled` is read, for the reason above.

## v1 findings (1.18.18)

A probe plugin's `config(config)` hook writes `config.mcp` to a trace, and
`opencode debug config` prints the resolved configuration. Five controls:

| # | Host layer (`OPENCODE_CONFIG_CONTENT`) | Project `opencode.json` | Hook saw | Resolved |
| --- | --- | --- | --- | --- |
| 1 | `probe` remote, `enabled: false` | none | `probe: { type: "remote", url: "…/host-disabled", enabled: false }` | same |
| 2 | `probe` remote, `enabled: true` | none | `probe: { …, enabled: true }` | same |
| 3 | `probe` disabled at `…/host-disabled` | `probe` enabled at `…/project-enabled` | the **host** entry, `enabled: false` | the host entry |
| 4 | none | `probe` remote, `enabled: false` | `probe: { …, enabled: false }` | same |
| 5 | none | none | no `mcp` key at all | none |

- The v1 `config` hook **does receive a process-level host layer**, and it
  receives it in the **config-side spelling**: `enabled: false`, not the v2
  editor's `disabled`.
- The host layer wins over a same-named project `opencode.json` entry (control
  3), so the reported case is the one the hook already sees.
- Control 5 is the negative control: with no layer the key is absent, so a
  guard on `enabled === false` cannot fire on nothing.

## Effect

The effect is not proved here, because a shape capture is not a run. It lives in
the playback lanes:

- `.capture/opencode-v2/drive.mjs project-components-host-disabled` and
  `…-host-enabled`: two projected stdio servers, a host layer that disables one
  of them, and a startup witness per server. The disabled server's witness is
  never written while the other server, the copied skill and the generated hook
  all still work; the enabled control's witness is written, so the host entry was
  still replaced by the projection. Both builds were run with both modes.
- `packages/cli/test/harness-playback.test.ts` (repository-local integration,
  `HOOKNOSTIC_PLAYBACK=opencode-v1`): a host-layer-disabled second server's
  capture file is absent while the same-named inherited **enabled** replacement
  still starts.

## Consequence

Hooknostic reads the inherited entry before writing its own:

- **v2** reads `editor.get(name)?.disabled === true` from the MCP editor inside
  `ctx.mcp.transform`, for project components and for the package injector. The
  read is synchronous, `undefined` for a name nobody declared, and reports both
  local and remote entries, so no `list()` fallback and no separate signal is
  needed.
- **v1** reads `mcp[name]?.enabled === false` from the config hook's merged
  configuration, for the project module and the package injector.
- A same-named entry the host left enabled is still replaced, which is the
  ADR-0015 default; Hooknostic's own `enabled: false` for an unset remote
  variable is still emitted, because that write happens after the read.

## Not established

- **`ctx.mcp.list()`'s status string for a disabled entry** is an observation
  from these runs, not a claim. No test asserts it.
- **Windows only.** Every run here is native Windows; no macOS or Linux capture
  exists for this rule.
- **The v1 package route** is not exercised by a playback run. Its `config` hook
  is the same one controls 1-5 measured, and its behaviour is pinned by unit
  tests only.
- **Pi** is untouched: whether a same-named `.pi/mcp.json` entry with
  `enabled: false` suppresses a server an extension registered is unprobed. See
  [`../pi-mcp/README.md`](../pi-mcp/README.md).
