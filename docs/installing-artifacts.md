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

Copy the generated tree to the project root:

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
  accepting the prompt, or `--dangerously-bypass-hook-trust` for throwaway runs.

Because the trusted hash covers the hook command, re-granting is only needed
when the command itself changes — not on every rebuild of the bundled runtime.

## OpenCode

Copy the generated tree to the project root:

```bash
cp -r dist/opencode/.opencode .
```

The 1.18 loader scans `.opencode/plugins/` for `*.ts` / `*.js` only, which is
why the artifact is `hooknostic.js` and not `.mjs`. A global install is possible
by copying the same file to `~/.config/opencode/plugins/`, at the cost of
applying it to every project.

## Committing artifacts, or building them

Both work, and the choice is about review rather than mechanics:

- **Commit `dist/`.** Collaborators and CI get working artifacts with no build
  step, and artifact changes show up in review — which matters, since these
  files run on every session event. The generated bundle is deterministic for a
  given source and configured version range, so diffs stay meaningful.
- **Build in a setup step.** Keeps a large generated bundle out of history.
  Requires every consumer to run `hooknostic build` before the harness starts,
  and the harness silently runs no hooks until they do.

Either way, keep `hooknostic-build.json` — it records which capability each hook
resolved to per target, and is the first thing to read when a hook behaves
differently across harnesses.

Note that **no target picks a rebuild up on its own.** Output directories are
sandboxed strictly below the config directory, so `.codex/` and `.opencode/`
cannot be emitted straight to the project root — the copy step has to be
repeated after every build. A marketplace-installed Claude plugin needs the
version bump and update flow above. This is worth a `postbuild` script or a
`justfile` target rather than a line in a README nobody re-reads.

## Agent Plugins layout

With `agentPlugin: { root: "." }` configured, the Claude artifacts (minus
`.claude-plugin/`) are additionally emitted to `./com.anthropic.claude-code/`,
the Agent Plugins 1.0 client-extension namespace, so a repository that is
already an Agent Plugin carries its hooks in the conventional location rather
than a Hooknostic-specific one. See
[Decision 0004](decisions/0004-agent-plugins-relationship.md) for the boundary: Hooknostic
consumes a `plugin.json` for metadata and never writes one.
