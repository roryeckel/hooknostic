# ADR-0040: The SDK's Zod schemas are a subpath, so authoring needs no Zod

## Status

Accepted, 2026-11-14.

## Context

`@hooknostic/sdk` has two audiences. Hook and config authors use its
authoring API: `definePlugin`, `hook`, `defineConfig`, the effect helpers and
the canonical types. Tooling that validates Hooknostic objects (the compiler,
the runtime dispatcher, a consumer composing its own schemas) uses its runtime
Zod schemas.

Only two modules, `schemas.ts` and `result.ts`, imported `zod/v4`. The root
entry re-exported both, so `import { definePlugin } from "@hooknostic/sdk"`
loaded Zod at runtime and named it in the root's declarations, and the SDK
therefore declared `zod` as a required peer. The authoring API never touches
Zod, and a generated runtime artifact bundles its own copy. Every author still
had to install a dependency they never import. Where peers are not
auto-installed (Yarn 1, pnpm with `auto-install-peers=false`), an author who
skipped it could not import the SDK or type-check a hook. The requirement came
from the barrel alone.

## Decision

1. **`@hooknostic/sdk/schemas` holds every Zod schema.** The package exports
   `./schemas` (`types` and `default`). It carries every schema the root used
   to export, including `runtimeDiagnosticCodeSchema`, `handlerErrorSchema` and
   `hookResultSchema`, which move from `result.ts` into `schemas.ts`.
   `schemas.ts` is the only SDK module that imports Zod.
2. **The root never loads Zod**, at runtime or in its declaration graph.
   Every type an author reaches from the root is plain TypeScript, as each one
   already was. `result.ts` keeps `HookResult`, `HandlerError`,
   `AppliedEffect` and `RUNTIME_DIAGNOSTIC_CODES` at the root, with no schema.
   Compile-time assertions in `schemas.ts` hold 16 schemas' inferred output
   equal to the root type each validates, after removing the `| undefined`
   that Zod 4 adds to optional keys. Five of them compare against the type
   with a documented difference applied: `Effect`'s fields without
   `readonly`, `accept` as any string, or mutable arrays. The schemas without
   an assertion differ from their types by design, and the file says how.
   Asserting identity there would mean changing a public type.
3. **`zod` stays a peer, now optional.** It still comes from the `zod-peer`
   catalog, with `peerDependenciesMeta.zod.optional`. It is needed only to
   import `@hooknostic/sdk/schemas`.
4. **Artifacts take the SDK's Zod from the project only when it satisfies the
   peer range, or else from Hooknostic.** A runtime shim validates effects
   through `@hooknostic/sdk/schemas`, resolved from the project's SDK (one SDK
   copy per artifact, as before). Before anything resolves, the build reads
   the version of the zod package that the SDK's import reaches: the first
   `node_modules/zod` on the lookup path from the SDK's real location, which
   esbuild takes the import from whether or not it provides `zod/v4`. When
   that version satisfies the `peerDependencies.zod` range in the SDK's own
   manifest, those schemas use it, and the artifact holds one copy, shared
   with user code. Otherwise a Zod import made by the SDK resolves from
   Hooknostic's own install: the published CLI depends on Zod from the same
   range for exactly this, and that copy resolves once per process. A project
   with no reachable Zod gets it silently. A reachable Zod outside the range
   or with no readable version builds with an HN109 warning, not an error,
   because a project rarely controls a transitive Zod. That includes Zod 3.24
   and older, which have no `zod/v4` entry, and a Zod 3 inherited from an
   unrelated dependency. Under a Yarn Plug'n'Play manifest, either PnP or
   `node_modules` may serve the import, and esbuild's `alias` for zod,
   `nodePaths` and `preserveSymlinks` change what it reaches. Those builds
   resolve the SDK's import first and check the version of the package it
   resolved to. A Plug'n'Play build requires Yarn's runtime (`yarn hooknostic`):
   without it, as under plain `node`, `npx`, a global install or `pnpm dlx`,
   or under `yarn dlx` when the build needs Hooknostic's own Zod, it fails with
   HN504 rather than bundle around what this process cannot read (#183;
   supporting those invocations is #190).
   Only the SDK's imports are redirected. User code that imports Zod keeps the project's
   copy, so the artifact then carries two. User code that imports Zod without
   installing it still fails.
5. **An SDK alias covers the subpath.** esbuild appends a subpath to an alias
   target, so an `@hooknostic/sdk` alias to the SDK's `index` file would send
   `@hooknostic/sdk/schemas` to `<index>/schemas`. Bundling adds the `schemas`
   sibling of that file unless the caller aliases the subpath itself. This
   covers the project SDK alias and `evaluate.alias` in the programmatic API.

## Consequences

- Breaking for consumers that import a schema from the root: they import it
  from `@hooknostic/sdk/schemas` and keep `zod@^4.6.7` installed. Schema
  behaviour, types and Zod 4 composition are unchanged
  ([upgrading guide](../upgrading/sdk-schemas-subpath.md)).
- A project that only authors hooks and configuration installs
  `@hooknostic/sdk` and `hooknostic`. It can drop a `zod` it kept only for the
  SDK. Its artifacts still validate effects with Zod, taken from the CLI's
  install.
- An artifact's Zod copy can come from the CLI rather than the project, so
  its bytes and licence notices follow the CLI's resolved Zod. Committed
  artifacts are rebuilt whenever that resolution changes (ADR-0006).
- The SDK and CLI must move together, as the upgrading index already asks. An
  older CLI's shims import `effectSchema` from the root and fail to bundle
  against this SDK.
- Tests pin the boundary: the built root loads under a resolve hook that
  refuses Zod; the root declaration graph names no Zod module; and the
  simulated registry install builds a project that has no Zod, with peers not
  auto-installed. The packed-SDK check runs the same Zod-free case against the
  real tarball. It also builds an npm project that inherits a hoisted
  `zod@3.25.76` (GHSA-mrhx-c7xc-m3w5) with the packed CLI, and requires the
  CLI's in-range Zod in the artifact and HN109 from `check` and `build`. A
  pnpm project that declares `zod@3.24.4`, which pnpm links as the SDK's peer
  although it has no `zod/v4`, must get the same, with HN109 naming that
  Zod's store path.

## Alternatives considered

- **Make Zod a regular SDK dependency.** No author would install it, but the
  root would still load Zod at runtime. A consumer composing SDK schemas with
  its own Zod would get two copies: `instanceof` checks, `ZodError` identity
  and schema types would no longer line up across them. Upstream advises
  against this for libraries whose schemas consumers compose.
- **Keep the required peer.** That is the status quo, with every author
  installing a dependency only the schemas need and strict installs failing
  without it, for no benefit to the authoring API.
- **Publish the schemas as a separate package.** It would separate them as
  cleanly, but it adds a fourth lockstep package with its own first-publication
  bootstrap and trusted publisher (ADR-0014). A subpath gives the same boundary
  inside the package consumers already install.
