# Tutorial 4 — Projecting an Agent Plugin

**Example:** [`examples/agent-plugin`](../../examples/agent-plugin/) ·
**You'll learn:** compiling an Agent Plugins 1.0 package into a complete Claude Code
plugin, with or without Hooknostic hooks.

[Agent Plugins](https://agent-plugins.org/specification) standardizes a portable
manifest, Agent Skills, MCP servers, and namespaced client extensions. Hooknostic reads
that package as input and asks a harness adapter to project its components into the
harness's native plugin layout. The portable package stays unchanged.

## Combined package layout

```text
examples/agent-plugin/
├── plugin.json
├── mcp.json
├── runtime/
│   ├── package.json
│   └── package-lock.json
├── skills/greet/SKILL.md
├── hooknostic.config.ts
├── src/
│   ├── greet-mcp.mjs
│   └── hooks.ts
└── dist/
    ├── claude/                 ← complete Claude plugin: package + native hooks
    ├── codex/                  ← Hooknostic local-hook artifact only
    └── opencode/               ← Hooknostic local-hook artifact only
```

The projection is explicit:

```ts
import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  entry: "./src/hooks.ts",
  targets: {
    claude: { version: ">=2.1 <3", mode: "plugin", output: "./dist/claude" },
    codex: { version: ">=0.148 <1", mode: "local", output: "./dist/codex" },
    opencode: { version: ">=1.18 <2", mode: "local", output: "./dist/opencode" },
  },
  agentPlugin: {
    root: ".",
    targets: ["claude"],
    runtimePackage: {
      manifest: "./runtime/package.json",
      lockfile: "./runtime/package-lock.json",
    },
  },
});
```

The portable `mcp.json` declares a local `greeter` server. Its `greet` tool is
implemented with the official MCP TypeScript SDK in `src/greet-mcp.mjs` and served over
stdio. `${PLUGIN_ROOT}` keeps the entry path portable; projection translates it to the
native plugin-root variable.

`defineConfig` infers the target names, so `agentPlugin.targets` naming a target that
is not configured, or a config with neither `entry` nor `agentPlugin`, is an editor
error before it is a build error.

The source package's `package.json` is for building this example. `runtimePackage`
keeps the MCP server's production dependencies separate: Claude projection writes the
configured manifest and npm lockfile as `dist/claude/package.json` and
`dist/claude/package-lock.json`. On marketplace installation, Claude runs the locked,
script-free npm install in its cached plugin copy. This contract supports pure-JavaScript
npm dependencies; packages that need lifecycle scripts are not supported, and a lockfile
entry declaring `hasInstallScript` fails `check` rather than installing unbuilt on the
user's machine. (Verified a package that works without its script anyway? Name it in
`runtimePackage.allowInstallScripts`; the script still never runs.) The pair is otherwise
validated at build time the way `npm ci` would validate it: the manifest declares only
`dependencies` with registry ranges, dist-tags, tarball URLs, or git specs (no `file:` or
`workspace:`); the lockfile must be an npm `package-lock.json` (v2 or v3, not a pnpm or
Yarn lock), its root entry must declare exactly the manifest's dependencies, every
dependency must be locked at a version and resolution that satisfies its spec under npm's
rules, and the locked graph must be complete down to the last transitive dependency.
Regenerate the lockfile from the manifest whenever you change either; a hand-edited lock
fails `check` with the same message `npm ci` would have given the user.

This example projects into `claude` only, so `codex` and `opencode` receive just their
local hook artifacts. Codex can also receive a package, and what it gets is a *native*
plugin rather than the portable one: it does read a portable package, but a portable
manifest cannot carry hooks and outranks the `.codex-plugin/plugin.json` that can, so a
package declaring both loads its skills and silently ignores every hook. The projection
therefore replaces `plugin.json` and `mcp.json` with native equivalents and emits the
compiled hooks alongside them. Add it with:

```ts
agentPlugin: { root: ".", targets: ["claude", "codex"], onUnsupported: "warn" },
targets: {
  codex: { version: ">=0.153 <1", mode: "plugin", output: "./dist/codex" },
},
```

