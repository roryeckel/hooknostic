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
- Codex's working repo-level config differs from the documented one
  (PascalCase events, project trust, per-hook trust hashes). Its plugin hooks
  are the sharper lesson: read as **removed** from the 0.148.0 binary, they
  demonstrably fire on 0.153.2 (`.capture/codex-plugin-hooks`), and a projector
  was built on the wrong reading in between. A captured fact carries the version
  it was captured at, and re-probing on a harness bump is part of the job.
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
- Declare `publishesNpmPackage: true` only if package delivery emits a manifest
  npm publishes the artifact under. That is what lets a target set `npmName`;
  undeclared, core refuses the coordinate at analysis, before anything is
  bundled, rather than letting it sit in the config doing nothing. The emitted
  manifest is still checked after generation, and a mismatch there is reported
  as an adapter defect rather than a configuration one, so both must agree —
  the declaration exists because emitting a root
  `package.json` is not the same as publishing one, and adapters that never
  read `npmName` emit one anyway (a copied source manifest, a
  `components.runtimePackage` install input). The reasoning is recorded in
  [Decision 0011](decisions/0011-agent-plugin-native-projection.md).
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

## 5c. Agent Plugin projector (optional)

Only if the harness has a plugin format that can carry skills and MCP servers.
Without one, omit `agentPluginProjector` — a target listed under
`components.targets` whose adapter has no projector is an HN205 error, so the
capability is never silently assumed.

A projector is `AgentPluginProjector` from `@hooknostic/agent-plugin`:
`namespace`, `profiles`, and `project(source, context)` returning
`{ files, directories?, issues, summary }`. Core stages `files` as the target's
entire output.

- **Emit the harness's format, not the portable one.** A harness that appears to
  read Agent Plugins directly is the trap, not the shortcut: Codex installs a
  root `plugin.json` and discovers its skills, but that manifest *outranks* the
  native one, and Agent Plugins 1.0 defines no hook component — so a package
  carrying both loads its skills and silently ignores every hook. Replace the
  portable documents; never ship one beside its replacement
  ([Decision 0011](decisions/0011-agent-plugin-native-projection.md)).
- **Carry every hook artifact through.** The projection replaces the output, so
  the projected package is also the hook channel. Core fails the target with
  HN301 if any `context.hookArtifacts` path is missing from the plan. Contents
  may be rewritten — Claude merges its own hooks document into the generated one
  — but a path may not be dropped, because the result installs cleanly and runs
  nothing.
- **Re-probe the capability, not the harness.** A fact established on one route
  into a harness is not evidence for another. Codex implements the Agent Plugins
  placeholder contract on the portable manifest route and none of it on the
  native one, so moving the projection between them silently turned working
  `${PLUGIN_ROOT}` argvs into literal text while the component still reported
  `exact` (`.capture/codex-agent-plugin` vs `.capture/codex-native-mcp`).
- **Ship the package, not the components you recognise.** An MCP server names its
  implementation with `${PLUGIN_ROOT}/...`; copying only the trees you translate
  leaves that argv pointing at a file the output does not contain.
- **Check whatever else makes the hooks unreachable.** Path presence is all core
  can verify; the rest is yours. A Codex target in `project` delivery generates
  `.codex/hooks.json` with a session-relative command, which satisfies the core
  check and which the native manifest has no key for, so the projector rejects
  that combination itself. Anchor generated commands the way an install cache
  requires (`${PLUGIN_ROOT}` for Codex; a relative path resolves against the
  session cwd and finds nothing).
- **`namespace` only for a client extension the projector can deliver.** Set it
  to an evidence-backed reverse-DNS contract that the harness consumes natively
  or that `project` translates faithfully into the harness's format, and to
  `""` otherwise. Codex is the bridge case: OpenAI documents `com.openai`, but
  0.154.0 ignores a supported inline hook declaration, so its projector carries
  that object into the native manifest. Inventing a namespace still makes
  `agent-plugin.client-extension.files` discoverable without a contract and
  falsely reports the component as projected.
- **`unsupported` means the component must not reach the harness**, not merely
  that it will be ignored. Codex picks an MCP transport from `command` vs `url`
  and ignores the portable `type`, so a passed-through `sse` server becomes a
  `streamable_http` connection to the same url — a wrong-protocol connection is
  worse than an absent component. Drop it, record an omission, and raise an
  issue at `context.onUnsupported` so `warn` policy still builds.
