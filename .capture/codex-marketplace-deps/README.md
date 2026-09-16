# Codex marketplace dependency installation capture

## Question

When Codex installs a marketplace plugin whose root contains an npm manifest and
lockfile, does it install that plugin's Node.js dependencies inside the installed
plugin root, as Claude Code does (`.capture/claude-marketplace-deps`)?

This is the question `.capture/codex-agent-plugin` left open under "Not
established", and the one the `agent-plugin.runtime-package` rating in
`packages/adapter-codex/src/project-agent-plugin.ts` answered with
"Not probed."

## Method

Mirror the Claude capture deliberately: the same dependency (`is-number@7.0.0`),
the same lockfile, no committed `node_modules`, so the two records compare
directly. The package adds a native `.codex-plugin/plugin.json` and an `mcp.json`
whose stdio server imports the dependency.

Registered with `codex plugin marketplace add`, installed with the qualified
`codex plugin add <plugin>@<marketplace>` form, under an isolated `CODEX_HOME`
outside `%TEMP%` (`.capture/codex-isolated-home`).

The finding rests on the filesystem and on module resolution, not on log output:
a grep for an install line proves nothing about whether the dependency loads.
No model call; no session is started.

Evidence class: **live-probe**. This directory holds probe inputs and the
observation below, not a verbatim harness payload.

## Observations

Probed on `codex-cli` **0.154.0**, **2026-09-15**, native Windows.

| Check | Result |
|---|---|
| `plugin marketplace list`, no `CODEX_HOME` | lists the real `openai-curated` marketplace |
| `plugin marketplace list`, isolated `CODEX_HOME` | `No plugin marketplaces in scope.` |
| `plugin marketplace add <dir>` | `Added marketplace ...` |
| `plugin add dependency-probe@...` | `Installed plugin root: <CODEX_HOME>\plugins\cache\...\1.0.0` |
| `package.json` in installed root | present, copied verbatim |
| `package-lock.json` in installed root | present, copied verbatim |
| `node_modules` in installed root | **absent** |
| `import("is-number")` from installed root | **`ERR_MODULE_NOT_FOUND`** |
| same import, with `node_modules/is-number` placed by hand | `true` (positive control) |
| same import, control removed again | `ERR_MODULE_NOT_FOUND` |

**Codex does not install a plugin's npm dependencies.** The manifest and lockfile
are copied like any other file — consistent with `.capture/codex-agent-plugin`'s
"installation copies the source directory wholesale" — and nothing acts on them.

The last three rows are the point. A missing `node_modules` alone would only show
that the directory is absent; the hand-placed control establishes that the
resolution check can report success, so the failure either side of it is the
dependency genuinely not resolving rather than a broken probe.

This confirms the prediction made from reading the 0.149.1 binary: its single
`--ignore-scripts` occurrence sits in `core-plugins/src/npm_source.rs` beside
`npm pack failed with status`, which is Codex *fetching* an npm-sourced plugin,
not installing a plugin's dependencies. There are no `npm ci`, `package-lock.json`
or `node_modules` references on the install path.

## Consequences

- `agent-plugin.runtime-package` stays `unsupported` on Codex, but the rationale
  becomes a measured fact rather than an absence of evidence.
- A Codex plugin carrying an MCP server with npm imports must vendor or bundle
  its dependency closure. Copying the server with a manifest, which is what
  ADR-0012 established for Claude, produces a plugin that fails at module
  resolution on Codex.
- Two of three supported harnesses therefore cannot install dependencies, which
  is the evidence behind treating bundling as the portable answer rather than a
  Claude-only npm install.

## A vendored `node_modules` does work

Re-run with `node_modules/is-number` placed inside the source package:

| Check | Result |
|---|---|
| `node_modules/is-number` in installed root | **present** — copied with everything else |
| `import("is-number")` from installed root | **`true`** |

So Codex installs no dependencies but faithfully carries any the package ships.
That makes vendoring a working route *at the harness level*, as it is on both
OpenCode routes (`.capture/opencode-plugin-routes`) — but not one Hooknostic can
currently use: package inventory strips `node_modules` at every depth, so a
vendored tree never reaches the output. Bundling is the route available today.
The probe input is not committed with a `node_modules`; recreate it to reproduce.

## Not established
- MCP server startup behaviour. `mcp.json` is included and its server writes a
  marker on load, but confirming Codex launches it needs a session; the
  dependency question was answerable without one, so none was started.
- Linux and macOS behaviour. Windows only.

## Known wrinkle — the control command is not side-effect-free

The real `~/.codex/config.toml` md5 changed across this probe
(`7af5dc99669bebe1ebba93b6ca2fe69d` to `d340671488807c7ca79a1003d542faae`), and
the file afterwards carries `trust_level = "trusted"` entries for the working
directories used. Re-running the bare command is idempotent once the entry
exists, which is consistent with a first invocation adding it.

The isolated commands are not implicated: the un-isolated `plugin marketplace
list` **control** runs against the real home by design. But
`.capture/codex-isolated-home` records that same md5 as unchanged, so that row
holds only on a machine whose config already carries an entry for the capture
directory.

Establishing which invocation writes the entry would require adding another
`trusted` entry to a real user configuration, which is a security-relevant
change and was not done. A lane that must stay clean should snapshot and restore
`config.toml` around the control, or drop the un-isolated control entirely and
accept a weaker isolation claim.
