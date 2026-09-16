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
  claude:   { version: ">=2.1 <3",   delivery: "package", output: "./dist/claude" },
  codex:    { version: ">=0.148 <1", delivery: "project",  output: "./dist/codex" },
  opencode: { version: ">=1.18 <2",  delivery: "project",  output: "./dist/opencode" },
}
```

## What gets emitted

| Target | Mode | Artifact | Shape |
| --- | --- | --- | --- |
| `claude` | `plugin` | `dist/claude/` | A Claude Code plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `runtime/hooknostic.mjs` |
| `codex` | `local` | `dist/codex/.codex/` | A repo-level Codex directory: `hooks.json` + `hooknostic/hooknostic.mjs` |
| `codex` | `plugin` | `dist/codex/` | A native Codex plugin: `.codex-plugin/plugin.json`, `.mcp.json`, `skills/`, `hooks.json`, runtime |
| `opencode` | `local` | `dist/opencode/.opencode/` | Project plugin modules under `plugins/`, plus a copied `skills/` |

The `local` outputs are directory trees copied to a project root — their generated
commands and loader paths resolve against the session's project directory. The
`plugin` outputs are installed instead, and their paths resolve against the
install cache.

### Scope: packages are user-level, trees are per-project

This is the first thing to settle when choosing between them, and it is a
property of the harnesses, not of Hooknostic.

**OpenCode is the exception, and it is the whole exception.** Its project plugins
live in `.opencode/plugins/`, read from the project directory with no install
step, and even `opencode plugin <module>` takes `--global` with `default: false`.
The rest of this section is about the other two.

**Neither Claude nor Codex installs a plugin per project.** `codex plugin add` writes
`[marketplaces.*]` and `[plugins."<name>@<marketplace>"]` into
`~/.codex/config.toml` and caches the package under `~/.codex/plugins/cache/`;
its binary carries the string `repository-scoped plugin migration is not
allowed`. Claude keeps plugin content in a user-level marketplace cache, where
only *enablement* is settable per project. So anything a package ships — every
skill, every MCP server — is offered in **every** session on that machine, and
an installed skill is observable from an unrelated directory
(`.capture/codex-plugin-hooks`).

The repo-level trees are the opposite: `.codex/hooks.json` and
`.opencode/plugins/` are read relative to the session's project directory and
apply nowhere else.

**A package may also be unnecessary for skills.** Codex discovers
`.agents/skills/` and OpenCode discovers `.agents/skills/`, `.claude/skills/`,
`.opencode/skill/` and `.opencode/skills/`, each project-scoped and with no
install step. A project that already keeps skills in one of those directories
gets them in those harnesses for free, and packaging buys distribution to other
machines rather than local capability. Weigh that before adding a projection
target — the package is for *shipping* a plugin, not for wiring up a repository.

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

Hooknostic bundles hook runtimes, but an MCP server has dependencies of its own,
in whatever language it is written. Declare them with `components.runtime`, one
entry per ecosystem, each naming how they reach the machine that runs the
server — see [ADR-0017](decisions/0017-mcp-runtime-dependencies.md) for the rule
that decides which options an ecosystem has.

| Delivery | Who installs | Available to |
| --- | --- | --- |
| `harness-installed` | the harness, in its own cache | npm, on Claude only |
| `build-materialized` | Hooknostic, at build time, committed into the package | any ecosystem whose installed output is the same bytes everywhere |
| `author-supplied` | nobody — it is already in the package | every ecosystem |

A Python server whose dependencies are pure wheels declares:

```ts
components: {
  root: ".",
  runtime: [
    {
      ecosystem: "pypi",
      delivery: "build-materialized",
      lockfile: "./runtime/requirements.txt",
      into: "runtime/pypi",
    },
  ],
}
```

`runtime/requirements.txt` is a hash-pinned lock — `uv pip compile
--generate-hashes` produces one. At build time Hooknostic runs the install with
`--require-hashes` and `--only-binary=:all:` (that second flag is this
ecosystem's `--ignore-scripts`: a source distribution executes its setup code at
install time and a wheel does not), then **verifies the result is
platform-independent before committing it**. A distribution carrying a compiled
extension is refused with the file named, because an artifact built once and
installed anywhere (ADR-0006) cannot contain one platform's binary. The
installer's own console-script launchers are dropped for the same reason.

Point the server at the tree from `mcp.json`, where `${PLUGIN_ROOT}` already
expands in `env` values:

```json
{ "command": "python3", "args": ["${PLUGIN_ROOT}/server.py"],
  "env": { "PYTHONPATH": "${PLUGIN_ROOT}/runtime/pypi" } }
