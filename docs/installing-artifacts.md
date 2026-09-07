# Installing built artifacts

`hooknostic build` emits one self-contained directory per target. It stops there
deliberately: nothing is copied into a harness's configuration, because every
harness gates hook loading behind its own trust and review mechanism and
Hooknostic never touches that state (design §17).

This page documents the remaining step — pointing each harness at the output —
including the case a lot of projects hit first: **a repository that consumes its
own artifacts.**

Paths below assume the example configuration:

```ts
targets: {
  claude:   { version: ">=2.1 <3",   mode: "plugin", output: "./dist/claude" },
  codex:    { version: ">=0.148 <1", mode: "local",  output: "./dist/codex" },
  opencode: { version: ">=1.18 <2",  mode: "local",  output: "./dist/opencode" },
}
```

## What gets emitted

| Target | Artifact | Shape |
| --- | --- | --- |
| `claude` | `dist/claude/` | A complete Claude Code plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `runtime/hooknostic.mjs` |
| `codex` | `dist/codex/.codex/` | A repo-level Codex directory: `hooks.json` + `hooknostic/hooknostic.mjs` |
| `opencode` | `dist/opencode/.opencode/` | A project plugin module: `plugins/hooknostic.js` |

Only the Claude output is a *packaged* artifact. The Codex and OpenCode outputs
are directory trees meant to be copied to a project root — their generated
commands and loader paths are relative to the session's project directory.

## Claude Code

`dist/claude` is a valid plugin directory (`claude plugin validate dist/claude`
passes). Its `hooks/hooks.json` invokes the runtime through
`${CLAUDE_PLUGIN_ROOT}`.

**That placeholder is substituted only when Claude Code loads the directory as a
plugin.** It is *not* defined for hooks declared in `.claude/settings.json`, so
copying the generated `hooks.json` into settings produces a hook that cannot
find its runtime. Pick one of the paths below instead.

### Try it for one session

```bash
claude --plugin-dir ./dist/claude
```

`--plugin-dir` loads a plugin directory for that session only and is repeatable,
which makes it the fastest way to check a fresh build before committing to an
install.

### Install it as a plugin (recommended)

Declare a marketplace that points at the built directory. In the repository
root, `.claude-plugin/marketplace.json`:

```json
{
  "name": "repo-local",
  "owner": { "name": "your-team" },
  "description": "Hooknostic-generated hooks for this repository",
  "plugins": [
    { "name": "portable-repo-hooks", "source": "./dist/claude" }
  ]
}
```

`source` is resolved relative to the marketplace root, and the entry's `name` is
the id you install by — keep it equal to the `name` in
`dist/claude/.claude-plugin/plugin.json` (which comes from your
`definePlugin({ name })`) so the two stay legible together. Then:

```bash
claude plugin marketplace add . --scope project && claude plugin install portable-repo-hooks@repo-local
```

`--scope project` records the marketplace in the repository rather than the
user's global configuration, so collaborators get the same offer.

Copy-mode is safe for these artifacts: everything the hooks need — the manifest,
`hooks/hooks.json`, and the bundled runtime — lives inside `dist/claude`, and a
copied plugin cannot reach files outside its own directory.

### MCP runtime dependencies

Hooknostic bundles hook runtimes, but an MCP server can have ordinary Node.js
dependencies. Configure `agentPlugin.runtimePackage` with a dedicated runtime
manifest and npm lockfile. Claude projection emits those files as
`dist/claude/package.json` and `dist/claude/package-lock.json`; when it creates
the marketplace cache entry, Claude runs its own locked `npm ci --ignore-scripts`.

Keep this manifest separate from the project manifest used to build Hooknostic:
it must contain only MCP runtime dependencies. Do not commit `node_modules` to
the artifact. This path supports pure-JavaScript npm packages. Dependencies that
need lifecycle scripts or native compilation are outside the contract, as are
pnpm and Yarn lockfiles. The behavior is captured for Claude Code 2.1.260 in
[`.capture/claude-marketplace-deps`](../.capture/claude-marketplace-deps/README.md)
and defined in [ADR-0012](decisions/0012-claude-plugin-runtime-dependencies.md).