- **`exact` when the harness implements the contract, `emulated` when you
  implement it for the harness.** An interposed process is not the
  discriminator — Claude's stdio projection is `exact` and has shipped a
  launcher for a while, because Claude itself expands the placeholders, binds
  `PLUGIN_ROOT` and `PLUGIN_DATA`, and owns the data directory. Codex and
  OpenCode are `emulated` for the mirror-image reason: generated code supplies
  all of that, and the data directory is one Hooknostic chose, so a different
  client will not find what a server wrote there.
- **State whether the harness supplies `PLUGIN_ROOT` and `PLUGIN_DATA`, or your
  projection does.** Agent Plugins 1.0 requires both, absolute, in *every* stdio
  subprocess environment — not only when a placeholder appears. If the harness
  binds neither, a launcher is the only mechanism left, and `PLUGIN_DATA` must
  live somewhere an upgrade will not delete: check whether the harness installs
  into a version-scoped directory before choosing a location inside it.
- **Declare where the hook runtime lands, and where the package lands.**
  `hookRuntimePath(delivery)` names the path `compile()` writes the runtime to,
  and the projector's `packageRoot` names the directory package files are
  copied into when it is not the output root. The build derives
  `ctx.plugin.root` from the two (ADR-0020), and the contract suite fails if
  `hookRuntimePath` disagrees with `compile()`. Leave both undeclared and your
  target simply offers no `ctx.plugin`.
- **Read support from `context.support`, never re-derive it.** Core resolves
  your own `profiles` against the target range and hands them back, so a
  projector cannot disagree with the matrix the build reports and
  `onUnsupported` acts on.
- **A harness that departs from the specification for some packages has a
  deviation, not a lower level** (ADR-0019). The test is whether every
  instance is affected. If only a package containing certain text is treated
  differently, and you emit it anyway, do three things:
  1. Declare `{ id, summary, evidence }` under that component's `deviations`.
     The evidence must be one of the profile's `validatedOn` artifacts.
  2. Report each instance in `summary.deviations` (or
     `ProjectIntegration.deviations`), but only when `context.support` declares
     the id for that component.
  3. Leave severity to core. It applies `components.onDeviation`, and it fails
     the target if you report an id the resolved profile does not declare.

  Claude's `mcp-environment-expansion` is the worked example.
- **A translation your projection cannot apply to some items is a
  degradation** (ADR-0022). The item still ships, but not at the component's
  level. Declare `{ id, summary, evidence }` under that component's
  `degradations`, report each instance in `summary.degradations`, and leave
  severity to core, which applies `components.onDegraded` and
  `components.accept`. Make the declaration the switch: apply the
  translation only when `context.support` declares it, so a profile that no
  longer needs it turns both off. OpenCode's `skill-name-unqualified` is the
  worked example (ADR-0021).
- **A target option your projector reads changes the support it reports.**
  Declare it (as `qualifiesSkillNames` does for `skillNames`) so core refuses
  it on targets that would ignore it, and implement `supportFor(target,
  matrix)` to return the matrix that option produces. Profiles stay facts
  about the harness; the option's effect lives in one pure function.
- **`summary.copiedPaths` lists byte-for-byte copies only.** Everything else in
  the plan is treated as generated — that is how core separates the two without
  knowing your path layout, and it drives `artifacts` in the build report.
- **Build `summary.components` with `componentSummary`.** It mirrors core's own
  discovery, so a component the analysis phase counted cannot vanish from the
  report that replaces those counts. Pass your `namespace`, whether a
  `runtimePackage` is configured, and a `skipped(component, discovered)` verdict
  for whatever this harness will not consume; presence is decided for you.

Profiles are versioned data with rationale, exactly like the capability matrix,
and `scripts/generate-harness-support.mjs` renders them into
`docs/harness-support.md`; regenerate it when they change. Probe the package
format the way §1 says to probe the hook wire — the shipped projectors' levels
come from real installs (`.capture/claude-marketplace-deps`,
`.capture/codex-plugin-hooks`, `.capture/opencode-agent-plugin`), and the one
that does not says so in its rationale rather than guessing a level.

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
