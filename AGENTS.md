# AGENTS.md

Root guidance for AI coding agents working in this repository. `CLAUDE.md`
includes this file. Keep it lightweight: task-triggered workflows belong in
`.agents/skills/`, durable reference material in `docs/`. Use the `upskill`
skill before editing this file, `CLAUDE.md`, or anything under
`.agents/skills/`.

## Repository

hooknostic compiles portable agent hooks — one TypeScript source — into native
artifacts per harness (Claude Code, OpenAI Codex CLI, OpenCode). pnpm
workspace: library packages in `packages/`, runnable examples in `examples/`,
captured harness payloads in `fixtures/`, capture projects in `.capture/`.

- **Never run `npm publish` or `pnpm publish`** — not locally, not from an
  agent session. Publication happens only through
  `.github/workflows/release-publish.yml`, triggered by a human publishing a
  draft GitHub Release (`docs/releases.md`). Local distribution is
  `pnpm pack` tarballs only — `npm pack` does not rewrite `workspace:*`
  dependencies and ships broken tarballs.
- Do not push to any remote unless the owner asks.
- Downstream consumers are never named in this repository — not in code,
  docs, ADRs, commit messages, or capture records. Write "the pilot
  consumer" or "a consumer".

## Hard Rules

- **Never guess a harness shape.** Every claim about a harness — payload
  fields, tool argument keys, whether a channel is honoured — needs captured
  evidence, or explicitly recorded weaker provenance. Uncaptured shapes are
  declined, not defaulted. Use the `harness-capture` skill before adding or
  changing any such claim.
- **Normalization is additive.** Raw forms always survive: `tool.input` stays
  verbatim, `event.raw` is untouched, and absence of a normalized view is the
  documented signal to fall back to the raw form.
- Verification per commit: `pnpm lint`, `pnpm build`, `pnpm test`, capturing
  each exit code explicitly — never trust a piped or chained exit code.
  `pretest` bundles the SDK and CLI, so running `vitest` directly on a file
  tests a **stale bundle**; when targeting single files, first run
  `pnpm --filter @hooknostic/sdk run bundle` (and the CLI's bundle step, if
  the change touches `packages/cli`).
- A new test must be shown to fail against the defect it pins — revert the
  fix or apply a mutant, watch it fail, restore. This repository's history
  includes five tests that passed against the exact bugs they were written
  for.
- Committed example artifacts (`examples/rewrite-shell/dist` and
  `examples/agent-plugin/dist` -- the two `.gitignore` re-includes) must be
  rebuilt **from the repo root** in the same change as any source that
  affects them; CI byte-compares them (ADR-0006). Never hand-edit generated
  output.
- **Harness version facts have one home**: each adapter's `harness` metadata
  and profile `validatedOn` records (ADR-0008). A test literal derives from
  them iff its pass/fail depends on matching real harness data; SDK/core test
  strings and out-of-range probes stay literal. Illustrative doc examples use
  fake harness names and versions -- `scripts/check-version-literals.mjs`
  lints real-adapter range literals against the metadata, and
  `docs/harness-support.md` is generated, never edited.
- `HOOKNOSTIC_SMOKE=1 pnpm test` spawns real harnesses and has side effects
  (harness trust entries, cloud model calls). Run it only when the owner
  asks.

## Skills

Before specialized work, read the matching skill in
`.agents/skills/<name>/SKILL.md`. Each skill advertises its own triggers in
its frontmatter `description` — route by those. `.claude/skills` is the
Claude Code compatibility symlink to the same directory.

## Core References

- Architecture, wire protocols, composition rules: `docs/design.md`
- Decisions: `docs/decisions/` — changes to the semantic model (events,
  effects, capabilities, distribution) get an ADR
- New harness adapters: `docs/adding-an-adapter.md`
- Release flow (not yet in use — see Hard Rules): `docs/publishing.md`
- Capture projects and per-harness procedures: `.capture/*/README.md`
