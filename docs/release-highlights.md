# Native Zod 4 schemas, and a start-up allowance for every deadline

0.12.0 makes the SDK's exported schemas native Zod 4 Classic, a breaking change
for SDK consumers, and stops charging a hook process's start-up to its handler
budget. Generated native deadlines add a 5-second start-up allowance above the
budgets your hooks declare. Published packages now require a patched minimatch
release and a patched Zod peer floor.

## What is included

- **SDK schemas are native Zod 4.** The `@hooknostic/sdk` schemas are Zod 4
  Classic objects and the package requires `zod: ^4.6.7` as a peer. Zod 3 schema
  composition is not interchangeable, and the V3 error API is gone: read
  `ZodError.issues` rather than the removed `.errors` alias. The CLI depends on
  a compatible Zod, so installing the SDK with the CLI is enough under a package
  manager that installs peers (npm 7+, pnpm 8+). Declare `zod` yourself only if
  your code imports it to compose SDK schemas, or if your package manager does
  not install peers. See the [Zod 4 upgrading guide](upgrading/zod-4.md).
- **A start-up allowance sizes every native deadline.** Each native deadline is
  `ceil((sum of the event's handler budgets + runtime.processAllowanceMs) /
  1000)` seconds. The allowance defaults to 5 seconds, is added once per native
  event because one dispatcher process serves every hook on it, and is build-time
  only — the bundled dispatcher never reads it. A harness that caps an event's
  timeout takes the smaller of the two, so a cap shrinks the allowance but never
  the handler budgets; only budgets that alone exceed the cap make a build
  refuse, as before. At defaults every generated native timeout grows by the four
  seconds the allowance gained, except where a cap leaves less room (Codex's
  `SessionEnd` keeps its 3-second ceiling). See
  [ADR-0039](decisions/0039-process-allowance.md) and
  [budget for what the hook waits on](writing-hooks-safely.md#budget-for-what-the-hook-waits-on).
- **Patched dependency floors.** Published packages require minimatch `^11.0.7`,
  which excludes the ranges affected by GHSA-cf2h-pxjq-68xw and
  GHSA-g3hv-75wg-m249. Scoped overrides point ESLint and typescript-eslint's
  minimatch consumers at the same release, so the workspace holds one copy. The
  SDK's `^4.6.7` peer floor excludes the Zod 3.25.76 distribution that carries
  the affected V4 parser described in GHSA-mrhx-c7xc-m3w5. semver 7.8.6,
  typescript-eslint 8.72.2, and Vitest 5.1.0 round out the routine updates. No
  published API changes with them.

## Upgrading from 0.11.0

- **Upgrade the SDK and CLI together.** Install the SDK release containing this
  migration with the matching CLI. If your project declares `zod` itself, for
  any reason, move it to `zod@^4.6.7` in the same step; an older Zod there
  conflicts with the SDK's peer:

  ```sh
  pnpm add -D @hooknostic/sdk hooknostic zod@^4.6.7
  ```

  Use regular dependencies instead where your application imports the SDK at
  runtime. Keep `@hooknostic/sdk`, `@hooknostic/agent-plugin`, and the
  `hooknostic` CLI on the same release.
- **Rebuild packages or re-sync projects.** Generated native timeouts and
  project artifacts change with the allowance, so a project integration created
  by 0.11.0 reports its hook files as modified until `sync` runs again. That
  report is expected; synchronize, then verify.
- **Update schema composition and annotations.** Compose SDK schemas with V4
  schemas throughout, replace V3-specific annotations with V4 types, and read
  error details from `.issues`. Issue codes and fields can differ from V3; avoid
  comparing complete messages or depending on V3-only issue types.
- **Expect the same boundaries to validate strictly.** The `input` key of
  `toolInvocationSchema` and the `raw` key of `baseHookEventSchema` are required
  (an explicit `undefined` still validates), integers now reject unsafe values,
  and symbol-keyed entries in authored maps are rejected with diagnostics. Event
  names, effects, capability IDs, and `schemaVersion: 1` are unchanged.
- **Leave hand-written native timeouts alone.** Only Hooknostic-generated
  deadlines gained the allowance; a timeout you maintain outside its artifacts
  is untouched.

## Limits

- **The SDK's peer floor does not reach your transitive dependencies.** Upgrading
  Hooknostic does not update other copies of Zod in your dependency graph; audit
  those separately.
- **The allowance is headroom, not a larger handler budget.** Handler timeouts
  are unchanged, a hung handler still ends at its budget, and the allowance
  covers only process start, stdin read, decode, and stdout flush.
- **A harness cap still bounds the deadline.** Defaults cover the measured
  1.5–2.0 second start-up under ordinary contention, not the capture's roughly
  9-second worst case under 96 busy-loop processes; raise
  `runtime.processAllowanceMs` on a host that needs more.
- **No harness support range claim changes.** The allowance is a build-time
  number that adds headroom to existing deadlines, and the Zod migration leaves
  the event, effect, capability, and distribution model in place.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
