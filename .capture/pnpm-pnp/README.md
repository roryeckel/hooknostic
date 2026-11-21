# pnpm `nodeLinker: pnp` evidence

Investigation for [issue #259](https://github.com/roryeckel/hooknostic/issues/259):
HN110 told a pnpm Plug'n'Play project to run `yarn hooknostic`, and its advice
gave no install command, while pnpm 12 refuses `pnpm add -D hooknostic` without
allowing esbuild's install script. pnpm is not a harness, but the evidence rule
is the same: what pnpm writes and how Hooknostic runs under it are observed, not
assumed. One session, on 2026-11-19, native Windows 11 (10.0.26300), Node.js
24.20.0, npm 11.4.1.

**Provenance class: captured, except where a claim is marked
documentation-derived or inference.** The captured claims come from commands
run against real pnpm and Yarn releases and the published `hooknostic` and
`@hooknostic/sdk` 0.12.0 and 0.13.0, plus this repository's CLI built at
`7c2bb929` (version 0.13.0, run with `node packages/cli/bin/hooknostic.mjs`).
A second session the same day, after the SDK gained `main`, is under
[Session 2](#session-2-the-sdks-main). Scratch projects were under the
temporary directory, shown as `<tmp>`, and removed afterwards. Not observed:
Linux or macOS, a pnpm workspace with several packages under `nodeLinker: pnp`,
and any pnpm release not named here.

## Question

1. What does pnpm write under `nodeLinker: pnp`, and can it be told from Yarn's
   Plug'n'Play install without reading `.pnp.cjs`?
2. Does `pnpm exec hooknostic` build correctly there, and what do HN110, HN504
   and `doctor` report?
3. Does the install command HN110 should print work, including after the
   `ERR_PNPM_IGNORED_BUILDS` failure, and which pnpm releases accept
   `--allow-build`?

## Method

The pnpm release is pinned per project: the global `pnpm` here is 11.22.0,
and a project's `devEngines.packageManager` (with `onFail: "download"`) makes
it switch. Each project's `pnpm --version` was checked before installing.
`pnpm init` itself writes `"version": "^11.22.0"` under pnpm 11, so the pnpm
12 project's range was then set to `12.21.0`.

```powershell
mkdir <tmp>\pnp12; cd <tmp>\pnp12
pnpm init                                   # then devEngines.packageManager.version = "12.21.0"
pnpm --version                              # 12.21.0
Set-Content pnpm-workspace.yaml "nodeLinker: pnp`n"
pnpm config get node-linker                 # pnp
pnpm add -D @hooknostic/sdk@0.12.0          # exit 0
pnpm add -D hooknostic@0.12.0               # exit 1: ERR_PNPM_IGNORED_BUILDS, esbuild@0.28.2
pnpm add -D --allow-build=esbuild hooknostic@0.12.0
                                            # exit 0: esbuild postinstall ran ("postinstall: Done"),
                                            # pnpm-workspace.yaml gained allowBuilds: { esbuild: true }
```

A `hooknostic.config.ts` with one Claude target (`delivery: "project"`) and a
`tool.before` shell guard (`getting-started.md`'s `no-force-push`) was added.
Then, from the project and from `nested/deep` with `--config ../../hooknostic.config.ts`:
`pnpm exec hooknostic build`, `pnpm exec hooknostic doctor`, `npx hooknostic build`,
`node node_modules/hooknostic/bin/hooknostic.mjs build`, and this repository's
CLI as `node <repo-cli> build|doctor` and `pnpm exec node <repo-cli> build|doctor`.
For skew, the project's CLI was moved to 0.13.0 with
`pnpm add -D --allow-build=esbuild hooknostic@0.13.0` (SDK still 0.12.0).
The built artifact was fed `fixtures/claude/2.1/pre-tool-bash.input.json`, and
the same payload with `tool_input.command` set to `git push --force origin main`.

Variants, each a fresh project pinned the same way:

- `.npmrc` with `node-linker=pnp` and no `pnpm-workspace.yaml` (pnpm 12.21.0).
- `pnpm-workspace.yaml` with `nodeLinker: pnp` and `symlink: false` (pnpm 12.21.0).
- `nodeLinker: isolated` (the default) under pnpm 12.21.0 and 11.28.13.
- `nodeLinker: pnp` under pnpm 11.28.13, as background only.
- pnpm 9.15.9, 10.2.1, 10.3.0 and 10.4.0, installed with
  `npm install --prefix <tmp>\pnpmver\p<version> pnpm@<version>` and run as
  `node <prefix>\node_modules\pnpm\bin\pnpm.cjs` with
  `npm_config_manage_package_manager_versions=false` (otherwise pnpm 10
  switched to 12.21.0): `pnpm add --help`, then
  `pnpm add -D --allow-build=esbuild is-number@7.0.0` in a fresh project, and
  `pnpm add -D is-number@7.0.0` to see the install record.
- Yarn 4.18.1 through corepack 0.35.0 (`"packageManager": "yarn@4.18.1"`), as
  the opt-in Yarn suite pins it: `corepack yarn add -D @hooknostic/sdk@0.12.0`,
  then `corepack yarn add -D hooknostic@0.12.0`. The first attempt of the
  second command failed on a network error (`TCP.done`), and the retry exited 0.

## Observations

### What each install writes (Q1)

| | pnpm 12.21.0, `nodeLinker: pnp` | Yarn 4.18.1 (Plug'n'Play) |
|---|---|---|
| Project root | `.pnp.cjs`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `node_modules/` | `.pnp.cjs`, `.pnp.loader.mjs`, `yarn.lock`, `.yarn/` (holding `install-state.gz`, Session 2); no `node_modules` |
| `.pnp.data.json` | none | none |
| `.pnp.cjs` | 15,364 bytes: a hand-written loader (`Module._resolveFilename` hook marked `__pnpmPnp`, a `registry` object) | 460,518 bytes: Yarn's runtime with `RAW_RUNTIME_STATE` |
| Package locations | real directories, `./.pnpm/@hooknostic+sdk@0.12.0_zod@4.6.7/node_modules/@hooknostic/sdk` relative to `node_modules` | `.yarn/__virtual__/…/cache/@hooknostic-sdk-npm-0.12.0-….zip/node_modules/@hooknostic/sdk` |
| `node_modules` | `.bin/hooknostic{,.cmd,.ps1}`, `.pnpm/`, `@hooknostic/sdk` and `hooknostic` symlinks into `.pnpm`, `.modules.yaml`, `.pnpm-workspace-state-v1.json` | none |
| `node_modules/.modules.yaml` | JSON: `"nodeLinker": "pnp"`, `"packageManager": "pnpm@12.21.0"`, `"layoutVersion": 5` | none |

pnpm's install record is the discriminator HN110 uses, with the lockfiles as
the fallback (`pnpmPlugAndPlay` in `packages/core/src/sdk-resolution.ts`): Yarn
writes neither `.modules.yaml` nor `pnpm-lock.yaml`.

Other install records:

| pnpm | Mode | `node_modules/.modules.yaml` |
|---|---|---|
| 12.21.0 | isolated | JSON, `"nodeLinker": "isolated"`, `"packageManager": "pnpm@12.21.0"` |
| 11.28.13 | isolated | JSON, `"nodeLinker": "isolated"`, `"packageManager": "pnpm@11.28.13"` |
| 11.28.13 | pnp | JSON, `"nodeLinker": "pnp"`, `"packageManager": "pnpm@11.28.13"` |
| 10.3.0 | isolated | YAML, `nodeLinker: isolated`, `packageManager: pnpm@10.3.0` |
| 9.15.9 | isolated | YAML, `nodeLinker: isolated`, `packageManager: pnpm@9.15.9` |

`.npmrc`'s `node-linker=pnp` was **ignored** by pnpm 12.21.0:
`pnpm config get node-linker` printed `undefined`, no `.pnp.cjs` was written,
and `.modules.yaml` said `"nodeLinker": "isolated"`. Only
`pnpm-workspace.yaml`'s `nodeLinker: pnp` took effect.

### Running Hooknostic (Q2), pnpm 12.21.0, default `symlink`

| Command | Result |
|---|---|
| `pnpm exec node -p …` | `process.versions.pnp` undefined; `NODE_OPTIONS` names `.pnp.cjs`; `typeof Module.findPnpApi` is `function` |
| `pnpm exec hooknostic build` (CLI and SDK 0.12.0) | exit 0, `BUILT claude`; pnpm prints `[WARN] verify-deps-before-run does not work with node-linker=pnp` |
| the same from `nested/deep` with `--config` | exit 0 |
| the artifact on the fixture payload | exit 0, no output; on the `--force` payload, exit 0 with `permissionDecision: "deny"` and the hook's reason |
| `pnpm exec hooknostic doctor` (0.12.0, 0.13.0) | exit 0 |
| `npx hooknostic build` | exit 1, `npm error code EBADDEVENGINES`, `Invalid name "pnpm" does not match "npm" for "packageManager"` |
| `node node_modules/hooknostic/bin/hooknostic.mjs build` (CLI 0.13.0, SDK 0.12.0) | exit 0, HN110 with the `yarn hooknostic` advice (the bug) |
| `node <repo-cli> build` (master, 0.13.0; SDK 0.12.0) | exit 0, HN110 with the `yarn hooknostic` advice (the bug); the SDK named `at node_modules/.pnpm/@hooknostic+sdk@0.12.0_zod@4.6.7/node_modules/@hooknostic/sdk (relative to the config's directory)` |
| `node <repo-cli> doctor` | `project @hooknostic/sdk 0.12.0`, and the same HN110 |
| `pnpm exec hooknostic build` (CLI 0.13.0, SDK 0.12.0) | exit 0, **no HN110** |
| `pnpm exec node <repo-cli> build` | exit 0, **no HN110** |
| `pnpm exec node <repo-cli> doctor` | `project @hooknostic/sdk not found` |

HN504 never fired: pnpm's package paths are real directories, which
`PNP_PATH` does not match, so `pnpRuntimeGuardPlugin` has nothing to refuse.

Why HN110 is silent under `pnpm exec` (observed):

```powershell
pnpm exec node -e "…createRequire(join(cwd, 'package.json')).resolve('@hooknostic/sdk')"
# Error: Cannot find module '<tmp>\pnp12\node_modules\.pnpm\@hooknostic+sdk@0.12.0_zod@4.6.7\node_modules\@hooknostic\sdk'
#     at Module.hooked [as _resolveFilename] (<tmp>\pnp12\.pnp.cjs:178:36)
```

while plain `node` resolves `…\@hooknostic\sdk\dist\index.js`. The project
SDK lookup behind HN110 and doctor's version line therefore finds nothing
under `pnpm exec`. The mechanism, read from pnpm 12.21.0's `.pnp.cjs`:
its hook turns a bare request into the package's directory and hands that to
Node's own resolver,

```js
// resolveToUnqualified
const subpath = request.slice(name.length)
const dependencyLocation = packageLocation(registry[dependencyId])
const unqualified = path.resolve(dependencyLocation, `.${subpath}`)
// setup()'s hook
const unqualified = resolveToUnqualified(request, issuer)
return originalResolveFilename.call(this, unqualified, parent, isMain, options)
```

and Node resolves a directory path by its manifest's `main` (or `index.js`),
never by `exports`; the SDK had only `exports`. That last step is
**inference** from Node's documented resolution and the error above;
Session 2 tests it by adding `main`. The #216 gate is not involved: `anotherInstallsPnpRuntime`
returns false, as `process.versions.pnp` is unset. The build itself is
unaffected (esbuild resolves through `node_modules`).

With `symlink: false`, pnpm 12.21.0 wrote `.pnp.cjs` and `node_modules/.pnpm`
but no `node_modules/@hooknostic` or `node_modules/hooknostic` links, and every
build failed: `pnpm exec hooknostic build` and `node <repo-cli> build` both
exited 2 with HN501 `Could not resolve "@hooknostic/sdk"`. esbuild finds no data
it can read in pnpm's `.pnp.cjs` and falls back to `node_modules`, which then has
nothing. `node <repo-cli> doctor` reported
`not looked up: .pnp.cjs is a Yarn Plug'n'Play manifest, and this process isn't
running under Yarn's runtime`.

Background, pnpm 11.28.13 with `nodeLinker: pnp`: `.pnp.cjs` is Yarn's runtime
(447,882 bytes). Under `pnpm exec`, `process.versions.pnp` is `3`, and
`Module.findPnpApi(<the CLI's dist>).findPackageLocator(<project root>/)` is
`null`. `pnpm exec hooknostic build` (CLI 0.13.0, SDK 0.12.0) exits 0 with no
HN110: the #216 gate reads that runtime as another install's. With plain
`node`, the project's CLI exits 0 and prints HN110 with the `yarn hooknostic`
advice. Doctor's report under pnpm 11 is in Session 2.

### Install commands (Q3)

| Command | Result |
|---|---|
| pnpm 12.21.0, `pnpm add -D hooknostic@0.12.0` | exit 1, `ERR_PNPM_IGNORED_BUILDS`, `Ignored build scripts: esbuild@0.28.2`; the package is added to `package.json` anyway |
| then `pnpm add -D --allow-build=esbuild hooknostic@0.12.0` | exit 0, `Already up to date`, then `esbuild postinstall: Done` |
| pnpm 12.21.0 isolated, `pnpm add -D hooknostic@0.12.0` | exit 1, `Ignored build scripts: esbuild@0.28.2` |
| pnpm 12.21.0, `pnpm add -D --allow-build=esbuild hooknostic@0.13.0` | exit 0; `package.json` saved `"hooknostic": "0.13.0"` (exact) |
| `pnpm add --help` lists `--allow-build` | 10.4.0: yes. 10.3.0, 10.2.1, 9.15.9: no |
| pnpm 10.3.0 and 9.15.9, `pnpm add -D --allow-build=esbuild is-number@7.0.0` | exit 1, `ERROR Unknown option: 'allow-build'` |
| pnpm 10.4.0, `pnpm add -D --allow-build=esbuild esbuild@0.25.0` (Session 2; the round-1 reviewer ran the same with the same result) | exit 0; `package.json` gained `"pnpm": {"onlyBuiltDependencies": ["esbuild"]}` and `"esbuild": "0.25.0"` (exact) |
| Yarn 4.18.1, `yarn add -D hooknostic@0.12.0` | exit 0 (on retry); `package.json` saved `"hooknostic": "0.12.0"` (exact); `YN0004: esbuild@npm:0.28.2 lists build scripts, but all build scripts have been disabled.` |

pnpm's own changelog agrees (documentation-derived): its 10.4.0 entry says
"The `pnpm add` command now supports a new flag, `--allow-build`"
([pnpm#9086](https://github.com/pnpm/pnpm/pull/9086)), and 10.3.0's lists no
such flag.

**Documentation-derived, not run here:** that
`npm install --save-dev hooknostic@V` saves `^V` unless `--save-exact` is
given is npm's documented `save-prefix` default.

### After the change

This repository's CLI, rebuilt with the fix (0.13.0, SDK 0.12.0), run with
plain `node`:

- pnpm 12.21.0, `nodeLinker: pnp`: exit 0, HN110 with
  ``with `pnpm add -D --allow-build=esbuild hooknostic@0.12.0`, and run it with `pnpm exec hooknostic`.``
- pnpm 12.21.0, isolated: exit 0, HN110 naming
  `npm install --save-dev --save-exact hooknostic@0.12.0` and
  `pnpm add -D --allow-build=esbuild hooknostic@0.12.0`.
- Yarn 4.18.1, as `node -r ./.pnp.cjs <repo-cli> build`: HN110 with
  ``with `yarn add -D hooknostic@0.12.0`, and run `yarn hooknostic` …``. The
  build then failed with HN501 `Could not resolve "zod/v4"` from the 0.12.0
  SDK, which this project installs without its Zod peer; unrelated to HN110.

## Session 2: the SDK's `main`

Same machine and day, after `packages/sdk/package.json` gained
`"main": "./dist/index.js"` (its `exports` unchanged). The question: does that
let pnpm 12's hook resolve the SDK, so HN110 and doctor work under
`pnpm exec`?

Method. This repository's packages were bundled and packed
(`pnpm run bundle`; `pnpm pack` in `packages/sdk` and `packages/cli`, both
0.13.0). The SDK tarball was unpacked, its `version` set to `0.12.99` so it
differs from the CLI, and repacked twice with `tar -czf`: once as packed (with
`main`) and once with `main` deleted. Nothing else differs between the two.
Each went into a fresh pnpm 12.21.0 project (`devEngines` pinned, `pnpm
--version` checked, `nodeLinker: pnp` in `pnpm-workspace.yaml`) with
`pnpm add -D --allow-build=esbuild <sdk tarball> <cli tarball> zod@4.6.7`
(exit 0 in both), and the config and hook from Session 1.

| Command | SDK without `main` (as 0.13.0 and earlier) | SDK with `main` |
|---|---|---|
| `pnpm exec hooknostic build` | exit 0, BUILT, **no HN110** | exit 0, HN110 advising `pnpm add -D --allow-build=esbuild hooknostic@0.12.99` and `pnpm exec hooknostic`, BUILT |
| `pnpm exec hooknostic doctor` | exit 0, `project @hooknostic/sdk not found` | exit 0, `project @hooknostic/sdk 0.12.99`, and HN110 |
| `node node_modules/hooknostic/bin/hooknostic.mjs build` | exit 0, HN110, BUILT | exit 0, HN110, BUILT |
| `pnpm exec node probe.cjs`: `require.resolve('@hooknostic/sdk')` from the project | `MODULE_NOT_FOUND` | `node_modules\.pnpm\@hooknostic+sdk@file+…sdk-0.12.99-main.tgz_zod@4.6.7\node_modules\@hooknostic\sdk\dist\index.js` |

The same probe recorded pnpm 12.21.0's runtime under `pnpm exec`, in both
projects: `process.versions.pnp` unset; `Module.findPnpApi` a function, which
returns the API for the project root and `undefined` for the drive root (a
path outside its registry); and that API's
`findPackageLocator(<project root>\)` is `{"name":null,"reference":null}`.
The `.pnp.cjs` (15,804 bytes here) defines `findPnpApi` in `setup()` as
`findPackageLocator(lookupSource) === null ? undefined : api`. The artifact
built with `main` denied the `--force` fixture payload and passed the plain
one, as in Session 1.

pnpm 11.28.13, `nodeLinker: pnp`, the same tarballs (SDK with `main`):
`pnpm exec hooknostic doctor` exits 0 with
`project @hooknostic/sdk not looked up under another install's Plug'n'Play runtime`
and no HN110; `pnpm exec hooknostic build` exits 0 with no HN110; and
`node node_modules/hooknostic/bin/hooknostic.mjs doctor` reports
`project @hooknostic/sdk 0.12.99` and HN110. `main` does not change pnpm 11:
its silence is the #216 gate, as Session 1 found.

TypeScript (`moduleResolution: node10`, which reads no `exports`; TypeScript
6.0.3 against `packages/sdk` linked into a scratch project's
`node_modules`): with `main`, `@hooknostic/sdk` resolves to
`dist/index.d.ts`, exit 0; without it, TS2307 `Cannot find module`, exit 2.
So no top-level `types` field is needed beside `main`.

Yarn 4.18.1, a fresh project with one dependency: `.yarn/` holds
`install-state.gz` and nothing else; no `node_modules`.

### What `pnpm exec hooknostic build` bundles

Recorded in a third session the same day, after the round-2 review measured
it. `build.ts` points the shims' `@hooknostic/sdk` imports at the project's SDK
when the project SDK lookup resolves one, so `main` also decides what the
artifact contains under `pnpm exec`. Each row is one build of the same
config and an empty hook list, in a fresh pnpm 12.21.0 `nodeLinker: pnp`
project, exit 0. Module counts are esbuild's `// <path>` comments in
`dist/claude/runtime/hooknostic.mjs`, grouped by package directory.

| Project SDK | CLI | `main` | Bytes | Bundled |
|---|---|---|---|---|
| this repository's, packed as 0.12.99 | the project's, packed from this repository (its own SDK: the registry's 0.13.0) | no | 291,518 | project SDK 13 modules, **CLI's SDK 0.13.0 11 modules**, `zod@4.6.7` 18 |
| the same | the same | yes | 288,326 | project SDK 14 modules, `zod@4.6.7` 18; HN110 printed |
| the registry's 0.12.0 (its root imports Zod) | the same | no (as published) | 333,448 | project SDK 14, **CLI's SDK 0.13.0 11**, `zod@4.6.7` 29 |
| the same, `main` added to its installed manifest | the same | yes | 308,881 | project SDK 14, `zod@4.6.7` 29; HN110 printed |
| the registry's 0.12.0 | this repository's, `pnpm exec node <repo>/packages/cli/bin/hooknostic.mjs` | no | 532,239 | project SDK 14, `zod@4.6.7` 29, **`<repo>/packages/sdk` 11, `<repo>`'s `zod@4.6.7` 18** |
| the same | the same | yes | 308,363 | project SDK 14, `zod@4.6.7` 29; HN110 printed |
| the registry's 0.12.0 | the project's, as `node node_modules/hooknostic/bin/hooknostic.mjs build` (plain `node`, no pnpm runtime) | no | 308,881 | project SDK 14, `zod@4.6.7` 29; HN110 printed |

So without `main`, a `pnpm exec` build bundles the CLI's own SDK for the
shims beside the project's SDK for the hooks, as #258 fixed elsewhere, and
HN110 is silent about it. Zod is bundled twice only when the CLI's SDK
resolves another Zod directory than the project's, as with a CLI outside the
project's store; with the project's own CLI and one `zod@4.6.7` in pnpm's
store, both SDKs share it. The round-2 reviewer measured the last pair with
its own scratch project: 534,359 bytes, two SDKs and two Zods, against
310,303 with `main`.

## Session 3: moving between Yarn and pnpm

Same machine and day, Yarn 4.18.1 through corepack and pnpm 12.21.0 pinned
through `devEngines`, each version checked before it ran. The question: can a
pnpm `nodeLinker: pnp` record sit beside a `yarn.lock`, and if so, who
installed last? The round-2 reviewer ran both migrations first; these are
reruns.

**pnpm to Yarn.** A pnpm 12.21.0 `nodeLinker: pnp` project with
`is-number@7.0.0` (record `"nodeLinker": "pnp"`, `.pnp.cjs` containing
`__pnpmPnp`). `package.json` then named `"packageManager": "yarn@4.18.1"` and
no `devEngines`, an empty `yarn.lock` was written, and `corepack yarn install`
ran, once with `pnpm-lock.yaml` deleted and once with it kept:

```
➤ YN0031: │ One or more node_modules have been detected and will be removed. This operation may take some time.
yarn install exit 0
```

Both times `node_modules` afterwards held only `.pnpm`: `.modules.yaml` was
gone, and `.pnp.cjs` was Yarn's (no `__pnpmPnp`). With the lockfile kept, the
project has `yarn.lock` and `pnpm-lock.yaml` and no record.

**Yarn to pnpm, with `pnpm import`.** A Yarn 4.18.1 project with
`@hooknostic/sdk@0.12.0` and `zod@4.6.7` (`corepack yarn add -D`, exit 0;
root: `.yarn`, `.pnp.cjs`, `.pnp.loader.mjs`, `package.json`, `yarn.lock`).
`package.json` then dropped `packageManager` for `devEngines` naming pnpm
12.21.0, `pnpm-workspace.yaml` set `nodeLinker: pnp`, and `pnpm import` and
`pnpm install` both exited 0. Afterwards the root held `.yarn`,
`node_modules`, `.pnp.cjs` (containing `__pnpmPnp`: pnpm's),
`.pnp.loader.mjs` (Yarn's, left behind), `pnpm-lock.yaml`,
`pnpm-workspace.yaml` and **`yarn.lock`**, and the record said
`"nodeLinker": "pnp"` and `"packageManager": "pnpm@12.21.0"`. This
repository's CLI (`node <repo-cli> doctor`, after the precedence fix) reported
`project @hooknostic/sdk 0.12.0` and HN110 advising
`pnpm add -D --allow-build=esbuild hooknostic@0.12.0` and
`pnpm exec hooknostic`. The reviewer saw the earlier rule (a `yarn.lock`
means Yarn) advise `yarn add -D` here, and following it with Yarn replaced
the pnpm install.

So a `nodeLinker: pnp` record means pnpm installed last: Yarn's install
removes it, and `pnpm import` keeps `yarn.lock`. Not observed: Linux or macOS,
Yarn 2 or 3, and a pnpm `node_modules` with only dot-entries
(`symlink: false`), which Yarn might not count as detected.

## Consequences

- HN110 names `pnpm exec hooknostic` and `pnpm add -D [--allow-build=esbuild]
  hooknostic@<SDK version>` for a Plug'n'Play manifest pnpm wrote:
  `node_modules/.modules.yaml` beside it says `nodeLinker: pnp`, whatever else
  is there (Session 3), or, without that record, `pnpm-lock.yaml` is beside it
  and `yarn.lock` is not. The manifest's content is never read.
- `--allow-build=esbuild` is printed when the nearest `.modules.yaml` that
  names a release records pnpm 10.4.0 or later. With no recorded release it
  is left out of a `node_modules` project's pnpm command, and kept, with a
  note for pnpm before 10.4, in a pnpm Plug'n'Play project's.
- The SDK names `main`, so from the next release on, pnpm 12's
  `nodeLinker: pnp` runtime resolves it, and HN110 and doctor work under
  `pnpm exec`, and a `pnpm exec` build bundles only the project's SDK. An SDK
  of 0.13.0 or earlier still reads as `not found` there, and its builds also
  bundle the CLI's own SDK for the shims; plain
  `node node_modules/hooknostic/bin/hooknostic.mjs` avoids both.
- pnpm's `nodeLinker: pnp` is **best effort**, by the standard ADR-0041 sets
  for `yarn dlx`: `pnpm exec hooknostic` built and the artifact ran with pnpm
  12.21.0's default `symlink`, but no suite runs it. `symlink: false` does not
  build at all, and pnpm 11's runtime silences HN110 and doctor's version
  line through the #216 gate.
- HN504's note and guard are unchanged: they cannot fire under pnpm.