The version narrows too: hook delivery from an installed plugin is only established
from 0.153, so `mode: "plugin"` is rejected below it, while the local artifact above
still builds from 0.148. `onUnsupported: "warn"` is what this example would
additionally need, because its `runtimePackage` has no Codex equivalent — see
[harness support](../harness-support.md) for the per-component table.

Claude's projection is a different translation of the same package: `.claude-plugin/`,
a rewritten `.mcp.json`, a generated cwd launcher. Neither output is portable, and that
is the point — the *source* is the portable artifact.

Listing a target under `agentPlugin.targets` whose adapter has no projector at all is a
different error, and not one `onUnsupported` degrades: a projection that cannot happen
is a configuration mistake, not a component to degrade.

## What ships

Copied files use portable permissions: 0644 by default. Set
`agentPlugin.executableFiles: ["bin/tool"]` for files that must be 0755.
These are exact, case-sensitive POSIX paths relative to `agentPlugin.root`,
not globs; each must name an included file. Host `chmod` bits are ignored.
When migrating, declare files that previously relied on `chmod +x` and rebuild
both artifacts and reports. See [ADR-0013](../decisions/0013-portable-file-permissions.md).

Everything under `root` ships unless it is excluded, npm-style. Built-in exclusions
cover what is never package content: `.git`, `node_modules`, `.env`, `.env.*`, and
`.npmrc` at any depth, plus `hooknostic.config.ts`, the hook `entry` (its compiled
runtime ships instead), every target output, the build report, and staging directories.
`agentPlugin.exclude` adds POSIX globs on top. The build report's
`agentPlugin.sourceFiles` lists every inventoried path, so check it after adding files.

Claude projection omits root `package.json`, `package-lock.json`, and
`npm-shrinkwrap.json` files; only the validated `runtimePackage` pair becomes
install input. These files in a Claude client extension follow `onUnsupported`
(error by default, omitted with a warning under `"warn"`).

Exclusions apply before discovery and packaging. Excluding `mcp.json`, a skill
directory, or its required `SKILL.md` removes that component without an unsupported
component warning; excluding an auxiliary skill file keeps the skill and omits only
that file. The mandatory `plugin.json` cannot be excluded.

## Hookless packages

`entry` is optional. A skills-only or MCP-only package can use:

```ts
import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  agentPlugin: { root: ".", targets: ["claude"] },
  targets: {
    claude: { version: ">=2.1 <3", mode: "plugin", output: "./dist/claude" },
  },
});
```

Hooknostic does not bundle a runtime in this mode. It copies the distributable package,
converts `plugin.json` to `.claude-plugin/plugin.json`, copies valid `skills/` trees,
and converts `mcp.json` to `.mcp.json`.

## Claude-specific overlays

Files under `com.anthropic.claude-code/` are consumed as an overlay and appear at the
root of the emitted Claude plugin. Ordinary overlay files replace their portable-base
counterpart. Manifests, MCP server maps, and hook maps are merged structurally:

- portable identity metadata wins;
- extension-only Claude manifest fields remain;
- duplicate MCP server names fail with `HN503`;
- existing native hooks run first, followed by Hooknostic's dispatcher;
- collisions with Hooknostic's reserved runtime path fail with `HN503`.

Claude requires a non-empty `author.name` when author metadata is present.
A portable author containing only an email or URL fails projection with `HN205`.
Supply a name, or set `onUnsupported: "warn"` to omit the whole author object;
the build report records that omission. The portable source stays unchanged.

Agent Plugin MCP placeholders in arguments, environment values, and working directories
become Claude's persistent variables: `${PLUGIN_ROOT}` → `${CLAUDE_PLUGIN_ROOT}` and
`${PLUGIN_DATA}` → `${CLAUDE_PLUGIN_DATA}`. A stdio command must be a bare executable or
start with `./`; the latter becomes a Claude plugin-root command. Streamable HTTP becomes
Claude's native `http` transport; SSE, literal URLs, and literal headers are preserved.

