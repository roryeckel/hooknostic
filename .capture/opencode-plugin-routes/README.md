# OpenCode plugin routes and dependency resolution

## Question

Hooknostic emits OpenCode output as a `.opencode/plugins/` tree and defers
"npm-package output mode" (`packages/adapter-opencode/src/generate.ts:8`). The
projector calls the result "not an installable unit", and
`agent-plugin.runtime-package` is `unsupported` because "a project plugin is
loaded from disk with no install step".

Three questions follow. Which routes does OpenCode actually offer? Can a plugin
on any of them resolve npm dependencies? And does a route exist that produces a
real installable package?

## Evidence class

Two runs on two builds, recorded separately because they establish different
things by different means. Both are `live-probe`; both are in the adapter
profile's `validatedOn`, which is the authoritative record (ADR-0008) — this
section describes them, it does not own them.

**1.18.30 — route probe.** `opencode` **1.18.30**, **2026-09-15**, native
Windows. Driven through `opencode debug config`, which resolves configuration
and loads plugins without starting a session, so no model was called. This is
the run that established which routes exist, what `exports["./server"]` selects,
how module loading de-duplicates, which specifiers resolve, and the
install-command defect. Everything below is from this run unless a heading says
otherwise.

Every probe ran in a throwaway project. The global configuration was hashed
before and after (`package.json`, `opencode.json`, `bun.lock`) and its
`node_modules` listing diffed: **all unchanged**.

**1.18.31 — playback validation.** `opencode` **1.18.31**, **2026-09-15**,
native Windows, through the offline playback lane
(`HOOKNOSTIC_PLAYBACK=opencode`, `.capture/harness-playback`) against a loopback
model server: no credentials, no spend. This run drives a **real session**, not
`debug config`, and its subject is Hooknostic's own output rather than the
harness's routes — so it establishes what the 1.18.30 run could not, that the
package this projector emits is one of the installable units that run found.
It also re-derives the relative-path resolution rule from a root
`opencode.json`, where the 1.18.30 run saw it from `.opencode/opencode.json`.

Unlike the 1.18.30 probe this one is repeatable on demand and runs in CI, so it
is a standing check rather than a one-off observation.

## Method

A plugin module writes a marker file recording, for each module specifier,
whether `import()` resolved. Findings rest on that marker and on the resolved
`plugin_origins`, not on log lines.

The controls are the substance. A specifier that resolves proves little on its
own: OpenCode is a compiled Bun binary that bundles its own dependency graph, so
a bare import can be satisfied by the harness's internals rather than by any
directory on disk. Each claim below therefore pairs a positive with a negative
that must fail, and every vendored directory is removed and re-probed.

## Observations

### Module resolution from a project plugin

`.opencode/plugins/resolve-probe.js`:

| Specifier | Present in | Result |
|---|---|---|
| `probe-sibling` | `.opencode/plugins/node_modules/` | **resolved** |
| `probe-local-only` | project `node_modules/` | **resolved** |
| `effect`, `fast-check`, `msgpackr`, `@opencode-ai/plugin` | OpenCode's own bundle | resolved |
| `pure-rand` | config dir `node_modules/` **only** | **failed** |
| `kubernetes-types` | config dir `node_modules/` **only** | **failed** |
| `is-number` | nowhere | failed |

**The OpenCode config directory's `node_modules` is not on a plugin's resolution
path.** `pure-rand` and `kubernetes-types` are physically present there and both
fail; the specifiers that resolve are ones OpenCode bundles into its binary.
An earlier reading of that directory's populated closure as a dependency route
was wrong, and this is the probe that falsifies it.

**Ordinary Node resolution applies, so dependencies vendored beside a plugin
work.** `.opencode/plugins/node_modules/` resolves, with no install step.

**Hazard worth recording:** a plugin can import `effect`, `zod` or `msgpackr`
and succeed only because OpenCode bundles them. Such a dependency is invisible,
unversioned, and breaks when the harness changes its own graph.

### The routes

| Route | Declared by | Loads | Installs the plugin's own deps |
|---|---|---|---|
| Project plugin | file in `.opencode/plugins/` | yes | no install step exists |
| **Local-path package** | `plugin: ["./dir"]` in `opencode.json` | **yes** | **no** |
| Registry module | `plugin: ["<name>"]` via `opencode plugin` | not probed here | not probed here |

> The registry route was probed later and behaves differently from both
> rows above: it loads, and it **does** install the dependency closure.
> See [`.capture/opencode-npm-publish`](../opencode-npm-publish/README.md).

**`opencode plugin <module>` accepts a local directory path, not only a
published module.** `opencode plugin ./pkg-probe` reported "Plugin package
ready", "Detected server target", and installed at local scope. The package was
an ordinary npm package: `package.json` with `exports["./server"]` and a
`dependencies` entry.

It loaded from `exports["./server"]`, confirmed by the marker's
`loadedFrom=file:///.../pkg-probe/index.js` and by `plugin_origins`.

**A real package route therefore exists and needs no registry publication.**

### Dependencies on the package route

The plugin declared `is-number` in its `dependencies`.

| State | Result |
|---|---|
| after `opencode plugin ./pkg-probe` | `is-number` **failed** — not installed anywhere |
| with `pkg-probe/node_modules/is-number` vendored | **resolved:true** |
| vendored directory removed again | **failed** |