```

A Rust or Go server cannot use `build-materialized`, because its build output is
one native binary per target triple. It ships the binaries itself as ordinary
package content — declared in `components.executableFiles` so they arrive
executable — or is declared as a runner command such as `docker`. `cargo` and
`golang` are listed in the provider table with that reason, so a build says so
rather than reporting an unknown ecosystem.

#### The npm case

`components.runtimePackage` is the shorthand for `npm` + `harness-installed`,
and still works. Configure it with a dedicated runtime manifest and npm
lockfile. Claude projection emits those files as
`dist/claude/package.json` and `dist/claude/package-lock.json`; when it creates
the marketplace cache entry, Claude runs its own locked `npm ci --ignore-scripts`.

Keep this manifest separate from the project manifest used to build Hooknostic:
it must contain only MCP runtime dependencies. Do not commit `node_modules` to
the artifact. This path supports pure-JavaScript npm packages, and only Claude
honours it — no other harness installs anything. Dependencies that
need lifecycle scripts or native compilation are outside the contract, as are
pnpm and Yarn lockfiles. A dependency whose lockfile entry declares
`hasInstallScript` fails `check`: Claude's install skips lifecycle scripts
rather than refusing them, so the package would install unbuilt and fail when
the plugin imports it. If you have verified a package works without its script,
name it in `components.runtimePackage.allowInstallScripts` — that records your
judgement, it does not make the script run. The behavior is captured for Claude Code 2.1.260 in
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
with `components` configured, from the Agent Plugin manifest it reads). A
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

What the build emits depends on the target's `delivery`, and the two install
completely differently.

### `delivery: "package"` — an npm package

The output directory *is* an npm package: a `package.json` declaring
`exports["./server"]`, an `index.js` entry, and the compiled modules beside it.
OpenCode loads exactly the module that condition names. Install it by naming the
directory in the project's `opencode.json`:

```json
{ "plugin": ["./path/to/dist/opencode"] }
```

The path needs no registry publication — a local directory is enough.

**Bundle the dependencies.** Nothing installs them for you on this route: a
local-path package's declared `dependencies` are *not* installed, measured on
1.18.30 — a package declaring one loaded fine and then failed to resolve it.

Vendoring is not an alternative here, even though OpenCode itself would accept
it. Ordinary Node resolution does apply at runtime, so a `node_modules` beside
the module resolves; but Hooknostic never inventories `node_modules`, at any
depth, so one placed in the source package is stripped and never reaches the
output ([`load.ts`](../packages/agent-plugin/src/load.ts),
`AGENT_PLUGIN_DEFAULT_EXCLUDED_NAMES`). Following that route leaves an MCP
server's imports unresolved with no build error.

### Publishing it, and installing by name

The third route is publication. `npm publish` the output directory, then
consumers run `opencode plugin <name>`; the package is fetched on first load
into `<cache>/opencode/packages/<name>@latest/node_modules/<name>/` and read
through `exports["./server"]`. Skills and MCP servers arrive with it, resolving
their own assets at that cache location.

**Name the package with `npmName`.** Scoped coordinates work on this route, and
an Agent Plugins manifest name cannot be one — `@` and `/` are outside the
grammar the specification permits — so the target declares it instead:

```ts
opencode: {
  version: ">=1.18 <2",
  delivery: "package",
  output: "./dist/opencode",
  npmName: "@acme/my-plugin-opencode",
},
```

It is per target rather than per plugin because each target's output is a
different npm package: an OpenCode package and a plugin directory are not
interchangeable contents, so publishing two means two coordinates. Suffixing the
harness keeps a plugin's packages together when sorted. Set it on a target whose
output carries no npm manifest and the build refuses it rather than leaving a
setting that quietly does nothing.

**This is the only OpenCode route that installs a dependency closure.** A
published package's declared `dependencies` do resolve, unlike on the local-path
route above. That does not make `components.runtimePackage` work here — the
route reads the package's own generated manifest, not the separate runtime
manifest that component supplies — and bundling remains the recommendation,
because it is the only thing that works on all three OpenCode routes and on all
three harnesses.

> **An installed plugin does not follow new publications.** The cache directory
> is named `@latest`, but it pins the exact version resolved at first load.
> Publishing a new version changes nothing for existing consumers, and
> `opencode plugin <name> --force` — documented as "replace existing plugin
> version" — did not move an installed 1.0.0 to a published 1.0.1. Deleting
> `<cache>/opencode/packages/<name>@latest` did. Unlike Claude and Codex, where
> bumping the version is the whole update story, here it is not enough.

Measured on 1.18.30; see `.capture/opencode-npm-publish` and
`.capture/opencode-plugin-routes`.

**A relative path is relative to the config file, not to you.** An entry in a
`plugin` array resolves against the directory of the `opencode.json` that
declares it. In the root `opencode.json` above, `./path/to/dist/opencode` is
therefore project-root relative and means what it looks like. Upstream considers
this intended and closed a report of it as such
([#28384](https://github.com/anomalyco/opencode/issues/28384)), so it is a rule
to write against rather than a bug to wait out.

> **Do not install this with `opencode plugin <relative-path>`.** That command
> writes your argument into `.opencode/opencode.json` without rewriting it for
> that file's directory, so a path given from the project root lands one level
> too deep at `<project>/.opencode/<path>`. The install reports success and the
> plugin silently never loads — a missing plugin directory is dropped with no
> diagnostic ([#48577](https://github.com/anomalyco/opencode/issues/48577)).
> Declare the path in the root `opencode.json` yourself, or pass an absolute
> path. Confirmed on 1.18.30 and 1.18.31, with the relevant upstream code
> unchanged since May 2026; recorded in `.capture/opencode-plugin-routes`.

Two plugins from one repository no longer collide: each package carries its own
name and its own directory, rather than every build writing the same
`.opencode/plugins/hooknostic.js`.

### `delivery: "project"` — a module in the scanned directory

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

With `project: { root: "." }` and `components: { root: ".", targets: ["claude"] }`, the configured Claude
output is a complete native plugin: `.claude-plugin/plugin.json`, copied skills,
translated `.mcp.json`, any Claude-specific overlay, and optional Hooknostic hooks.
Install or reference that output exactly like any other Claude plugin. No generated
files are written beside the portable source components.

Codex gets a **native** plugin, not a filtered portable one. It can read a
portable package — a root `plugin.json` with its schema URL installs, its
`skills/` are discovered and its `mcp.json` servers register — but a portable
manifest cannot carry hooks and *outranks* the one that can. A package declaring
both loads its skills and silently ignores every hook. So the projection removes
the portable `plugin.json` and `mcp.json` and writes native replacements:

```
dist/codex/
├── .codex-plugin/plugin.json   ← name, version, skills, mcpServers, hooks
├── .mcp.json                   ← native MCP shape
├── skills/…                    ← copied
├── hooks.json                  ← compiled hooks
└── hooknostic/hooknostic.mjs   ← the runtime
```

One installed plugin then carries all three components. Use `delivery: "package"`:

```ts
codex: { version: ">=0.153 <1", delivery: "package", output: "./dist/codex" },
```

That range is narrower than the `>=0.148 <1` the local example above uses, and the
build rejects `delivery: "package"` outside it: hook delivery from an installed plugin
is only established from 0.153.

`delivery: "project"` still emits the repo-level `.codex/` tree instead, which is the
right choice for a repository consuming its own hooks — it needs no install and
stays project-scoped.

Two things the native shape changes. Declared MCP headers **survive**, as
`http_headers`, where the portable route drops them — so a server authenticated
by an `Authorization` header works here and does not through a root manifest.
And an `sse` server is **dropped** rather than translated: Codex selects the
transport from `command` vs `url` and ignores the portable `type`, so an
untranslated sse server would register as a `streamable_http` connection to the
same url. It follows `components.onUnsupported` — an error by default, a
recorded omission under `"warn"`.

Install from a marketplace whose `.agents/plugins/marketplace.json` points at the
output, then `codex plugin add`. Remember that this is a **user-level** install:
the plugin's skills and servers are then offered in every session on the machine.

OpenCode needs no install step. Its package projection is an npm package, named
from a project's `opencode.json` `plugin` array — a local directory path is
enough, with no registry publication and nothing copied into the repository. The
compiled hook module and the generated components module sit at the package root
and are both re-exported from the entry `exports["./server"]` names, while the
author's package nests one level down under `package/`, where it cannot collide
with a generated name. It is the only harness of the three whose projection is
project-scoped rather than user-level. See
[ADR-0011](decisions/0011-agent-plugin-native-projection.md).
