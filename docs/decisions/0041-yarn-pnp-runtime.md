# ADR-0041: Yarn Plug'n'Play builds run under Yarn's runtime

## Status

Accepted, 2026-11-19. It settles the question ADR-0040's point 4 left open
("supporting those invocations is #190"); ADR-0040 itself is unchanged.

## Context

A Yarn Plug'n'Play project has no `node_modules`. Its packages sit in zip
archives, and a file Yarn writes at the project's root, `.pnp.cjs`, tells
Node where each one is. Yarn's runtime is that file loaded into the process:
it teaches Node's resolver and `fs` to read the archives. `yarn <bin>` loads
it before running a package's binary. `node -r ./.pnp.cjs` loads the same
file into that one Node process before the script runs; the suite verifies
that this is enough for `build`, and does not run other commands that way.

esbuild reads Yarn's manifest and archives itself, so a bundle resolves
either way. What Hooknostic reads beside a module -- the SDK's manifest for
its Zod fallback, licence notices, the project's SDK for HN110 -- goes
through Node's `fs` and comes back missing without Yarn's runtime. Since #183
such a build fails with HN504 rather than come out silently wrong
(`pnpRuntimeGuardPlugin`, ADR-0040 point 4). The guard is active when Yarn's
runtime is missing (`process.versions.pnp` unset) in a project with a
Plug'n'Play manifest, and fails a build only when the build needs a package
served from Yarn's install, a path this process cannot read.

