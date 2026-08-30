# Adding a harness adapter

Adapters are internal workspace packages in v0.1 (`packages/adapter-<id>/`).
The contract is `HarnessAdapter` in `@hooknostic/core` — decode, apply,
capability data, artifact generation, detection — plus a shim that runs the
portable dispatcher inside the harness's native process model.

The definition of done is design.md Appendix C. In practice, follow the order
that built the first three adapters:

## 1. Capture reality before writing code

Do not implement from vendor docs alone. All three existing adapters found
doc drift only fixture capture (or binary/type inspection) revealed:

- Claude Code docs said `user_prompt`; the wire field is `prompt`.
- Codex docs describe plugin-bundled hooks; the installed CLI has
  `plugin_hooks` **removed**, and the working repo-level config differs from
  the documented one (PascalCase events, project trust, per-hook trust hashes).
- OpenCode loads only `*.ts`/`*.js` plugins (a `.mjs` module is silently
  ignored) and honors **in-place** args mutation, not reassignment.

Capture techniques that worked: stdin-teeing command hooks
(`.capture/claude`, `.capture/codex`), embedded JSON Schemas extracted from
vendor binaries, and published plugin type definitions (`@opencode-ai/plugin`).

## 2. Curate fixtures with provenance

`fixtures/<harness>/<version>/`:

- `<case>.input.json` — native payload/invocation, verbatim.
- `<case>.canonical.json` — expected decode result **minus `raw`**.
- `<case>.output.json` — expected apply/native-application result.
- `README.md` — provenance table: captured vs doc-derived vs schema-derived.

## 2b. Shell tools: ship a shape table, not a classifier

For every shell tool whose argument shape you have **captured**, add an entry
to a `ShellShapes` table (`{ commandKey, cwdKey? }`) and build your codec with
`shellCodec()` from the SDK. One table drives both directions: `classify`
populates `event.tool.shell` (including `commandKey`/`cwdKey` as escape-hatch
data), and `encode` lowers the portable `updateShell` effect under the same
keys. Expose the codec as `adapter.shellCodec`, and pass it into `dispatch()`
from your shim (`shellCodec: myShellCodec`) so rewrites re-derive the shell
view instead of leaving it stale.

Omit tools whose shape you have not captured — both directions then decline,
`event.tool.shell` stays undefined, and hooks fall back to `input`. Never
guess a key: a wrong entry silently rewrites the wrong field of a live tool
call.

Run the contract suite from your own package — it is the definition of done for
an adapter, and it is the same one the three shipped adapters run:

```ts
import { describeAdapterContract } from "@hooknostic/testkit";

describeAdapterContract(myAdapter(), {
  fixturesDir: resolve(import.meta.dirname, "../fixtures/1.0"),
  version: ">=1.0 <2",
});
```

It fails if any advertised observable event lacks a fixture, if fixtures exist
for unadvertised events, if a non-exact cell lacks a rationale, if a profile
lacks source/date metadata, if the matrix rates an unregistered capability id
(a typo there is silent — the matrix is `Partial`, so an unknown key simply
rates nothing), or if the adapter does not declare how its artifact executes, or if a fixture carries a
normalized `tool.shell` view that the adapter's shell codec does not round-trip
(classify the fixture's own input back to that view, and encode a command patch
that re-classifies to the patched command).

An adapter shipped from this repository also has to be added to `SUBJECTS` in
`packages/cli/src/coverage.test.ts`, which asserts it matches the default
registry so a new adapter cannot skip the suite by omission.

## 3. Capability profile

Versioned data, not code (`profile.ts`): `{ range, matrix, source }`. Absent
capability = unsupported. Be honest — an `unsupported` cell with a rationale
is worth more than an optimistic `emulated`. The compiler resolves overlapping
ranges to the least-capable guaranteed intersection; never assume the newest
profile for a broad range.

## 4. Decoder / encoder

- **Tolerant reader**: validate only what the canonical event needs; keep the
  whole native payload in `raw`; never invent correlation IDs.
