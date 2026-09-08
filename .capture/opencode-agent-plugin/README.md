# OpenCode Agent Plugin projection probe

Evidence class: **live-probe**. Tested `opencode` **1.18.29** on **2026-09-08**,
on native Windows. Observations are `opencode debug config` (the *resolved*
configuration, after plugin hooks) and `opencode debug skill`. Neither starts a
session, so the whole capability surface below was established without a model
call; only the transport-negotiation row is read from the binary instead.

## Question

`mode: "plugin"` for OpenCode means an npm package and is deferred. But the
requirement is that one plugin carry skills, MCP **and** hooks. OpenCode already
loads a hook module from `.opencode/plugins/`. Can that same directory carry the
other two components, and if so what does a projection have to translate?

## Method

Scratch projects under a temp directory, each with a project-local plugin module
that mutates the merged configuration through its `config` hook. Every claim is
read back from `debug config` / `debug skill`, and the last section installs a
real `hooknostic build` output rather than a hand-written module.

## Observations

**A project plugin can contribute both other components.** A module whose
`config` hook wrote `config.mcp` and `config.skills.paths` produced both in the
resolved configuration, and the skill at the injected path was listed by
`debug skill`. No install step is involved: `.opencode/plugins/` is read from
the project directory, so this is inherently project-scoped.

**`skills.paths` is additive, in two directions.** An injected path coexisted
with the project's own `skills.paths` entry *and* with the default `.agents/skills`
discovery directory — all three skills were listed together.

**A plugin can address files shipped beside it.** `import.meta.url` resolves to
the module's real location, so a module pointed `skills.paths` at its own sibling
`skills/` directory and the skill was found. `PluginInput` carries
`{client, project, worktree, directory, experimental_workspace, serverUrl, $}`,
where `directory` is the *project* directory, not the plugin's.

**The scan is flat and confined.** Two sibling modules in `.opencode/plugins/`
both took effect. A module at `.opencode/plugins/sub/probe.js` and one at
`.opencode/other/probe.js` did not load at all, so package content nests safely
beneath the scanned directory.

**Every export is loaded as a plugin.** A module carrying
`export const plugin = {...}` beside its default export failed *entirely*:

```
level=ERROR message="failed to load plugin" error="Plugin export is not a function"
```

So a generated module cannot carry exported metadata; the package identity has
to be a comment.

**Interpolation runs BEFORE plugin config hooks.** This is the one that changes
the design. In a single run, with `OCVAL_SECRET` set:

| Same `{env:OCVAL_SECRET}` header, declared in | Resolved value |
|---|---|
| `opencode.json` | `Bearer LIVE_SECRET` |
| a plugin's `config` hook | `Bearer {env:OCVAL_SECRET}` |

Emitting OpenCode's own syntax from a plugin is therefore useless — the literal
text reaches the server.

**Superseded 2026-09-08.** The conclusion drawn at the time — "a plugin must read
`process.env` itself" — was wrong, and the end-to-end run below recorded the
resulting expansion as a success. Agent Plugins 1.0 defines exactly two
placeholders, states that a client "MUST NOT perform placeholder or
environment-variable expansion in `url`, header names, or header values", and
requires unrecognized placeholder-like text to remain literal. The generated
module now substitutes only the install directory. What this probe actually
establishes is narrower and still true: OpenCode's own `{env:}` interpolation
cannot be reached from a plugin, so that syntax must not be emitted either.

**Remote transport is negotiated.** The binary constructs
`[{name:"StreamableHTTP",…},{name:"SSE",…}]` and passes declared headers to
both, so a single `type: "remote"` covers a portable `streamable-http` *or*
`sse` server. Unlike Codex, an sse server does not have to be dropped.

## End-to-end

A real `hooknostic build` output — hook module, generated package module and a
copied `skills/` tree — was placed in a scratch project. With `OCVAL_SECRET` set:

```
stdio env  : {"TOKEN": "LIVE_SECRET"}
stdio cmd  : ["node", "…\\.opencode\\plugins/server.mjs"]
remote hdr : {"Authorization": "Bearer LIVE_SECRET"}
skills     : ["…\\.opencode\\plugins\\skills"]
```

The first and third lines are the superseded behaviour, kept as the record of
what the run showed. A current build leaves both values as the literal
`${MY_TOKEN}` the package wrote, and the paths now resolve through the nested
`package/` directory rather than the plugin directory itself.

`${PLUGIN_ROOT}` resolved to the real install directory, `${VAR}` resolved from
the environment, the skill was discovered, and no plugin load or config-hook
error was logged.

Two defects were found this way and could not have been found from the emitted
text alone:

- Exported metadata failed the whole module (above).
- Substituting the plugin root through a `JSON.stringify` / `JSON.parse` round
  trip raised `JSON Parse error: Invalid escape character U` — a Windows path's
  backslashes are not valid JSON escapes. Substitution walks the value instead.

## Not established

- npm-package plugin mode. `opencode plugin <module>` takes `--global` with
  `default: false`, so that route is project-scoped too, but nothing about its
  install location or layout was probed.
- Whether an unset `${VAR}` should resolve to empty or stay literal. The
  generated module leaves it literal.
- Linux and macOS behaviour. Windows only.
