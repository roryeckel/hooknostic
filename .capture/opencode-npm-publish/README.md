# OpenCode's registry plugin route

## Question

`.capture/opencode-plugin-routes` established two OpenCode plugin routes and
left a third unprobed:

| Route | Loads | Installs the plugin's own deps |
| --- | --- | --- |
| Project plugin | yes | no install step exists |
| Local-path package | yes | **no** |
| **Registry module** | **not probed** | **not probed** |

`docs/installing-artifacts.md` therefore said "Publishing to npm and installing
by name is a third route. Whether *it* installs a dependency closure has not
been probed; do not rely on it."

This probe answers it, and three questions that follow from a real answer: does
Hooknostic's own package output work unmodified on that route; does a scoped
name work; and what does a consumer have to do to pick up a new version.

## Evidence class

`live-probe`. `opencode` **1.18.30**, **2026-09-16**, native Windows, against a
local **verdaccio 6.10.3** registry on loopback. No credentials and no model
were used: plugins are loaded through `opencode debug config`, which resolves
configuration and runs the plugin entry without starting a session.

**Isolation, and a correction to the obvious approach.** `OPENCODE_CONFIG_DIR`
is *not* sufficient. The first run set it and the dump still contained the
contributor's own global commands and skill paths — it redirected where the
`@opencode-ai/plugin` SDK root was installed, but not where `opencode.json` was
read from. **`XDG_CONFIG_HOME` isolates configuration discovery** and
`XDG_CACHE_HOME` isolates the package cache; every run after the first set both.
Future probes on this harness should use the XDG pair.

The contributor's real state was hashed before and after: `~/.config/opencode`'s
`package.json`, `opencode.json` and `bun.lock`, plus a sorted listing of its
`node_modules` — **all four unchanged**. The first, under-isolated run did write
one entry into the real `~/.cache/opencode/packages/`; it was removed and the
directory listing restored.

## Method

The plugin module writes a marker file recording `import.meta.url` and, for each
specifier, whether `import()` resolved. Findings rest on that marker, never on
the installer's own output — the install prints "Plugin package ready" before
anything has been loaded.

Two controls make the dependency result discriminating:

- a **negative control** specifier (`hooknostic-absent-control`) published
  nowhere, which must fail; and
- a **removal control**: delete the dependency from the installed closure and
  re-run, which must flip the result.

`probe/` holds the registry configuration and the probe package.

## Observations

### The route works, and it is the only one that installs dependencies

`opencode plugin hooknostic-oc-npm-probe` against the loopback registry reported
"Plugin package ready", "Detected server target", "Scope: local", and wrote
`{"plugin":["hooknostic-oc-npm-probe"]}` into `.opencode/opencode.json`.

Nothing was materialised at install time in the project or the config directory
— the config directory received only the `@opencode-ai/plugin` SDK closure, as
on the local-path route. The package appears at **first load**, under the cache:

```
<XDG_CACHE_HOME>/opencode/packages/<name>@latest/
  package.json         { "dependencies": { "<name>": "<exact resolved version>" } }
  package-lock.json
  node_modules/<name>/ the published package
  node_modules/is-number/
```

| State | `is-number` resolved |
| --- | --- |
| after `opencode plugin <name>` and one load | **true** |
| `hooknostic-absent-control`, published nowhere (negative control) | false |
| after deleting `node_modules/is-number` from the cache root | **false** |

**A registry-installed plugin's declared dependencies are installed.** This is
the first OpenCode route where that is true, and the removal control shows the
check discriminates.

The module loaded from `exports["./server"]`, confirmed by the marker's
`loadedFrom` pointing at `node_modules/<name>/index.js`.

### Hooknostic's package output works on this route unmodified

`examples/agent-plugin/dist/opencode` was published as-is and installed by name.
`opencode debug config` then reported, with no hand editing:

- `plugin: ["combined-example"]`
- `skills.paths` containing
  `<cache>/packages/combined-example@latest/node_modules/combined-example/package/skills`
- `mcp.greeter` a `local` server whose command is the generated
  `hooknostic-runtime/mcp-launcher.mjs` and whose `cwd` is the package's
  `package/` directory

So the component injector ran and resolved its own sibling assets from the cache
location. `index.js` exports the hook plugin and the injector as two distinct
functions, which `.capture/opencode-plugin-routes` established load once each;
hook *dispatch* for this same artifact is established separately by the 1.18.31
playback validation, which drives a real session over the local-path route
against a byte-identical module.

### Scoped names work

`@hooknostic-probe/scoped-oc` published, installed, loaded and resolved its
dependency, cached at `packages/@hooknostic-probe/scoped-oc@latest/`. This
matters because an Agent Plugins manifest name **cannot** be a scoped npm
coordinate: `PLUGIN_NAME` in `packages/agent-plugin/src/load.ts` admits only
`[a-z0-9.-]`, so `@` and `/` are rejected, and the generated npm manifest takes
its name straight from the manifest.

### An installed plugin never updates itself

The cache directory is named `@latest`, but the manifest inside it pins the
**exact** version resolved at first load.

| Action after publishing 1.0.1 over an installed 1.0.0 | Loaded |
| --- | --- |
| re-run the consumer | 1.0.0 |
| `opencode plugin <name> --force` (documented as "replace existing plugin version") | **1.0.0** |
| delete `<cache>/opencode/packages/<name>@latest`, then re-run | **1.0.1** |

The registry served `dist-tags.latest = 1.0.1` throughout, and the re-created
cache root pinned `1.0.1`, so this is not registry metadata staleness. **`--force`
did not move an installed plugin to a newer published version.** Deleting the
cached package root is the only observed way forward. Treat this as measured
behaviour on 1.18.30 rather than a settled upstream contract.

## Consequences

- The registry route is real and can be documented: publish the package delivery
  output, and consumers `opencode plugin <name>`. Rewrite the "do not rely on it"
  paragraph in `docs/installing-artifacts.md`.
- **It is the only OpenCode route that installs dependencies**, so it is the one
  route where a plugin could declare them rather than bundling. Bundling remains
  correct as the default, because it is the only thing that works on all three
  routes and all three harnesses.
- A scoped coordinate needs a config input: the manifest name cannot carry one,
  and nothing today lets a target override it.
- An OpenCode package delivery target with no manifest `version` emits a
  `package.json` npm refuses to publish, and nothing in the build catches it.
- The update behaviour is worth telling consumers about directly. It is not the
  version-keyed cache Claude and Codex use, where bumping the version is enough;
  here bumping the version is *not* enough.
