---
name: extend-vocabulary
description: Checklist for growing the portable vocabulary — adding or changing an Effect, capability id, diagnostic code (HNxxx), hook event, ToolKind, ShellShapes entry, or anything in packages/sdk/src/{effects,capabilities,schemas,tools,result}.ts, packages/runtime/src/dispatch.ts, or an adapter's profile.ts/toolmap.ts/apply.ts.
---

# Extending the vocabulary

The SDK's types are the portable contract; every extension has a set of twin
surfaces that must move together, and each has silently shipped an inert or
wrong feature when edited alone. Work through the checklist for what you're
adding; finish with the shared tail.

## First: does this need an ADR?

A new effect, capability semantics change, or normalization decision is a
semantic-model change — write or extend `docs/decisions/` (see ADR-0001,
0005, 0007 for the register). A mechanical addition inside an existing
decision does not.

## New or changed Effect kind

- `packages/sdk/src/effects.ts`: interface + constructor + union member, and
  the two **total records** — `EFFECT_CAPABILITY_SUFFIX` and
  `TERMINAL_EFFECT`. They are `Record<EffectKind, …>` precisely so the build
  breaks until "which capability licenses this?" and "does it end the
  dispatch?" are answered. `EFFECT_KINDS` derives from them; never restate
  the kind list anywhere else.
- `packages/sdk/src/schemas.ts`: the `effectSchema` union member, **in the
  same edit** — the schemas are `.strict()`, so a field added to an interface
  but not its zod twin is rejected at dispatch as HN401 while compiling
  clean. This trap has bitten four separate times.
- `EffectForCapability` in effects.ts (longest-suffix-first ordering).
- `packages/runtime/src/dispatch.ts`: an apply case in the effect switch. If
  the effect is portable-but-lowered (like `updateShell`), lower it in
  dispatch to an existing kind and mark the synthesized entry with
  `loweredFrom`, so the three adapter `apply.ts` reducers stay untouched —
  they each independently resolve `kind === "replaceInput"` and a new kind
  slipping past them diverges per adapter.
- Docs: effect list in `docs/design.md` §7, table in `docs/concepts.md`,
  composition rule 4 if terminality changed.

## New capability id

- Append to `ALL_CAPABILITY_IDS` (`packages/sdk/src/capabilities.ts`).
- Rate it in **all three** `packages/adapter-*/src/profile.ts` matrices;
  non-exact levels need a rationale (testkit-enforced, and rendered to users
  by `inspect`).
- Ask first whether the real gate is per-target at all: per-invocation
  knowledge (like tool shape coverage) cannot live in a build-time matrix —
  reuse the existing capability and document a runtime feature-detect
  instead (ADR-0007's reasoning).

## New diagnostic code

- `DIAGNOSTIC_CODES` in `packages/core/src/diagnostics.ts`; if the runtime
  can raise it, also `RUNTIME_DIAGNOSTIC_CODES` in
  `packages/sdk/src/result.ts` (deliberate duplication — the SDK cannot
  import core; core asserts the subset matches, so drift is a compile error).
- Code table in `docs/design.md` and `docs/glossary.md`. Codes are stable:
  never renumber (the misfamilied HN502 is documented, not renumbered).

## Shell shape / toolmap entry

Capture first — load the `harness-capture` skill. Then: one `ShellShapes`
entry per captured tool; both codec directions derive from it, and the
testkit round-trips every shell-bearing fixture. Uncaptured tools stay
absent.

## New adapter

`docs/adding-an-adapter.md` is the authoritative workflow (capture → fixtures
→ profile → decode/apply → shim → `describeAdapterContract` +
`packages/cli/src/coverage.test.ts` SUBJECTS row).

## Shared tail (every extension)

1. Shims must never value-import `@hooknostic/core`
   (`packages/cli/src/package.test.ts` enforces; it drags esbuild into every
   artifact).
2. Mutation-verify each new test against the defect it pins (AGENTS.md hard
   rule).
3. Rebuild `examples/*/dist` from the repo root; the reproducibility gate
   byte-compares.
4. Full gates with explicit exit codes: `pnpm lint`, `pnpm build`,
   `pnpm test`.
5. Update tutorials/README snippets that teach the old surface — the front
   page and tutorials 01–03 all carry live hook bodies that have drifted
   before.