### Updating an installed plugin

**Installing copies the plugin; it does not run `dist/claude` in place.** Claude
Code copies it into a versioned cache at
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, so a later
`hooknostic build` rewrites the output directory while the installed hooks keep
running the copy made at install time. Publishing a rebuild takes three steps:

```bash
claude plugin marketplace update repo-local && claude plugin update portable-repo-hooks@repo-local
```

and then a Claude Code restart, which is when an update actually takes effect.

**Give the plugin a version and bump it.** Hooknostic writes
`.claude-plugin/plugin.json` from your `definePlugin({ name, version })` (or,
with `agentPlugin` configured, from the Agent Plugin manifest it reads). A
plugin with a pinned `version` is only updated when that field changes, and the
cache path is keyed on it — so a rebuild published under an unchanged version
leaves collaborators on the old hooks with no error to notice. Treat the version
as part of the hook change: bump it whenever hook behavior changes, in the same
commit.

Omitting `version` is not a fix — Claude Code substitutes the resolved commit
SHA only for git-based marketplace sources, which a local path is not. While
iterating on hooks, prefer `--plugin-dir ./dist/claude`, which reads the build
output directly and needs neither a version bump nor a reinstall.

### Wire it by hand from `.claude/settings.json`

If a plugin install is unwanted, declare the hooks in `.claude/settings.json`
yourself using `${CLAUDE_PROJECT_DIR}`, which *does* resolve there:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/dist/claude/runtime/hooknostic.mjs"],
            "timeout": 6
          }
        ]
      }
    ]
  }
}
```

Mirror one entry per native event name in the generated
`dist/claude/hooks/hooks.json`, keeping its `timeout` (seconds). The exec `args`
form and `${CLAUDE_PROJECT_DIR}` both resolve here (verified against Claude Code
2.1.250), and the runtime module is the same one the plugin form uses — only the
wiring differs. This form has to be re-checked whenever the hook set changes,
since nothing regenerates it; the plugin form is the maintainable option.

## Codex CLI

For a repository consuming its own hooks, point `.codex/hooks.json` at the built
artifact instead of copying the tree:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "node dist/codex/.codex/hooknostic/hooknostic.mjs", "timeout": 10 }
        ]
      }
    ]
  }
}
```

The command is relative to the session's project directory. Referencing beats
copying here: there is no second copy of the bundle to go stale, and nothing to
repeat after a rebuild. It also lets you scope each event's timeout, which the
generated manifest cannot — it gives every event the same dispatch budget.

To distribute the artifact to a *different* repository, copy the tree instead:

```bash
cp -r dist/codex/.codex .
```

Codex loads `<git-repo-root>/.codex/hooks.json` **only for trusted projects**,
and prompts once per hook for hook trust. Both are Codex's own review
mechanisms; Hooknostic never writes trust state. In practice that means:

- The project needs `[projects.'<absolute path>'] trust_level = "trusted"` in
  `~/.codex/config.toml`.
- Each hook needs persisted hook trust
  (`[hooks.state.'<path>:<event>:i:j'] trusted_hash = "sha256:…"`), granted by
  accepting the prompt.

Because the trusted hash covers the hook command, re-granting is only needed
when the command itself changes — not on every rebuild of the bundled runtime.

Three things measured on codex-cli 0.151.0 that the obvious reading gets wrong,
each of which can leave a correctly built and correctly wired artifact silently
not running:

- **Codex prints `hook: <Event> Completed` for a hook it skipped.** That line is
  not evidence the hook ran. Verify by effect — did the thing your hook does
  actually happen — never by Codex's own output.
