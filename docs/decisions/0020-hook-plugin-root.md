# ADR-0020: A hook finds its own package through `ctx.plugin.root`

## Status

Accepted, 2026-09-22.

## Context

A hook that ships inside an Agent Plugin package often needs a file beside it:
a script it runs, a data file it reads, the same helper its MCP server uses. It
needs the absolute path of the package root to reach one, and the portable
contract offered no way to get it. What each harness provides differs, and only
part of it is established:

- Claude documents `CLAUDE_PLUGIN_ROOT` as exported to hook subprocesses
  (`docs/baseline-2026-08-20.md`, doc-derived).
- Codex expands `${PLUGIN_ROOT}` in a plugin hook's *command*
  (`.capture/codex-plugin-hooks`). No capture records whether it also exports
  it to the process, and its native MCP route binds neither `PLUGIN_ROOT` nor
  `PLUGIN_DATA` (`.capture/codex-native-mcp`).
- OpenCode binds neither, and imports the hook module in-process.
- Project delivery installs nothing, so there is no install root for a harness
  to name at all.

A consumer porting hooks onto Hooknostic worked around this in its own code:
read `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT` when set, otherwise walk up from the
runtime file to the first directory holding a plugin manifest. That is a
harness-shape guess on one side and a layout guess on the other, and every
consumer would have to repeat it.

Hooknostic already solved the same problem for MCP servers. The self-resolving
launcher (ADR-0011, tenth amendment) finds the root from its own
`import.meta.url` plus an offset fixed at build time, because the build placed
both the launcher and the package.

## Decision

`HookContext` gains an optional `plugin: { root: string }`.

**Where it points.** `ctx.plugin.root` is the directory this target's MCP
servers see as `${PLUGIN_ROOT}`. Under package delivery that is the projected
package: the target output on Claude and Codex, and its nested `package/`
directory on OpenCode. Under project delivery it is the source package in the
repository, which project delivery references in place rather than copying.

**When it is present.** Exactly when the build has a `components.root` package
for the executing target. A hooks-only build, and a build using direct
component sources (`components.skills` / `components.mcp`), have no package
root. There `ctx.plugin` is absent rather than filled with a directory that
contains nothing the author put there.

**How it is found.** The runtime resolves it from its own location. Each adapter
declares where `compile()` writes the hook runtime for each delivery
(`hookRuntimePath`), and a projector declares where package files land in its
output (`packageRoot`, default `"."`). The build turns those into a relative
offset. The generated entry resolves that offset against its `import.meta.url`
and hands the absolute path to the shim, which passes it to dispatch. No
harness variable is read. The value does not depend on any of the uncaptured
facts above, and it agrees with the MCP launcher because both use the same
derivation. The adapter contract suite checks `hookRuntimePath` against what
`compile()` actually emits, so the declaration cannot drift from the layout.

**What it is not.**

- It is not a capability. Every target that has a package root can supply it,
  so there is nothing to rate or feature-detect. The `plugin` object's presence
  already carries that information.
- It is not the data directory. `PLUGIN_DATA` is persistent state, and ADR-0002
  requires any storage API to work identically on subprocess and
  persistent-module targets before it ships. A path to writable state invites
  use without the locking and concurrency story that clause asks for, so it
  waits for its own decision.

## Consequences

- Hook authors reach package files as `join(ctx.plugin.root, "scripts/x.sh")`
  on every target and delivery, with no harness detection.
- Each hook receives its own copy of the object, as with `harness`, so a
  handler that mutates it does not move the root under later hooks.
- A new adapter that wants to offer `ctx.plugin` implements `hookRuntimePath`,
  and `packageRoot` if its projection nests the package. An adapter that
  declares neither simply offers no `ctx.plugin`.
- If Agent Plugins later defines a plugin-root value for hooks, adopting it
  changes nothing for authors: `ctx.plugin.root` already names the same
  directory `${PLUGIN_ROOT}` does.
- Generated runtimes for packages with components now embed one relative path
  and a two-line resolver. Hooks-only runtimes are unchanged apart from dispatch
  forwarding an absent field.
