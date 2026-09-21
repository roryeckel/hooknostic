# Codex plugin MCP environment investigation

Evidence class: **live-probe**. Measured Codex CLI **0.154.0**, native Windows,
2026-09-21. `.capture/codex-project-mcp` established `env_vars` for *project*
configuration; this measures the same boundary for an **installed plugin's**
`.mcp.json`, which is a separate code path and a separate install shape.

## Question and method

An Agent Plugins package declares `${NAME}` in its MCP `env`. The launcher
expands that reference from its own environment. Does a plugin-installed stdio
MCP server receive the ambient variable, and if not, what makes it arrive?

Run from the source checkout with Node and the installed Codex CLI on PATH:

```sh
node .capture/codex-plugin-mcp-environment/probe.mjs
```

The probe creates a disposable synthetic marketplace, plugin and repository
under an isolated `CODEX_HOME` in a directory containing spaces, strips
credential-shaped variables from the environment it hands Codex, and removes its
scratch directory afterwards. No personal trust, marketplace or installation
setting is touched, and the real `~/.codex` is never read or written.

The plugin's MCP server is a synthetic script that records the **names** of the
variables it was given. It records one value only, a `SYNTHETIC_MARKER` the
probe itself set; no real credential is read, logged or written.

A synthetic model provider points at the probe's own loopback listener, which
returns HTTP 503 for every request. Codex's session fails as expected — this is
not a successful model conversation. MCP startup is measured before that
failure, and no paid model is called.

The two cases differ by one line: the same plugin, the same environment, with
and without `env_vars` in its `.mcp.json`.

## Observations

- A plugin stdio server is started with a fixed platform baseline and nothing
  else. On Windows that is `APPDATA`, `COMSPEC`, `HOMEDRIVE`, `HOMEPATH`,
  `LOCALAPPDATA`, `PATH`, `PATHEXT`, `PROGRAMDATA`, `PROGRAMFILES`,
  `PROGRAMFILES(X86)`, `PROGRAMW6432`, `SHELL`, `SYSTEMDRIVE`, `SYSTEMROOT`,
  `TEMP`, `TMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR` — plus
  whatever the declaration itself contributes.
- It is an allowlist, not a secret filter. `SYNTHETIC_MARKER` is not
  credential-shaped and is still absent (`undeclaredEnvVar`).
- Naming it in `env_vars` delivers the value (`declaredEnvVar`). This is the
  only mechanism found that carries an ambient value across the boundary.
- `env` values are copied **verbatim**. `LITERAL_REF` is declared as
  `${SYNTHETIC_MARKER}` and arrives as that literal text in both cases, so Codex
  performs no reference expansion of its own. A projection that relies on
  expansion must therefore either expand before emitting or forward the name.
- The same variable is present for the plugin's **command hooks**, which inherit
  the environment whole (`.capture/codex-plugin-hooks`). The restriction is
  specific to MCP servers, so a plugin's two halves see different environments
  unless the projection forwards.

## Consequences for the projection

A package still cannot ask. Hooknostic expands `${PLUGIN_ROOT}` and
`${PLUGIN_DATA}` and leaves every other reference literal for a package,
because Agent Plugins 1.0 says "unrecognized placeholder-like text MUST remain
literal" and ADR-0011 records removing a projection that expanded host
variables anyway. Nothing here licenses reintroducing that: `${NAME}` in a
package's `mcp.json` is text, not a request.

What this establishes is that `env_vars` is the only way an ambient value
reaches a plugin's stdio server on Codex, which is why the request is stated
somewhere a package standard does not govern. ADR-0018 puts it in
`components.mcpEnvironment` in `hooknostic.config.ts` -- server name to
variable NAMES -- and the Codex projector renders it as that server's
`env_vars`. Claude and OpenCode render nothing, because both start a server
with the environment they were launched with.

This extends `.capture/mcp-child-path`, which recorded that the child's
environment is filtered to roughly this size. What it adds is what the filter
is (an allowlist, not a secret filter) and the supported way through it.

## Limits

- Windows only. The baseline list is platform-specific; a Unix run would record
  a different set, and the Codex source additionally mentions variables that
  were unset on this machine and so could not appear here.
- One Codex version. `env_vars` is not new in 0.154.0, but the baseline
  membership is not guaranteed stable across releases.
- The probe measures a local stdio plugin server. Remote transports carry their
  own authentication mechanisms and are out of scope.
