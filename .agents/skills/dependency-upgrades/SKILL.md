---
name: dependency-upgrades
description: Work through every open version upgrade mostly autonomously — Renovate PRs (`renovate/` branches, "chore(deps)" titles), the Dependency Dashboard issue (pending-approval majors, awaiting-schedule, lock file maintenance), Dependabot/vulnerability alerts, and harness-watch record PRs and issues (`harness-watch/<harness>` branches, playback-failure and range-extension issues). Use when asked to "handle the upgrades", update or bump dependencies, review or merge Renovate or harness-watch PRs, approve a major on the dashboard, research breaking changes, or when touching `renovate.json`, `pnpm-workspace.yaml` catalogs, `packageManager`, `.github/node/*/.node-version`, `.github/requirements/*.txt`, or Action `uses:` pins.
---

# Dependency upgrades

Drive every open upgrade to a verdict — merge-ready, needs-fix, hold, or
decline — with researched evidence, then merge what the owner approves. The
bots do the mechanical work; this skill supplies the research and judgment
they cannot.

## Required context

- `docs/dependencies.md` — who owns each version (Renovate, manual decision,
  harness-watch), the update policy, the artifact-refresh loop, and the dated
  decision records. Read the records before re-deciding anything they cover.
- `docs/harness-watch.md` — lanes, what automation may edit, and the failure
  runbook. `docs/testing.md` for local playback.
- `renovate.json` — groups, `allowedVersions` lines and disabled managers are
  deliberate; a pinned line is a decision, not staleness.
- The `harness-capture` skill before any harness range, fixture or
  `referenceVersion` change.

## Ground rules

- **Bot PRs first.** If Renovate or harness-watch has a PR — or can be made
  to open one (a dashboard checkbox, a harness-watch dispatch) — review and
  validate that PR. Do not reproduce a bump on a local branch. Local branches
  are for prerequisite compatibility fixes and for items the bots are
  configured never to touch (the `engines` floor, the compatibility
  `.node-version`, named-catalog major lines, `@types/node` major, the
  TypeScript API line, harness ranges and reference builds).
- **Never push onto a `renovate/` branch.** This checkout's commit author is
  in `gitIgnoredAuthors`, so Renovate treats such commits as its own and
  discards them on its next rebase. `harness-watch/*` branches are
  force-pushed by the workflow — same outcome. Land fixes as a separate PR to
  `master`, then rebase the bot PR (below).
- **Do not trust the version number.** Risk comes from the package's role in
  this repository, not from semver (next section).
- **Merging is the owner's call.** Merge only PRs the owner approved in this
  session, at the head SHA you validated. Never merge past a red or missing
  required check, never enable auto-merge, never close a bot PR (Renovate then
  ignores that version for good) without approval.
- Never weaken the guards to make an update land: `minimumReleaseAge`, engine
  ranges, `allowedVersions`, dedupe checks, or lint/test configuration.
- No `HOOKNOSTIC_SMOKE` runs and no `force_llm` dispatches unless the owner
  asks. Never name a downstream consumer.

## 1. Inventory

Build one ledger (a scratchpad file) with a row per item: source, packages
and `from → to` (the currently **resolved** version, from `pnpm-lock.yaml`,
not the manifest range), risk tier, research, validation, verdict.

```bash
gh pr list --state open --author app/renovate
gh pr list --state open --label harness-watch
gh issue list --state open --label harness-watch
gh issue list --state open --search "Dependency Dashboard in:title"   # then gh issue view <n>
gh api "repos/{owner}/{repo}/dependabot/alerts?state=open"
gh run list --workflow harness-watch.yml --limit 5
```

From the dashboard record every section: Pending Approval, Awaiting Schedule,
Rate-Limited, Errored, Edited/Blocked, Open, and any warning banner at the top.
A grouped PR is one row per member package.

## 2. Classify risk by role

**High** — full research for every jump, patch included:

- Runtime dependencies of published packages (`packages/sdk`, `packages/cli`,
  `packages/agent-plugin`) and the `zod-peer` catalog: consumers inherit
  their engines, peers and behavior.
- Anything bundled into the committed example artifacts (MCP server, Zod, the
  standalone `examples/agent-plugin/runtime/`).
- The build chain: `esbuild` (0.x — its minors are breaking by policy),
  TypeScript (`@typescript/native` and the TS 6 API alias; TypeScript does not
  follow semver), `typescript-eslint` (bound to that API line), and `pnpm`
  (lockfile format, catalog and `workspace:` rewriting in `pnpm pack`,
  release-age enforcement, Plug'n'Play behavior).
- Node runtime files: CI, playback and publishing lanes.
- Infrastructure that decides pass/fail: `vitest`, `node-pty`,
  `@xterm/headless` (the pty lane). A regression here can make tests pass
  vacuously rather than fail.
- Translators and validators: `litellm` (behavior changes ship in patch
  releases) and the Renovate validator image (schema vs the hosted app).
- Any 0.x package; any major; any GitHub Action major.

**Medium** — every intervening release note: other dev tooling whose output
is checked (`prettier`, `eslint` and its plugins, `@types/*` within the
allowed line).

**Low** — skim: leaf dev dependencies with no checked output.

## 3. Research

Items are independent — fan research out to subagents, one per high-risk
item, and give each the package, the exact `from → to`, and where the repo
uses it. For every package:

1. Read the notes for **every release between resolved and target**, not just
   the target: GitHub releases, `CHANGELOG`, migration guides. Renovate's PR
   body is a starting point; it truncates.
