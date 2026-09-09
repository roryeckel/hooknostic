# Codex isolated-home probe

Evidence class: **live-probe**. Tested `codex-cli` **0.153.2** on **2026-09-08**,
on native Windows. No model call: every command below reads or writes local
configuration only.

## Question

`.capture/codex-agent-plugin` recorded that installation is user-level —
"marketplace and plugin entries land in `~/.codex/config.toml`". That is fine for
a one-off capture with manual cleanup, but a test lane cannot mutate a
contributor's real Codex configuration on every run: a crash between `plugin add`
and `plugin remove` leaves debris behind, and the lane would be unrunnable on any
machine whose Codex is in use.

Claude's equivalent lane sidesteps this entirely with `--plugin-dir`, which
installs nothing. Codex has no such flag. Does `CODEX_HOME` relocate plugin and
marketplace state, and can a plugin actually be installed inside a relocated
home?

## Method

A minimal local marketplace at `<root>/.agents/plugins/marketplace.json`
declaring one plugin, whose `.codex-plugin/plugin.json` points at a `skills/`
directory. Then, with `CODEX_HOME` set to an empty scratch directory:
`plugin marketplace add <path>`, `plugin add <plugin>@<marketplace>`,
`plugin list`. The real `~/.codex/config.toml` was hashed before and after.

The control matters more than the commands: "no marketplaces" only demonstrates
isolation if the real home has one to be isolated from.

## Observations

| Check | Result |
|---|---|
| `plugin marketplace list`, no `CODEX_HOME` | lists the real `openai-curated` marketplace |
| `plugin marketplace list`, isolated `CODEX_HOME` | `No plugin marketplaces in scope.` |
| `plugin marketplace add <local path>` | `Added marketplace ... Installed marketplace root: ...` |
| `plugin add <plugin>` | **rejected**: `plugin requires --marketplace unless passed as <plugin>@<marketplace>` |
| `plugin add <plugin>@<marketplace>` | installed, `plugin list` reports `installed, enabled` |
| real `~/.codex/config.toml` md5, before and after | `6722b05b511c2a3607a7a2637aa6904f`, unchanged |
| real `plugin marketplace list`, after | still only `openai-curated` |

**`CODEX_HOME` fully relocates plugin and marketplace state.** The discriminating
pair is the first two rows: the same command reports a marketplace from the real
home and none from the isolated one.

**The install cache is `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/`,**
independently re-confirming on a second path the version-scoped layout
`.capture/codex-agent-plugin` recorded — which is why a `PLUGIN_DATA` directory
inside the install root would be discarded by every upgrade.

## Consequences

- A test lane can install and run a projected Codex plugin with `CODEX_HOME`
  pointed at its own build tree, mutating nothing the contributor owns.
- The lane must write the marketplace document at
  `<root>/.agents/plugins/marketplace.json`; a `marketplace.json` at the root is
  rejected (`.capture/codex-agent-plugin` §Method).
- `plugin add` must use the qualified `<plugin>@<marketplace>` form.

## Not established

- Whether `CODEX_HOME` isolates anything beyond plugin and marketplace state.
  Only those were exercised.
- Linux and macOS behaviour. Windows only.

## Known wrinkle

With `CODEX_HOME` under the system temp directory Codex declines to create its
PATH helper binaries — `Refusing to create helper binaries under temporary dir` —
and proceeds anyway, exit 0. Harmless here, but a lane that wants a clean log
should place its home outside `%TEMP%`.
