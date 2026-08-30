# 0008 — Harness version metadata as adapter-carried data

**Status:** accepted (2026-08-31)

## Context

Harness version facts were hand-duplicated across roughly twenty-nine sites:
a recommended-range triple in test constants, example configs and doc prose;
patch-version literals in eleven test invocation constants; adapter version
constants mirroring `package.json`; and fixture directory names derived from
nothing but convention. The duplication had already produced drift — a
profile-range example in `design.md` outlived two edits to the real profile —
and the only relating mechanism was `resolveCapabilityMatrix`'s runtime
subset check, which validates a caller's range but cannot stop prose from
rotting. `inspect` also defaulted to the *widest* validated range, a range no
consumer is told to target.

## Decision

1. **Every adapter carries `harness: HarnessMetadata`** — `displayName`,
   `recommendedRange`, `fixtureDir`, `referenceVersion` — the four scalars
   the repository's version literals derive from. Profiles record what was
   *validated*; the metadata records what is *recommended* and what the tests
   exercise. The two are deliberately distinct: a recommendation may be
   narrower than the evidence.
2. **Profile provenance is data, not prose.** `CapabilityProfile.source` is
   required and carries `validatedOn: ValidationRecord[]`
   (`{version, date, method, artifact?, what}`), whose `method` vocabulary
   mirrors the capture skill's provenance classes (with `router-log` carved
   for shapes observed below the hook boundary). `inspect --json` ships it;
   `doctor` reads it to report how stale our newest validation is.
3. **The contract suite audits the metadata** (works for third-party
   adapters): `fixturesDir` basename must equal `fixtureDir`;
   `recommendedRange` must resolve with no diagnostics; `referenceVersion`
   must satisfy it and be a `captured` build; every `validatedOn` version
   must fall inside some profile range; every profile needs at least one
   captured record. `AdapterContractOptions.version` defaults to the
   recommended range.
4. **Derive iff load-bearing.** A version literal derives from the metadata
   iff the test's pass/fail depends on matching real harness data. SDK/core
   test strings stay literal (those packages sit below the adapters — a
   derivation would be a layering inversion), as do out-of-range probes and
   deliberately-newer live-probe versions, each annotated.
5. **Ranges are linted; patch versions are recorded.** A range is a
   present-tense claim, so every adapter-adjacent range literal in tracked
   markdown must match the current metadata
   (`scripts/check-version-literals.mjs`). A patch version is a claim about a
   past observation and never goes stale, so the ~30 provenance mentions in
   comments and capture records are deliberately not scanned. Illustrative
   doc examples use fake harness names, which is what keeps the lint
   low-noise.
6. **`docs/harness-support.md` is generated** from the registry
   (`scripts/generate-harness-support.mjs`) and drift-gated in CI like the
   committed artifacts. Concrete config walkthroughs in docs keep their
   hand-written shape; the lint keeps their ranges honest.
7. **Assert versions, don't import manifests.** `adapterVersion` stays an
   inlined literal pinned by `versions.test.ts` to its `package.json` and the
   root; JSON-importing the manifest was rejected because the CLI bundle
   would resolve the wrong file via `createRequire` — silently, in the
   published artifact only.

## Rejected

- Defaultable consumer `TargetConfig.version` — the deliberate hand-picked
  range is the reproducibility story (`build` never consults installed
  versions); a default would make artifacts a function of the toolchain.
- Deriving fixture directory names from profile ranges — a directory name is
  a capture-time fact; equality is asserted instead so a range edit cannot
  silently repoint what the tests read.
- A `latestKnownHarnessVersion` field — stale by construction, unassertable.
- Modelling the per-fixture captured/doc-derived tables as data — a second
  matrix keyed differently from the capability matrix; `rationale` already
  carries the consumer-facing semantics.
