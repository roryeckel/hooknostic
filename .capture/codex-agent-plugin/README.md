# Codex Agent Plugin consumption probe

Evidence class: **live-probe**. Tested `codex-cli` **0.153.2** on **2026-09-07**,
on native Windows. Observations are CLI output (`codex plugin add`, `codex mcp
list`, `codex mcp get`) and the resulting install cache, not verbatim wire
payloads.

Every package below was installed from a local marketplace rooted in a temporary
directory, registered with `codex plugin marketplace add <dir>` and removed with
`codex plugin marketplace remove <name>` afterwards. A marketplace root exposes
its plugins through `<root>/.agents/plugins/marketplace.json`; a `marketplace.json`
at the root itself is rejected with `marketplace root does not contain a
supported manifest`. No paid model is used — none of these commands start a
session.

## Method

Each probe is a package under `<root>/plugins/<name>` with a root `plugin.json`
and a `skills/<name>/SKILL.md`, varying one factor:

| Probe | Varied |
|---|---|
| `portable-probe` | root `plugin.json` only, **no** `.codex-plugin/` |
| `prec` / `prec2` / `prec3` | a second manifest in `.codex-plugin/` or `.claude-plugin/`, differing `version` |
| `claudeonly` | **only** `.claude-plugin/plugin.json` |
| `noschema` / `withschema` | root `plugin.json` with and without `$schema` |
| `mcpport` / `mcpdot` / `mcpschema` | `mcp.json` vs `.mcp.json`, with and without `$schema` |
| `httpsrv` | one `mcp.json` declaring both a `streamable-http` and an `sse` server |
| `p` | package containing a junk directory and a stray README |

The install destination is read from the `Installed plugin root:` line, whose
final path segment is the version Codex resolved from the manifest it chose.

## Observations

**Portable packages install unmodified.** `portable-probe` — root `plugin.json`,
conventional `skills/`, no Codex-namespaced manifest — installed, cached to
`…/cache/ap-probe/portable-probe/1.0.0/`, and the cache contained the portable
`plugin.json` and `skills/probe-skill/SKILL.md` byte-intact. No translation of
any kind is required for Codex.

**`$schema` is the discriminator.** `noschema` (root `plugin.json` without the
Agent Plugins 1.0 schema URL) failed with:

```
Error: missing plugin.json

Caused by:
    missing plugin.json
```

`withschema`, identical but for the `$schema` member, installed as `1.0.0`. The
same holds for `mcp.json`: `mcpport`/`mcpdot` installed but registered no
servers, while `mcpschema` — the same file plus its schema URL — registered
`srv-with-schema`.

**A valid root manifest outranks the namespaced ones.** `prec3` (root `1.0.0`
with `$schema`, `.codex-plugin/` `2.0.0`) installed as **1.0.0**; `prec2` (root
`1.0.0` with `$schema`, `.claude-plugin/` `9.0.0`) installed as **1.0.0**.

Two earlier probes appeared to show the opposite and were **discarded**: `prec`
and `rootvsclaude` gave `2.0.0` and `9.0.0`, but their root manifests carried no
`$schema` and so were not manifests at all. `claudeonly`, whose only manifest is
`.claude-plugin/plugin.json`, does install (as `3.0.0`) — which is why a
Claude-projected artifact appears installable on Codex despite carrying
Claude-specific MCP rewrites.

**MCP servers register from the portable `mcp.json`.** `codex mcp list` gained
`probe-portable` with `env` showing `PLUGIN_DATA` and `PLUGIN_ROOT` bound and
`cwd` set to the installed plugin root. Codex implements the Agent Plugins
placeholder contract itself; no generated launcher is involved.

**Transport coverage is partial.** From `httpsrv`, one `mcp.json` declaring both,
only the streamable-http server registered:

```
srv-http
  enabled: true
  transport: streamable_http
  url: https://example.invalid/mcp
  bearer_token_env_var: -
  http_headers: -
```

The `sse` server did not appear at all. Note `http_headers: -` — the probe
declared `Authorization: Bearer x`, and that text survived only in the copied
`mcp.json` inside the install cache, not in the registration. Codex models
remote auth as `bearer_token_env_var`, so a server authenticated by a literal
header registers unauthenticated. This is why `agent-plugin.mcp.streamable-http`
is `approximate` and `agent-plugin.mcp.sse` is `unsupported` in the profile.

**Installation copies the source directory wholesale.** Probe `p` shipped
`junkdir/nested/big.txt` and `README-junk.md` into the install cache alongside
`plugin.json` and `skills/s/SKILL.md`. Codex has no exclusion mechanism, which
is what makes the *filtered* package the value hooknostic adds for this target.

## Not established

- Whether Codex runs a locked npm install for a `runtimePackage`, as Claude's
  marketplace does. Declared `unsupported` rather than assumed.
- Whether any reverse-DNS client-extension namespace is read. Agent Plugins 1.0
  registers none, and all 62 plugins in Codex's bundled marketplace express
  Codex-specific data as top-level fields of a native `.codex-plugin/plugin.json`
  rather than through the portable `extensions` map, so the projector declares no
  namespace.
- Linux and macOS behavior. Windows only.
