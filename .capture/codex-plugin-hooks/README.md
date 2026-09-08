# Codex plugin hook delivery probe

Evidence class: **live-probe**. Tested `codex-cli` **0.153.2** on **2026-09-08**,
on native Windows. Observations are CLI output, the installed plugin cache, and a
marker file a hook writes when it runs.

## Question

`generateCodexArtifacts` refuses `mode: "plugin"` on the grounds that "the
`plugin_hooks` feature is removed in codex-cli 0.148", and the Agent Plugin
projector sets `deliversHooks: false` on the same basis. Both were established
against 0.148.0. Does an installed Codex plugin deliver hooks on 0.153.2, and if
so can a *portable* Agent Plugins package use that channel?

## Method

Three packages, each installed from a temporary local marketplace registered with
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

## Consequences

- The `deliversHooks: false` on the Codex Agent Plugin projector is right, but
  not for the recorded reason. It holds because the portable manifest displaces
  the only manifest Codex reads hooks from, not because the feature is gone.
- `mode: "plugin"` remains unavailable for Codex hooks, now as an unimplemented
  case rather than an impossible one: it would require emitting a native
  `.codex-plugin/plugin.json`, which forfeits the portable manifest and therefore
  is not a projection of an Agent Plugins package.
- A globally installed portable package has no hook channel at all, because
  `.codex/hooks.json` is resolved relative to the session's project directory.

## Not established

- What 0.148.0 actually did. The "removed" finding was recorded against that
  build and is not re-testable here; this probe only establishes 0.153.2.
- Whether a native `.codex-plugin/` manifest can also carry `mcp.json`-equivalent
  servers, which a hooks-capable native package would need.
- Linux and macOS behaviour. Windows only.
