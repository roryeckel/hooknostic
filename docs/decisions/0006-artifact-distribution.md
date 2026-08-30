# Decision 0006 — Commit the built artifacts

**Status:** Accepted — 2026-08-30 · Referenced from code and docs as **ADR-0006**

**In short:** a consumer should commit `hooknostic build` output to their repository,
because that is the only arrangement in which the thing you review is the thing that
runs. The alternatives are not merely less convenient — each gives up a property the
rest of this project is built on.

## Context

This was never decided. `docs/installing-artifacts.md` presented committing and
building-in-a-setup-step as two options and recommended neither; `docs/design.md`
scoped distribution out of v0.1 entirely ("Distribution is separate from
compilation"). Meanwhile this repository git-ignored all of its own build output, so
the pattern was documented nowhere and practised nowhere.

The first real consumer committed its artifacts and built a substantial amount of
machinery around doing so — a rebuild-and-compare test, a line-ending pin, a scratch
build directory, a CI step. Reviewing that work, the reasonable question was whether
any of it was necessary or whether the consumer had scaffolded around a bad guess.
Every ingredient of the answer already existed in this repository. Nobody had
assembled them.

## Decision

**Commit the artifacts.** Four properties force it, and they compose:

1. **The artifact must be dependency-free.** `bundleRuntime` produces a self-contained
   ESM module and `packages/cli/src/package.test.ts` asserts no bare specifier
   survives bundling. That exists so a hook runs without `node_modules` present.
2. **It must be on disk before the session starts.** No target picks up a rebuild on
   its own; each harness reads a static file at load time and Hooknostic is not in
   that path.
3. **A missing artifact fails silently.** The harness runs *no* hooks and says
   nothing. For a guard that blocks destructive commands, silent absence is the worst
   available failure.
4. **Capability analysis is the product.** A `required` capability a target cannot
   support must be a build error, not a runtime surprise — which means there is a
   build step, which means there is output that has to live somewhere.

Given all four, committing is what makes an artifact reviewable. These files execute
on every session event; a diff is the only place a reader can see that change.

### Why not the alternatives

- **Build on `postinstall`.** The reviewed object and the executed object are never
  the same, so an incorrect or malicious artifact never appears in review. It is also
  inert wherever CI installs with `--ignore-scripts`, which is common.
- **Build in CI and commit from CI.** A bot commit per source change, broken for
  outside contributors, and it still needs the identical drift check to catch a hand
  edit. More machinery for the same guarantee.
- **No build step; read the config at runtime.** Gives up the dependency-free
  property, and Node cannot load a TypeScript hook entry without a flag — while Bun
  can, which is exactly the "works on my harness" trap this project exists to remove.
  It also moves capability analysis to runtime, where a portability failure becomes a
  surprise instead of a build error.

## Consequences

- **A consumer's diff will be large**, and mostly generated. Mark the output
  directory `linguist-generated=true` so review collapses it; do not use `-diff`,
  which would hide a hand edit — the reproducibility check is the real defence there
  and it is stronger than reading six thousand lines.
- **An edit to an imported module is not live until you rebuild**, because the build
  inlines it. This is the pattern's real cost and it is sharp: the person most likely
  to be caught is the one who just changed a guard and is still running the old one.
  Push the staleness check earlier than CI where the consumer can — a pre-commit hook,
  or whatever already runs at the end of a turn.
- **Reproducibility becomes load-bearing**, so it has to be true. It was not: artifact
  bytes depended on the directory the CLI was invoked from until ADR-0006's companion
  fix anchored esbuild to the project. A drift check that reports staleness when
  nothing is stale is worse than no drift check, because it teaches people to ignore
  it.
- **This repository now practises the model.** `examples/rewrite-shell` commits its
  output and CI rebuilds it and fails on any diff. A recommendation nobody follows,
  including its author, is not a recommendation — and that gap is precisely how the
  reproducibility defect survived.
- **Building in a setup step remains supportable** for a consumer who accepts the
  trade — chiefly that until they run it, their harness silently runs no hooks.
  `docs/installing-artifacts.md` keeps both, with this decision as the default.
