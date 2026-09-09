# Codex plugin hook delivery probe

Evidence class: **live-probe**. Tested `codex-cli` **0.153.2** on **2026-09-08**,
on native Windows. Observations are CLI output, the installed plugin cache, and a
marker file a hook writes when it runs.

## Question

`generateCodexArtifacts` refused `mode: "plugin"` on the grounds that "the
`plugin_hooks` feature is removed in codex-cli 0.148", and the Agent Plugin
projector set `deliversHooks: false` on the same basis. Both were established
against 0.148.0. Does an installed Codex plugin deliver hooks on 0.153.2; can a
*portable* Agent Plugins package use that channel; and if not, can one native
manifest carry skills, MCP and hooks together instead?

## Method

Six packages, each installed from a temporary local marketplace registered with
`codex plugin marketplace add` and removed afterwards. Each declares one
`UserPromptSubmit` hook whose command runs a Node script that writes a marker
file. The session is `codex exec --skip-git-repo-check
--dangerously-bypass-hook-trust "Reply with the single word: ok"`, run in an
**empty scratch directory** so no repository-level `.codex/hooks.json` can
contribute. Each package also ships a skill, so "the plugin loaded" is observable
independently of whether its hook ran.

| Probe | Manifest | Hook location |
|---|---|---|
| `hookprobe` | `.codex-plugin/plugin.json` with `"hooks": "./hooks.json"` | package root |
| `bothman` | root `plugin.json` (`$schema`) **and** `.codex-plugin/plugin.json` with `"hooks"` | package root |
| `porthook` | root `plugin.json` (`$schema`) only | both `hooks.json` and `hooks/hooks.json` |
| `natall` v1 | native, declaring `skills` + `mcpServers` + `hooks` | package root |
| `natall` v2 | same manifest, `.mcp.json` swapped to the **portable** MCP shape | — |
| `natall` v3 | same manifest, three command spellings on one event | package root |

## Observations

**Plugin hooks are not removed.** `hookprobe` fired: the run logged
`hook: UserPromptSubmit` / `hook: UserPromptSubmit Completed` and the marker file
appeared with a timestamp inside the run. No `--enable plugin_hooks` was needed —
though that flag is still accepted (`codex --enable plugin_hooks` exits 0 where an
invented feature name exits 1), so it is a registered feature, not a removed one.

A control run after `codex plugin remove` produced zero `hook:` lines, no marker,
and no skill, so the hook is attributable to the installed plugin and nothing else.

**A portable manifest cannot carry hooks.** `bothman` loaded — its skill was
discovered — but logged no `hook:` line and wrote no marker. The root
`plugin.json` outranks `.codex-plugin/plugin.json` (see `.capture/codex-agent-plugin`),
and Agent Plugins 1.0 defines no hook component, so the native manifest's `hooks`
key is not read at all. `porthook` confirms there is no convention fall-back:
with a portable manifest and a hooks document at both `hooks.json` and
`hooks/hooks.json`, nothing fired.

So the two are mutually exclusive on this version. A Codex package delivers
**either** portable skills and MCP **or** native hooks, decided by which manifest
is present.

**Plugin installation is user-level.** Every install wrote
`[marketplaces.<name>]` and `[plugins."<plugin>@<marketplace>"]` with
`enabled = true` into `~/.codex/config.toml`, and cached the package under
`~/.codex/plugins/cache/`. The installed skill was then visible from an unrelated
scratch directory. The binary also carries the string
`repository-scoped plugin migration is not allowed`.

## Follow-up: what the native manifest can carry

Three further packages, same method, once the question became "can one native
manifest replace the portable one entirely".

**All three components coexist.** `natall` declared `skills`, `mcpServers` and
`hooks` in one `.codex-plugin/plugin.json`. Its skill was discovered, both of its
servers registered, and its `UserPromptSubmit` hook ran -- in one install.

**The native MCP shape is not the portable one, and is more capable.** Under
`mcpServers: "./.mcp.json"`:

| Declared | Registered as | Headers |
|---|---|---|
| `{command, args, startup_timeout_sec}` | `stdio` | — |
| `{url, http_headers}` | `streamable_http` | **`Authorization=*****` preserved** |
| `{type: "stdio", command}` (portable) | `stdio` | — |
| `{type: "streamable-http", url, headers}` (portable) | `streamable_http` | **`http_headers: -` dropped** |
| `{type: "sse", url}` (portable) | **`streamable_http`** | — |