**A local-path package's declared dependencies are not installed**; the install
step creates an `@opencode-ai/plugin` SDK root at `.opencode/`, not the plugin's
closure. **Vendoring works**, and the removal control shows the check
discriminates.

### Module load semantics (package entry design)

Probed because a package exposes exactly one entry, while the project layout
uses two plugin modules.

| Case | Result |
|---|---|
| one function exported as both a named export and `default` | loaded **once**, not twice |
| two *distinct* functions exported from one module | **both** loaded, once each |
| `exports["./server"]` and `main` naming different files | **`exports["./server"]` wins** |
| `import.meta.url` inside a package module | resolves to the real file, so sibling assets are addressable |

The first row matters because the generated shim exports the same function as
`HooknosticPlugin` and as `default`; that is not a double dispatch. The second
and third are what make a single-entry package viable: one `index.js` re-exporting
the hook module and the component injector loads both, and the package must
declare `exports["./server"]` rather than rely on `main`.

End-to-end, a package of this shape loaded both plugins and addressed a skill
file shipped beside it:

```
package.json   { "type": "module", "exports": { "./server": "./index.js" } }
index.js       re-exports HooknosticPlugin + HooknosticComponents
hooks.js       components.js
runtime/       package/skills/greet/SKILL.md
```

## Consequences

- `agent-plugin.runtime-package` stays `unsupported`, and the rationale should
  say which route it describes rather than reading as a claim about OpenCode.
- Two dependency routes need no install on any harness: bundling, and vendoring
  `node_modules` beside the module. Both are plain files, which is what every
  OpenCode route consumes. **Only bundling is reachable through Hooknostic
  today**: `AGENT_PLUGIN_DEFAULT_EXCLUDED_NAMES` strips `node_modules` at every
  depth during package inventory, so a vendored tree never reaches the output.
  Vendoring would need an explicit mechanism before it could be recommended.
- A genuine package output mode is available: an npm package with
  `exports["./server"]`, installable from a local path. It would give OpenCode an
  installable unit, a plugin-specific identity instead of the hardcoded
  `.opencode/plugins/hooknostic.js`, and a place to carry dependencies.

## Relative plugin paths are config-relative — intended, not a defect

A relative entry in a `plugin` array resolves against **the directory of the
config file that declares it**, not against the project root or the invocation
cwd.

This is upstream's intended behaviour, not a bug: it was reported as
[anomalyco/opencode#28384](https://github.com/anomalyco/opencode/issues/28384)
(a `.opencode/opencode.json` entry of `.opencode/plugins/<name>.js` resolving
to `<project>/.opencode/.opencode/plugins/<name>.js`) and **closed by a
maintainer as working as intended**, with "write it relative to the config file"
as the answer. A feature request arguing the other way
([#35404](https://github.com/anomalyco/opencode/issues/35404)) was closed by the
stale bot with no maintainer reply. Treat the rule as permanent.

Confirmed independently by the **1.18.31 playback validation** described under
Evidence class, from the other direction — a matched pair against a **root**
`opencode.json` declaring `"./plugin-package"`:

| Package location | Loads? |
| --- | --- |
| `<project>/plugin-package` | yes |
| `<project>/.opencode/plugin-package` | no |

With the config at the project root, config-relative and project-root-relative
coincide; the `.opencode/` copy is the one that fails. That is the same rule the
1.18.30 `.opencode/opencode.json` observation below shows, seen from a config
file in a different directory. Both records are in the projector profile's
`validatedOn`, which is where this fact is owned.

## Defect found in OpenCode 1.18.30: the install command writes an unadjusted path

The rule above is fine. What is broken is that `opencode plugin <relative-path>`
records the argument **verbatim** into `.opencode/opencode.json` without
rewriting it for that file's directory. The path the operator typed is
meaningful from their cwd; the file it lands in interprets it from `.opencode/`.
Running `opencode plugin ./pkg-probe` from a project root writes an entry
resolving to `<project>/.opencode/pkg-probe`, which does not exist:

```
"spec": "file:///D:/tmp/oc-pkg-probe/.opencode/pkg-probe"   <- from `opencode plugin`, broken
"spec": "file:///D:/tmp/oc-pkg-probe/pkg-probe"             <- same path in root opencode.json, loads
```

The install reports success and the plugin silently never loads. The same path
written into the root `opencode.json` by hand loads correctly.

Two reasons this is worth stating as a defect rather than folding into the rule
above:

- **It is not covered by #28384.** That issue is about a path the user wrote by
  hand into a config file. This is a path the *tool* wrote, into a file the user
  never saw, from an argument given in a different frame of reference. A search
  of open and closed issues found no report of it, and `plug.ts` /
  `install.ts` are untouched since 2026-05-02 on both the `v1.18.31` tag and
  `dev` — so it is not a version-scoped bug awaiting a fix.
- **It is silent by a separate defect.** A plugin path that resolves to a
  missing directory is dropped with no diagnostic at any level, which is open
  upstream as
  [#48577](https://github.com/anomalyco/opencode/issues/48577). That is why a
  broken install looks like a successful one.

## Not established

- The registry-module route: whether `opencode plugin <published-name>` installs
  the module's dependency closure. Strongly implied by a package-manager install,
  but not probed; it needs a published package.
- Whether `exports["./tui"]` and `oc-themes` targets behave likewise.
- Precisely which specifiers OpenCode's bundle satisfies. Four were observed
  resolving; the full set is unenumerated and is a moving target across versions.
- Linux and macOS behaviour. Windows only.
