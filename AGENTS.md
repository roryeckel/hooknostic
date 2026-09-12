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

- **Agents never run `npm publish` or `pnpm publish`.** Routine publication is
  workflow-only through `.github/workflows/release-publish.yml`, triggered by
  a human publishing a draft GitHub Release. The sole local exception is the
  owner performing the first-package 2FA bootstrap from verified CI-built
  tarballs (`docs/releases.md`); this is not permission for an agent to publish.
  Local distribution is `pnpm pack` only — `npm pack` does not rewrite
  `workspace:*` dependencies and ships broken tarballs.
- Push freely to a fork; never push to the upstream repository unless the
  owner asks.
- Downstream consumers are never named in this repository — not in code,
  docs, ADRs, commit messages, or capture records. Write "the pilot
  consumer" or "a consumer". The reason is load-bearing, not cosmetic:
  adapters are justified by captured harness evidence, never by one user's
  needs, and anonymity keeps that honest.
- Contributions are governed by `CONTRIBUTING.md`, which carries the
  canonical scope statement. Link to it rather than restating it.

## Hard Rules

- **Never guess a harness shape.** Every claim about a harness — payload
  fields, tool argument keys, whether a channel is honoured — needs captured
  evidence, or explicitly recorded weaker provenance. Uncaptured shapes are
  declined, not defaulted. Use the `harness-capture` skill before adding or
  changing any such claim.
- **Normalization is additive.** Raw forms always survive: `tool.input` stays
  verbatim, `event.raw` is untouched, and absence of a normalized view is the
  documented signal to fall back to the raw form.
- Verification per commit: `pnpm lint`, `pnpm format:check`, `pnpm build`,
  `pnpm test`, capturing each exit code explicitly — never trust a piped or
  chained exit code. `pretest` bundles agent-plugin, SDK, and CLI; direct
  `vitest` can test a **stale bundle**. Before targeting single files, run
  `pnpm run bundle`.
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
- Three tiers of harness verification, in increasing cost. `pnpm test` alone
  replays captured fixtures. `HOOKNOSTIC_PLAYBACK=<harness>` drives the real
  harness binary against a loopback model server — no credentials, no spend,
  and it is what CI runs, so an adapter change should clear it before review
  (`docs/testing.md`). `HOOKNOSTIC_SMOKE=1 pnpm test` spends real model
  credits and has side effects (harness trust entries); run it only when the
  owner asks.

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
- Contributor-facing scope, gates, and the adapter maintenance contract:
  `CONTRIBUTING.md`
- Harness verification without model spend: `docs/testing.md`
- Scheduled harness-version automation (lanes, runbook, PAT/vars):
  `docs/harness-watch.md`
- Release flow: `docs/releases.md` (packaging story: `docs/publishing.md`)
- Capture projects and per-harness procedures: `.capture/*/README.md`