So Codex ignores the portable `type` and `headers` keys entirely: the transport
comes from `command` vs `url`, and headers are read from `http_headers`. Two
consequences. A literal header survives on the native route where the portable
route drops it, which is why `streamable-http` is `exact` here and `approximate`
through a root manifest. And an `sse` server does not fail closed -- it becomes a
`streamable_http` connection to the same url, so it must be dropped rather than
translated.

**Hook commands resolve against the session cwd.** One event carried three
commands at once: `node hooknostic/runtime.mjs` (relative),
`node ${PLUGIN_ROOT}/hooknostic/runtime.mjs`, and
`node ${CODEX_PLUGIN_ROOT}/...`. Only the `${PLUGIN_ROOT}` variant wrote its
marker, so a generated command must be anchored with it; the relative form the
repo-level artifact uses would silently find nothing inside an install cache.

## Consequences

- The Codex projector emits a **native** plugin, not a filtered portable one.
  Passing the portable manifest through is the single arrangement that looks
  correct and silently loses every hook, so it is removed from the projection
  along with `mcp.json`, whose native replacement is written instead.
- `deliversHooks` becomes `true` for Codex and `mode: "plugin"` is supported,
  which is what lets one installed plugin carry skills, MCP and hooks together.
- `agent-plugin.mcp.streamable-http` is `exact` on this route rather than
  `approximate`; `agent-plugin.mcp.sse` stays `unsupported` and is now actively
  filtered instead of copied through.

## Not established

- What 0.148.0 actually did. The "removed" finding was recorded against that
  build and is not re-testable here; this probe only establishes 0.153.2.
- Whether a native stdio server's `cwd` is honoured, and what a relative `args`
  path resolves against. `codex mcp get` reported `cwd: -` for a server that
  declared none.
- Linux and macOS behaviour. Windows only.

## Round 2 — hook EFFECTS through the plugin boundary (2026-09-08)

Evidence class: **live-probe**, through the offline playback lane. `codex-cli`
**0.153.2**, Windows, no model call. Re-run with:

```
HOOKNOSTIC_PLAYBACK=codex pnpm exec vitest run \
  packages/cli/test/harness-playback.test.ts -t "installed plugin"
```

### Question

Round 1 established that a hook declared by an installed plugin **runs**. It did
not establish that the hook's *response* is honoured — every effect drive in
this repository (deny, input rewrite, context) reaches Codex through the local
`.codex/hooks.json` route instead, because `buildPlaybackArtifact` targeted
`supportedModes()[0]`, which is `local`.

That gap mattered because `codexAdapter().capabilities()` resolves the matrix
from the **version alone and ignores `target.mode`**, so a `mode: "plugin"`
build advertised write channels nobody had watched work through that boundary.
ADR-0011's sixth amendment forbids treating one route's evidence as another's.

### Method

A plugin-mode artifact is built, installed from a local marketplace into an
isolated `CODEX_HOME` (`.capture/codex-isolated-home`), and driven with one
`codex exec` turn against a loopback model server, in a project directory that
is not the plugin's. The hooks are reached only through the installed plugin.

### Observations

| Channel | Scenario | Result |
|---|---|---|
| `tool.before` deny | model asks the shell tool to create `hooknostic-blocked.txt` | the file is absent; `tool.before` is in the hook trace |
| `tool.before` input rewrite | model asks the shell tool to write `hooknostic-original` | the file contains `hooknostic-rewritten` |

Both are **gates, not snapshots**, and each is discriminating on its own: making
the hook stop denying fails the deny case alone and leaves the rewrite case
passing, and vice versa.

### Consequences

- `mode: "plugin"` advertising the same write channels as `local` now rests on
  evidence from the plugin boundary itself.
- `buildPlaybackArtifact` takes a target override, because plugin mode is
  established only from 0.153.2 and the adapter's `referenceVersion` predates it.

### Not established

- `context.add`, `permission.request.block`, and the stop-prevention channels
  through this boundary. Only the two write channels above were driven.
- Linux and macOS behaviour. Windows only.