For stdio servers, `cwd: "./"` selects the installed plugin root and
`cwd: "./worker"` selects its `worker` subdirectory. Omitted cwd defaults to the
plugin root. A `cwd` that climbs out of the directory it is anchored on is
omitted with `HN205` rather than emitted. A `./`-relative command resolves
against the plugin root, not against `cwd`.

**Every target emits a Node launcher, and Node must be on PATH** — including for
a server whose own command is `python`, `deno`, or a native binary. The launcher
preserves the server's arguments, environment, stdio, and exit status; Windows
npm command shims such as `npx.cmd` are supported, with command resolution and
argument escaping bundled in, so the installed plugin needs no separate
dependency. Its generated paths cannot collide with package content.

The reason differs by harness:

- **Claude** ignores the native MCP cwd field on the
  [probed version](../../.capture/claude-mcp-cwd/README.md), so the launcher
  establishes the working directory. Claude itself expands both placeholders and
  binds `PLUGIN_ROOT` and `PLUGIN_DATA`, the latter to its own
  `${CLAUDE_PLUGIN_DATA}` — a directory Claude manages and preserves across
  plugin updates.
- **Codex and OpenCode** implement none of the placeholder contract and bind
  neither variable, so the launcher supplies all of it: it resolves the plugin
  root from its own location, expands `args`, `env` values and `cwd`, and binds
  both variables before spawning. Each stdio server registers as
  `node <launcher> <index>`, indexing a generated `mcp-servers.json` that carries
  the portable declaration verbatim.

Because neither harness offers a data directory, Hooknostic supplies one at
`~/.hooknostic/plugin-data/<plugin-name>/`. It sits outside the install root
deliberately — Codex installs into a version-scoped directory, so anything
within it would be discarded on upgrade. Two consequences worth knowing:

- **Plugins are keyed by name alone.** Agent Plugins 1.0 defines no publisher or
  marketplace field, so two same-named plugins from different marketplaces share
  one data directory.
- **This is why the level is `emulated` rather than `exact`.** The directory is
  chosen by Hooknostic, not by the harness, so a different client — including a
  future Codex that implements the contract natively — will not find the data.
  The launcher defers when the client already sets a matching `PLUGIN_ROOT` and
  an absolute `PLUGIN_DATA`, so such a harness keeps ownership of its own
  directory rather than being silently overridden.

## Unsupported and invalid components

Invalid package structure is always `HN503`. A bad root manifest is fatal. An invalid
individual skill or MCP server is skipped by the loader, and that skip fails the build by
default: a component you wrote that will silently not ship is an authoring mistake, not
something to recover from. Use `onInvalid: "warn"` to keep the loader's lenient
skip-and-continue and exit 0 with the warning recorded. A valid component the target
cannot represent is `HN205`. The default is an error; use `onUnsupported: "warn"` to omit
only that component and record the omission in build-report schema v2.

Hooknostic is deliberately stricter than the shipped Agent Plugins JSON schemas. The
schemas are the specification's own and accept any non-empty URL or command; the loader
additionally requires that:

- a remote MCP `url` is `https:`, or `http:` to `localhost`, `127.*`, or `::1` only, with
  no credentials or fragment;
- a stdio `command` is a bare executable name or a `./`-relative path contained in the
  package, and contains no `${...}` placeholder;
- `env` does not set the reserved `PLUGIN_ROOT` or `PLUGIN_DATA` keys;
- any non-excluded symlink that resolves outside the package root rejects the whole
  package before component contents are parsed.

A package that passes a generic schema validator can therefore still fail here. The
rules live in `packages/agent-plugin/src/load.ts`.

`hooknostic check` runs the entire pipeline — bundling, projection, overlay merging,
runtime package validation — and stops before writing, so anything `build` would reject
fails `check` first:

```bash
cd examples/agent-plugin && node ../../packages/cli/bin/hooknostic.mjs check
```

```bash
cd examples/agent-plugin && node ../../packages/cli/bin/hooknostic.mjs build
```

```bash
cd examples/agent-plugin && claude plugin validate --strict dist/claude
```

See [ADR-0011](../decisions/0011-agent-plugin-native-projection.md) for the architectural
boundary and [Installing built output](../installing-artifacts.md) for installation.