2. Diff the published manifests and code, which catches what changelogs omit:
   `npm view <pkg>@<v> engines peerDependencies dependencies exports type bin
   deprecated --json` for both versions, and
   `npm diff --diff=<pkg>@<from> --diff=<pkg>@<to> --diff-name-only`, then
   the files that matter. These download tarballs; never execute them.
3. Map each change onto this repository: grep the imported APIs, options, CLI
   flags and config keys actually used. Record "relevant" or "irrelevant"
   per change, with the evidence link. Also check new or changed **peer**
   entries in the PR's lockfile diff: pnpm may now link a workspace alias
   into the package, which can switch behavior without any manifest change.
4. Check what the bump makes stale: `.capture/` records, docs and test
   comments that describe this tool's behavior at the old version. A pinned
   capture stays true for its version; anything stated as current needs a
   re-capture or version qualification as a follow-up.
5. For runtime and lane bumps (Node files, Actions runners), list what
   coverage the change removes — for example, no CI job left on a Node major
   the `engines` range still promises. A coverage loss is a policy decision
   for the owner, not a research footnote.
6. Check engines against the supported range in the root `package.json`; an
   engine above the floor is a blocker, not a warning (see the 2026-10-04
   compatibility trials in `docs/dependencies.md`).
7. When evidence stays ambiguous on a high-risk item, run an isolated probe in
   a detached worktree at a short path (for example, an engine-strict install
   on the Node floor, or a targeted script against the new API). Probes never
   touch product source.

## 4. Validate on the bot PR

CI on the PR head is the primary validation: it runs the three-OS test
matrix, the Node floor lane, every playback lane, marketplace installs,
dependency extraction and the artifact gates.

- `gh pr checks <n> --required` on the current head SHA. Record the SHA.
- Readiness red with no artifact successor, `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`,
  or stale-head skips: follow "Artifact refresh" in `docs/dependencies.md`.
  Every check failing at once may be an exhausted Actions budget, not code —
  confirm before reading logs.
- Review the generated diff (`examples/*/dist`) against the research: version
  strings, notices, bundle sizes. An unexplained size jump means a duplicate
  copy — see the 2026-11-01 dedupe record.
- For a high-risk test or compiler bump, show the gate still bites: in a
  detached worktree of the PR head, apply a known mutant (or a known type
  error) and confirm it still fails under the new version. Run
  `pnpm run bundle` before targeted `vitest` runs.
- Green CI only covers what CI exercises. For a high-risk item, list the
  behaviors this repository relies on that no check exercises (for LiteLLM:
  the system-message callback and `additional_drop_params`; the CI probe
  checks only routing). Probe those in scratch on both the old and new
  version, then break the config and confirm the probe fails. If such a
  probe is cheap and loopback-only, propose adding it to the repository.
- Local full gates are needed only for what CI cannot show. Use a clean
  detached worktree, `CI=true pnpm install --frozen-lockfile`, then capture
  each gate's exit code separately.

## 5. Act on each item

| Situation | Action |
| --- | --- |
| Research clean, required checks green | Verdict merge-ready. Post the research summary as a PR comment. |
| Needs a code change | Open a compatibility PR to `master` that tolerates both versions where possible, with a test shown failing against the new version first. After it merges, rebase the bot PR. |
| Upstream regression, release-age wait, or blocked on another item | Hold; comment why and what unblocks it. |
| Not viable within the supported range | Recommend decline with evidence; the owner decides. A lasting decision gets a dated record in `docs/dependencies.md`. |
| Dashboard Pending Approval (majors) | Research first. If viable, tick its checkbox so Renovate opens the PR, then validate that PR. If not, record why and leave it pending. |
| Awaiting Schedule / lock file maintenance | Leave scheduled unless it carries a security fix or the owner asks. |
| Vulnerability alert with no PR | Check the dashboard for a security branch first; if Renovate cannot fix it (no patched release in range), follow the override pattern in the 2026-11-13 minimatch record. |
| harness-watch record PR | Diff must touch only that lane's profile record and `docs/harness-support.md`; checks green → merge-ready. |
| harness-watch failure issue | Classify the outcome from the run log (`gh run view <id> --log-failed`) via the runbook, and read the drift report (`gh run download <id> -n drift-verdict-<harness>`). Infrastructure or registry flake → re-dispatch `gh workflow run harness-watch.yml -f harness=<h> -f version=<v>`. Real drift is adapter work, not an upgrade: reproduce locally per the runbook and hand it to the `harness-capture` skill as its own task. |
| harness-watch range-extension issue | A human decision backed by captures; prepare the evidence, do not extend the range. |

**Rebasing a Renovate PR:** tick its `rebase-branch` checkbox in the
dashboard body — `gh issue edit <n> --body-file <file>` with that one
`- [ ]` turned to `- [x]`, nothing else changed. Never `gh pr update-branch`
a Renovate branch. Harness-watch branches may be updated with
`gh pr update-branch`.

## 6. Merge what the owner approves

Present the ledger, then ask once for approval covering the named PRs. Merge
in this order: security fixes, CI and tooling, npm non-major, majors, lock
file maintenance — each with
`gh pr merge <n> --squash --match-head-commit <validated-sha>`.

Branch protection requires an up-to-date branch, so each merge leaves the
remaining PRs behind. Wait for Renovate's rebase (or tick the checkbox), then
for fresh required checks on the **new** head, and re-review any changed
artifact diff before merging the next. A head that changed for any reason
other than a rebase needs fresh research for the change.

## 7. Report

Finish with the ledger: each item's PR or issue link, tier, research summary
with source links, validated head SHA and check-run link, verdict, and action
taken. List what is held and what unblocks it. Decisions that outlive this
run — a declined major, a retained line, an override — belong in a dated
section of `docs/dependencies.md`, landed as a normal reviewed PR.