- **Trust is per entry, not per file.** A stale hash on one event does not stop
  another from running, so approving `Stop` says nothing about
  `UserPromptSubmit`. Check for an entry per event you wired.
- **`--dangerously-bypass-hook-trust` did not rescue an entry whose recorded
  hash was stale.** It is accepted and the hook still did not run. (It has been
  observed to work for an entry with *no* recorded trust state on 0.148.0, so
  these may not conflict — but do not rely on the flag to test a modified hook
  config.)

## OpenCode

Output directories are sandboxed strictly below the config directory, so the
build cannot write `<project>/.opencode/` itself. For a repository consuming its
own hooks, bridge to it with a one-line re-export rather than a copy —
`.opencode/plugins/hooknostic.ts`:

```ts
export { HooknosticPlugin } from "../../dist/opencode/.opencode/plugins/hooknostic.js";
```

The loader scans `.opencode/plugins/` for `*.ts` / `*.js`, and a re-export
satisfies it. This is the better shape: one bundle, nothing to re-copy after a
rebuild, and it cannot drift from the artifact. It is also type-checked if you
type-check that directory.

To distribute the artifact to a *different* repository, copy the tree instead:

```bash
cp -r dist/opencode/.opencode .
```

The 1.18 loader scans `.opencode/plugins/` for `*.ts` / `*.js` only, which is
why the artifact is `hooknostic.js` and not `.mjs`. A global install is possible
by copying the same file to `~/.config/opencode/plugins/`, at the cost of
applying it to every project.

## Committing artifacts, or building them

**Commit `dist/`.** That is the default, and the reasoning is in
[ADR-0006](decisions/0006-artifact-distribution.md): the artifact is
dependency-free by design, has to be on disk before a session starts, fails
*silently* when it is missing, and committing is the only arrangement where the
thing you reviewed is the thing that runs — which matters for files that execute
on every session event and can block a shell command. This repository practises
it too: `examples/rewrite-shell` and `examples/agent-plugin` commit their output
and CI rebuilds both and fails on any diff.

Two things to set up alongside it:

- **A drift check.** Rebuild in CI and fail if anything changed — `git status
  --porcelain` rather than `git diff`, so a *new* artifact file is caught as
  well as a changed one. Push it earlier than CI if you can; the person most
  likely to be running a stale artifact is the one who just edited an imported
  module, and CI tells them after they push.
- **`linguist-generated=true`** on the output directory, so review collapses it.
  Not `-diff`, which would hide a hand edit — the drift check is the real
  defence there.

**Building in a setup step** stays supported for a consumer who accepts the
trade: nothing is in history, and until every consumer runs `hooknostic build`
their harness silently runs no hooks.

Either way, keep `hooknostic-build.json` — it records which capability each hook
resolved to per target, and is the first thing to read when a hook behaves
differently across harnesses.

Note that **no target picks a rebuild up on its own** — every harness reads its
hook configuration at session start, so restart it after a build. Output
directories are also sandboxed strictly below the config directory, so `.codex/`
and `.opencode/` cannot be emitted straight to the project root. If you *copy*
the tree there, the copy has to be repeated after every build; the
reference-in-place wiring above avoids that entirely and is why it is the
recommended shape for a repo consuming its own hooks. A marketplace-installed Claude plugin needs the
version bump and update flow above. This is worth a `postbuild` script or a
`justfile` target rather than a line in a README nobody re-reads.

## Agent Plugins layout

With `agentPlugin: { root: ".", targets: ["claude"] }`, the configured Claude
output is a complete native plugin: `.claude-plugin/plugin.json`, copied skills,
translated `.mcp.json`, any Claude-specific overlay, and optional Hooknostic hooks.
Install or reference that output exactly like any other Claude plugin. No generated
files are written beside the portable source components.

Codex and OpenCode package projection are not yet implemented. Their Hooknostic outputs
contain only their local hook integrations. See
[ADR-0011](decisions/0011-agent-plugin-native-projection.md).