The opt-in Yarn suite (`packages/cli/test/yarn-pnp-consumer.test.ts`,
[testing](../testing.md#yarn-plugnplay-consumers)) installs six Yarn 4.18.1
`nodeLinker: pnp` consumers -- no Zod, Zod 3.24.4, 3.25.76 and 4.6.7, Zod
4.6.7 with the SDK repacked as another release, and Zod 4.6.7 with an MCP
component -- and builds each four ways:

| Invocation | Outcome |
|---|---|
| `yarn hooknostic` | Builds. With no Zod in the project, it uses the CLI's own Zod, with no HN109. With the project's Zod out of range (3.24.4, 3.25.76), it uses the CLI's own, with HN109, which names both Zods `from Yarn's Plug'n'Play install` (#256). With it in range (4.6.7), it uses the project's. HN110 warns for the repacked SDK, naming it `from Yarn's Plug'n'Play install` (#225). The MCP launcher answers. |
| `node -r ./.pnp.cjs <npm install>/hooknostic/bin/hooknostic.mjs`, from the project directory, with the CLI installed by npm in a directory outside any Yarn Plug'n'Play project | The same as `yarn hooknostic`, except that HN109 names the CLI's own Zod by its path, outside Yarn's install (#256). |
| Plain `node` with that npm-installed CLI | HN504 in every consumer, with no HN110. |
| `yarn dlx -p hooknostic@file:<the CLI tarball>`, the same tarball, at the same version, that every consumer depends on | HN504 unless the project's Zod is in range; then it builds and the MCP launcher answers. HN110 never warns. |

`init --local`, `sync` twice and `verify` run under `yarn hooknostic` only.
`npx`, a global install and `pnpm dlx` are not run. Each is Hooknostic
outside the project without Yarn's runtime, as in the plain `node` row, where
every consumer's build needs the SDK from Yarn's install and fails with HN504.

`yarn dlx` loads a runtime, but its own, not the project's:

- Its install is not in the project's manifest, so a build that needs
  Hooknostic's own Zod fails with HN504.
- HN110 is never checked there (#216). Looking up the project's SDK would
  load the project's PnP API beside dlx's, and in a shared global cache every
  later first load from an archive both list fails with "controlled by
  multiple pnpapi instances". `anotherInstallsPnpRuntime` gates HN110's lookup
  and `doctor`'s, which reports the SDK as `not-looked-up` with the reason
  `another-pnp-runtime`.
- On Linux with Node 22, sharing Yarn's global cache with the project, it
  fails with HN501 "controlled by multiple pnpapi instances" whatever the Zod
  version, already at `d2bd5967`, before HN110 existed. The cause is
  unconfirmed (#190): an in-process trace showed no second PnP API loaded in
  the main thread, so Yarn's ESM loader thread is the likely place.
- `yarn dlx hooknostic@0.12.0`, from the registry, in a project that also
  depends on `hooknostic@0.12.0` failed at startup, before any Hooknostic
  code ran. That was reproduced by hand, and only with the registry's
  0.12.0. The suite's `yarn dlx` mode runs the same `file:`
  tarball the consumers depend on, and some of its cells build, so the
  failure does not follow from the versions matching alone.

Only Yarn 4.18.1 is verified; Yarn 2 and 3 are untested. Yarn's
`node-modules` linker is not Plug'n'Play and is unaffected.

## Decision

1. **Supported: commands run under the project's own Yarn runtime.**
   - `yarn hooknostic <command>`, with `hooknostic` as a devDependency.
   - `node -r ./.pnp.cjs <dir>/hooknostic/bin/hooknostic.mjs <command>`, run
     from the project directory, for a CLI installed with npm globally or in
     a directory outside any other Yarn Plug'n'Play project, the layout the
     suite runs. A CLI installed inside another Yarn Plug'n'Play project's
     tree is untested, pending #269. The command names the package's
     `bin/hooknostic.mjs`, because the `node_modules/.bin` entry is not always
     a Node script (a `.cmd` or shell wrapper on Windows and under pnpm).

   The opt-in suite runs `build` in both forms, `init --local`, `sync` and
   `verify` under `yarn hooknostic`, and MCP components. Other commands are
   expected to work but are not run, under `node -r` in particular.
2. **Unsupported:**
   - Plain `node`, `npx`, a globally installed `hooknostic` run directly, and
     `pnpm dlx`. A build that needs a package served from Yarn's install
     fails with HN504.
   - `yarn dlx`, which stays best effort as it is. At most it builds when the
     project's Zod is in range; otherwise it fails with HN504, and it can fail
     in the other ways above. It never checks HN110, and nothing warns that
     the run is unsupported.
3. **HN504 is the in-product statement.** Its note names the devDependency
   route and `yarn hooknostic`, and lists `npx`, a global install, `pnpm dlx`
   and `yarn dlx` as not loading the project's runtime. No new diagnostic.
4. **Real-Yarn coverage is the opt-in suite,** run during release preparation
   when a release changes how builds resolve or read packages or how `sync`
   writes project files ([releases](../releases.md#prepare-one-release-pr)).
   CI does not run it.

## Consequences

- A CLI installed outside the project builds a Plug'n'Play project only
  through the `node -r` form. HN504's note does not mention that route; it is
  documented instead (getting started, the CLI README, the upgrading guide).
  Adding it would change a diagnostic's text, which this decision leaves out
  of scope.
- `npx hooknostic build` fails with HN504 in a Plug'n'Play project, as every
  plain `node` cell does in the suite; the project installs `hooknostic` and
  runs it through Yarn.
- `yarn dlx` stays without HN110, so a dlx-fetched CLI on another release than
  the project's SDK builds without the warning.
- Programmatic callers of `buildProject` and `runProject` need their process
  under the project's runtime too.
- **Latent hazard.** `buildProject` points the shims' `@hooknostic/sdk` imports
  at the project's SDK through an alias it finds with Node's resolver from the
  project directory, ungated (the comment at that call in
  `packages/core/src/build.ts`). Under `yarn dlx` that resolution may load the
  project's PnP API beside dlx's, as HN110's lookup did in #216. Fixing it
  means a lookup through esbuild's resolver, which belongs with any future
  `yarn dlx` support.
- **Open question (#268, `yarn dlx` only).** By the time the MCP launcher is
  bundled under `yarn dlx`, the project's PnP API is loaded beside dlx's;
  #224 works around it by asking only the API that loaded the CLI. Which step
  loads the project's API is unknown; the bundle alias's lookup above is one
  candidate. It is not investigated further while `yarn dlx` is unsupported.
  If reopened, use in-process instrumentation: a `--require` preload makes
  Yarn load the project's `.pnp.cjs` under dlx and changes the result.
- **Known edge (#269).** `anotherInstallsPnpRuntime` asks Yarn about the CLI's
  own directory even when the CLI is outside every Yarn install, as under the
  `node -r` form. For a CLI inside another Yarn Plug'n'Play project's tree,
  that may load that tree's PnP API beside the project's, as Node's own
  resolution from the CLI's files could. Whether the gate should skip the
  question, as the Zod fallback and the MCP launcher do, is #269; until then
  that layout is untested and not claimed.

## Alternatives considered

- **Self-setup:** the CLI loads the project's `.pnp.cjs` itself under plain
  `node`, `npx` or a global install. It patches globals for the whole process,
  including `inspect`, `init` and `doctor`, and puts every CLI `fs` call
  through Yarn's patched `fs`, whose gaps #229 showed (`FileHandle.sync` not
  implemented). It must stay off under `yarn dlx`, where loading the project's
  API is #216's failure, and only the opt-in suite could test it. The
  explicit equivalent, `node -r`, is already run by the suite.
- **Support `yarn dlx`:** resolve Hooknostic's own Zod through the CLI's own
  PnP API, and the project's SDK through esbuild's resolver. Deferred. The
  preconditions are a CI lane for the Yarn suite, demand in Discussions, and
  proof of two assumptions: that the SDK subpath alias works with a zip path
  found that way, and that esbuild reads a zip from another install's
  manifest. It would not address the Linux with Node 22 failure or the
  registry same-version startup failure, whose causes are unconfirmed.
- **A Plug'n'Play-aware filesystem in core** (a zip reader and manifest
  parsing): duplicates Yarn's runtime inside core, with ongoing maintenance
  for zip formats and Yarn's layout.
- **Refuse `yarn dlx` with HN504:** breaks builds that produce correct output
  when the project's Zod is in range.
- **Warn that HN110 was not checked:** new diagnostic vocabulary for a mode
  that is not supported.
