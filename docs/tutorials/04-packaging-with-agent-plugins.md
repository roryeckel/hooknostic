# Tutorial 4 — Packages and marketplaces

**Example:** [`examples/agent-plugin`](../../examples/agent-plugin/) ·
**You'll learn:** one Agent Plugins 1.0 package with hooks, skills, and a bundled MCP
server, installed through Claude and Codex marketplaces or loaded by OpenCode.

[Agent Plugins 1.0](https://agent-plugins.org/specification) standardizes the manifest,
Agent Skills, MCP servers, and namespaced client extensions. Hooknostic reads that source
unchanged and translates it to each harness's native layout. Portable TypeScript hooks
are optional; they complement the standard, whose v1 portable components exclude hooks.

## Build the existing example

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/hooknostic.mjs check --config examples/agent-plugin/hooknostic.config.ts
node packages/cli/bin/hooknostic.mjs build --config examples/agent-plugin/hooknostic.config.ts
```

```text
examples/agent-plugin/
├── plugin.json
├── skills/greet/SKILL.md
├── mcp.json
├── src/hooks.ts
├── src/greet-mcp.mjs
├── build/bundle-mcp.mjs
├── hooknostic.config.ts
└── dist/
    ├── claude/          # native Claude plugin
    ├── codex/           # native Codex plugin
    ├── opencode/        # OpenCode v2 package
    └── opencode-v1/     # explicit legacy family
```

The checked-in configuration selects package delivery for each target. The source
`mcp.json` refers to `${PLUGIN_ROOT}/bundled/greet-mcp.mjs`. An author-owned
`components.materialize` provider bundles the MCP implementation and its npm dependencies
once, then Hooknostic places the same bytes in every output. Consumers need Node but
no npm install, source checkout, or compiler. The default component policy stays strict. Marketplace registration files are excluded
from native packages; rebuilding after registration does not copy those files into a plugin.

`check` executes the same trusted provider and validates projection without writing
target artifacts. Read the provider like any build script. See
[materialization](../installing-artifacts.md#build-time-package-materialization).

The default `opencode` target uses v2; `legacy` names an explicit v1 target with
`adapter: "opencode"`. Both outputs are packages, with distinct native loaders.
Install only the output matching your harness family. See [OpenCode families](../opencode-families.md).

## Install through a marketplace

From here, run commands in `examples/agent-plugin`. The example includes the marketplace documents
below. They register native output, not the portable source root.
Do not add both portable and native manifests to one installed Codex output: the
portable manifest takes precedence and suppresses hooks in the captured versions.

### Claude Code

The included `.claude-plugin/marketplace.json`:

```json
{
  "name": "hooknostic-example",
  "owner": { "name": "Hooknostic contributors" },
  "plugins": [
    { "name": "combined-example", "source": "./dist/claude" }
  ]
}
```

```sh
claude plugin marketplace add .
claude plugin install combined-example@hooknostic-example
```

For a temporary single-session preview, `claude --plugin-dir ./dist/claude` loads the
same package without a marketplace installation. A preview does not establish the
marketplace install path; the local verification gate below tests an actual install.

### Codex CLI

The included `.agents/plugins/marketplace.json`:

```json
{
  "name": "hooknostic-example",
  "owner": { "name": "Hooknostic contributors" },
  "plugins": [
    { "name": "combined-example", "version": "1.0.0", "source": "./dist/codex" }
  ]
}
```

```sh
codex plugin marketplace add .
codex plugin add combined-example@hooknostic-example
```

The qualified name is required. The native Codex artifact combines its manifest,
`hooks.json`, skills, and native MCP declarations in one installed plugin. Package
hook delivery uses `>=0.153 <1`; the older project reference alone does not verify
marketplace behavior. Review normal harness trust prompts and restart the session.

Both marketplace installations use cached copies. Building again does not update an
installed copy automatically. These instructions register a local marketplace; publishing
or submitting a listing to someone else's marketplace remains a separate author step.

### Verify what actually loaded

Start a fresh session in an unrelated scratch repository, then:

1. Ask for the `greet` skill (use the harness's discovered qualified name). Its instructions
   say to greet you and summarize `git status --short`.
2. Ask the `greeter` MCP server's `greet` tool to greet `friend`. Expect `Hello, friend!`.
3. Ask to run `echo HOOKNOSTIC_BLOCK_PROBE`. Expect **Hooknostic marketplace probe blocked.**
   The command is harmless if the hook failed to load.

A successful installation message alone is insufficient. Check each observable effect.
The [local marketplace gate](../testing.md#marketplace-release-gates) repeats installation
and checks model-visible skill discovery, an MCP response, and the hook denial against a
loopback model server. It uses isolated harness state and no model credits.

### Updates

Increment the portable `plugin.json` version and rebuild. For Codex, update the marketplace
entry version to match. Use the harness's installed-plugin update mechanism; the
[installation guide](../installing-artifacts.md#updating-an-installed-plugin) covers
Claude's cache/version behavior. To repeat this local demonstration from a known state,
remove and add the package again:

```sh
claude plugin uninstall combined-example@hooknostic-example
claude plugin install combined-example@hooknostic-example
codex plugin remove combined-example@hooknostic-example
codex plugin add combined-example@hooknostic-example
```

Restart affected sessions and repeat all three checks. Keep the marketplace definition
pointing to the rebuilt native output. Retain normal approval and trust review.

## OpenCode package delivery

For v2, set `opencode.json` to `{ "plugins": ["/absolute/path/to/dist/opencode"] }`.
For v1, use `{ "plugin": ["./dist/opencode-v1"] }` from the example root. Follow the family-specific [installation guide](../installing-artifacts.md#opencode)
and [version-family guide](../opencode-families.md). The v1 `exports["./server"]` entry
and the v2 default plugin definition are different contracts; do not exchange their output.
Neither output needs the example's workspace dependencies at runtime.

## Advanced: Claude installs locked npm dependencies

The example retains `runtime/package.json` and `runtime/package-lock.json` to illustrate
Claude's separate `runtimePackage` contract. To try that alternative in a copy of the
example: select only Claude, remove `components.materialize` and the `runtime/**`
exclusion, change the MCP argument back to `${PLUGIN_ROOT}/src/greet-mcp.mjs`, and add:

```ts
runtimePackage: {
  manifest: "./runtime/package.json",
  lockfile: "./runtime/package-lock.json",
}
```

On captured Claude marketplace installations, the harness installs the locked production
dependencies in its cache with scripts disabled. The manifest and lockfile must agree;
packages that require install scripts are outside this contract. This route is not
available on Codex or OpenCode: an `onUnsupported: "warn"` build can omit the installation
component and still exit successfully, leaving an unbundled server unable to start.
The common walkthrough avoids that dependency by bundling. See
[the npm contract](../installing-artifacts.md#the-npm-case) for validation and supported inputs.

## Hook files inside a package

`defineConfig` checks target names and requires hooks or components. A hook reaches its
package files through `ctx.plugin.root`, the same logical root used by MCP's
`${PLUGIN_ROOT}`. For OpenCode this is the nested `package/` directory. Component support,
omissions, deviations, and accepted exceptions are recorded in `hooknostic-build.json`.

## What ships

Copied files use portable permissions: 0644 by default. Set
`components.executableFiles: ["bin/tool"]` for files that must be 0755.
These are exact, case-sensitive POSIX paths relative to `components.root`,
not globs; each must name an included file. Host `chmod` bits are ignored.
Direct skill sources take the same declaration spelled `<skill>/<path>`; see
[project integration](../project-integration.md).
When migrating, declare files that previously relied on `chmod +x` and rebuild
both artifacts and reports. See [ADR-0013](../decisions/0013-portable-file-permissions.md).

Everything under `root` ships unless it is excluded, npm-style. Built-in exclusions
cover what is never package content: `.git`, `node_modules`, `.env`, `.env.*`, and
`.npmrc` at any depth, plus `hooknostic.config.ts`, the hook `entry` (its compiled
runtime ships instead), every target output, the build report, and staging directories.
`components.exclude` adds POSIX globs on top. The build report's
`components.sourceFiles` lists every inventoried path, so check it after adding files.

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
  components: { root: ".", targets: ["claude"] },
  targets: {
    claude: { version: ">=2.1 <3", delivery: "package", output: "./dist/claude" },
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

Claude also expands `${NAME}` and `${NAME:-default}` anywhere else in a server
when that variable is set in its environment: the stdio command, args, env
values and cwd, and remote URLs and header values
([capture](../../.capture/agent-plugin-mcp-placeholders/README.md)). Agent
Plugins 1.0 requires that text to stay literal, and Codex and OpenCode keep it
literal. The projection keeps Claude's native declaration, still emits the
server, and reports it as the `claude:mcp-environment-expansion` deviation,
`HN106` ([ADR-0019](../decisions/0019-agent-plugin-spec-deviations.md)). So
`Bearer ${API_KEY}` works on Claude and reaches Codex as literal text. On Codex,
forward a variable a stdio server reads with `components.mcpEnvironment`
([ADR-0018](../decisions/0018-packaged-mcp-environment.md)).

A deviation warns by default. Set `components.onDeviation: "error"` for strict
mode: `check` and `build` then fail rather than ship a package that behaves
outside the specification on some target. `hooknostic inspect <target>
--component <id>` lists the deviations each adapter declares.

OpenCode lists every installed plugin's skills in one namespace, so the OpenCode
package names each skill for its plugin: a `review` skill in `my-tools` is
`my-tools-review` there, while Claude and Codex show `my-tools:review`
([ADR-0021](../decisions/0021-opencode-skill-names.md)). A skill that cannot be
renamed, such as one whose qualified name would pass 64 characters, keeps its
name and fails the build as the `opencode:skill-name-unqualified` degradation.
Rename the skill, set `components.onDegraded: "warn"`, or accept that one id:

```ts
components: {
  root: ".",
  accept: ["opencode:skill-name-unqualified"],
},
```

To keep every skill's authored name on OpenCode instead, and accept that another
plugin's skill of the same name can hide it, set `skillNames: "authored"` on the
`opencode` target.

`accept` works the same way for a deviation you have reviewed. Accepted items
are still reported, as information
([ADR-0022](../decisions/0022-shortfall-policy.md)).

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
  package. In a package, placeholder-like command text remains literal; direct
  project sources reject command placeholders because they do not expand them;
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