- **Strict writer**: emit only documented native fields; preserve
  event-specific blocking distinctions (e.g. never exit-2 where the harness
  doesn't honor it).
- Throw the adapter's `DecodeError` for unmapped vendor events; shims treat it
  as fail-open.

## 5. Shim + generation

- `shim.ts` runs `dispatch()` against the native process model (subprocess
  stdin/stdout for command-hook harnesses; in-process callbacks otherwise) and
  applies effects natively. Export it from a `./shim` package subpath so
  generated bundles never pull in compile-time machinery (core/esbuild).
- The shim's **value** imports must stay on `@hooknostic/sdk` and
  `@hooknostic/runtime`. `@hooknostic/core` may only be imported with
  `import type` (erased at bundle time): one value import of it drags esbuild
  into every generated artifact, which more than tenfolds the bundle and makes
  it unimportable under plain Node (`Dynamic require of "fs" is not
  supported`), even where a Bun-hosted harness happens to tolerate it. Shared
  runtime helpers therefore belong in the SDK — `hookAppliesToTarget` lives
  there for exactly this reason. `scripts/bundle.mjs` fails the build if a
  shim bundle carries esbuild's CommonJS interop shim.
- `shimEntry()` returns the per-target entry-module source; `shimAliases()`
  maps the shim specifier (`@hooknostic/adapter-<id>/shim`) to a concrete path
  (`createRequire` resolution for the monorepo).
- Declare `shimExecution`: `"command"` if the harness spawns the artifact
  (`node <artifact>`), `"module"` if it imports it in-process. It is what makes
  the HN502 main-module-guard warning accurate — the guard can only fire where
  `process.argv[1]` is the artifact itself. Leaving it undeclared silently
  disables that diagnostic for the target.
- The published CLI cannot resolve workspace packages, so add the adapter's
  `src/shim.ts` to `SHIMS` in `packages/cli/scripts/bundle.mjs`. It ships as
  `dist/shims/<id>.mjs` (runtime inlined, SDK external) and
  `defaultAdapterRegistry()` routes the shim specifier there automatically.
- `compile()` emits a self-contained artifact directory. Artifact paths are
  unique POSIX-style relative paths (validated before staging as HN301) and
  `executable: true` yields mode 0o755; use exec/argument forms, never
  interpolate payload data into shell strings. Throwing from `compile()` or
  `validateArtifacts()` fails the target with HN301 — it never crashes the build.
- Persistent process models must not expose module memory as portable state
  ([Decision 0002](decisions/0002-invocation-stateless-contract.md)) — add an
  invocation-statelessness test.

## 5b. Detection

`detect()` is optional and advisory: only `doctor` reads it, and `build` never
consults a locally installed harness. Implement it with
`detectCommandVersion()` from `@hooknostic/core` rather than spawning yourself:

```ts
async detect(): Promise<DetectionResult> {
  return detectCommandVersion("myharness", {
    notFoundDetail: "myharness CLI not found on PATH",
  });
}
```

The helper exists because the Windows path is easy to get wrong twice over. A
harness installed from npm is a PATHEXT shim (`myharness.cmd`), which `spawn`
will not resolve without a shell — so a detector without one silently reports
"not detected" for a perfectly good install. But Node 24 deprecates passing an
args *array* alongside `shell: true` (DEP0190: the args are concatenated onto
the command line, not escaped), so the naive fix prints a security deprecation
over `doctor`'s output on every run. The helper takes the shell path with the
whole line as the command and no args, and refuses any probe part that would
need quoting.

## 6. Tests

Decode fixtures, apply fixtures, generation determinism + self-validation,
golden round-trip (native → decode → real handlers → apply → expected native),
and an opt-in real-harness smoke test gated on `HOOKNOSTIC_SMOKE=<id>` that
verifies at least one blocking effect and one mutating effect end-to-end.

## 7. Register

Add the adapter to `defaultAdapterRegistry()` in `packages/cli/src/registry.ts`,
its shim to `SHIMS` in `packages/cli/scripts/bundle.mjs`. The coverage audit
reads the registry, so registering is what enrols the adapter in it — there is
no second list to update. The simulated registry install in
`packages/cli/src/package.test.ts` must still pass. Update
`docs/baseline-<date>.md` with the verified native facts and their sources.
