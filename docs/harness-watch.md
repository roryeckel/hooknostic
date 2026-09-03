# Harness watch: scheduled harness-version compatibility automation

`.github/workflows/harness-watch.yml` keeps harness compatibility current
without manual polling: it detects newer harness builds on npm, verifies them
with the model-free playback suite, records passes into the rolling
scheduled-playback record, and files deduped issues on failures. Human
attention shrinks to approving a one-line PR or acting on a drift issue.

Implementation plan: repository issue #1. The policy decisions this page
summarizes live in ADR-0008 (version facts have one home), ADR-0009 (one
mutable rolling record), and ADR-0010 (capability coverage policy).

## Lanes and costs

| Lane | Job(s) | Cost | What it establishes |
| --- | --- | --- | --- |
| Detect | `detect` | Free, secret-free | npm dist-tag `latest` vs the playback baseline per harness |
| Playback verify | `verify` | Free, secret-free | The newer build passes model-free playback (artifact discovery, rewrite/block markers, lifecycle events) |
| Record | `record` | PAT job; never runs harness code | Pass → rolling `live-probe` record + PR; range exit → deduped issue |
| Report | `report-failure` | `GITHUB_TOKEN` only | Deduped failure issue with a runbook |

The drift capture-compare lane and the paid LLM lane are later plan steps
(issue #1 §6–7); their jobs gate on `verify`'s outcome the same way.

## What automation edits — and what it never touches

Automation writes exactly two things on a pass:

1. **The rolling scheduled-playback record** — the single marker-delimited
   `validatedOn` entry in the adapter profile, rewritten in place by
   `scripts/record-playback-validation.mjs` (ADR-0009). Evidence class stays
   `live-probe`; `.capture/harness-playback/` stays the artifact.
2. **`docs/harness-support.md`** — regenerated (`scripts/
   generate-harness-support.mjs`); it is generated, never hand-edited
   (ADR-0008).

Automation never moves `referenceVersion`, `fixtureDir`, `recommendedRange`,
or profile `range`. A build outside every profile range exits the record
script with code 3 and files a **range-extension issue** instead — range
extension is a human decision backed by real captures (harness-capture
skill). Unrelated narrow records (a router-log, a scoped live-probe) never
raise the playback baseline; one narrow probe must not suppress a full
scheduled run.

## Triggers

- `schedule: cron "23 5 * * 1"` — weekly, Monday 05:23 UTC, off-minute.
- `workflow_dispatch` with inputs `harness` (filter), `version` (pin a build
  under test, overriding the dist-tag), `force_llm` (reserved for the paid
  drift lane).

Scheduled workflows are disabled by GitHub after 60 days of repository
inactivity; the dispatch backstop is the documented recovery (`Actions →
Harness watch → Run workflow`). The `detect` job no-ops on forks.

## The verify leg, in detail

Per harness (matrix from detect's `--matrix` output):

1. `pnpm install --frozen-lockfile` for the workspace toolchain.
2. `npm install -g --ignore-scripts <pkg>@<latest>` — the newer build is
   installed with scripts disabled so no third-party postinstall runs; one
   retry for registry flakiness. **Verified during implementation**: each
   harness binary works under `--ignore-scripts`; if one genuinely needs
   scripts, the failure is loud (detection/detection test fails) and the
   fallback keeps the job secret-free with `persist-credentials: false`.
3. SDK + CLI bundles, then the playback suite with
   `HOOKNOSTIC_PLAYBACK=<harness>` and `HOOKNOSTIC_PLAYBACK_VERSION=<latest>`
   (`docs/testing.md`) — identical to CI's own playback job except for the
   version override.
4. Model credentials blanked; checkout runs `persist-credentials: false` so
   the installed package can never read a token.

The outcome (`pass` / `playback-failure` / `install-failure`) flows downstream
via an uploaded artifact (`watch-outcome-<harness>.json`), because GitHub
matrix jobs share one `outputs` map. The distinction matters: install failure
is a packaging problem; playback failure is behavior drift.

Known driver limitations are separate from that pass/fail outcome. The suite
writes each applicable limitation and capability-cell list to the verify job's
GitHub step summary as **Inconclusive scenarios**. They do not become passing
coverage merely because Vitest skips the corresponding driver; a decisive
claim still requires the relevant captured live procedure.

## The record leg, in detail

Gated on the outcome artifact being `pass`; never installs or runs the
harness. Sequence per harness:

1. **Idempotency**: if the open `harness-watch/<harness>` PR already names
   `<latest>`, skip.
2. `scripts/record-playback-validation.mjs <harness> <latest>` — guards in
   order: exit 3 = outside every profile range → range-extension issue (filed
   with `GITHUB_TOKEN`; the PAT deliberately has no Issues scope) and stop;
   exit 4 = baseline not advanced (already recorded / pinned-older dispatch)
   → clean skip, not a failure; exit 0 with `outcome=noop` on stdout = the
   idempotent rerun → skip the commit leg (a forced no-op must not reach
   `git commit` with an empty index); exit 0 otherwise = record written.
3. Gates: `pnpm build`, regenerate `docs/harness-support.md`, `pnpm lint`,
   `pnpm test` — each exit code captured explicitly.
4. Commit `chore(harness-watch): record <harness> <latest> playback
   validation` to branch `harness-watch/<harness>` (force-pushed, one branch
   per harness), open or update the PR (PAT), label `harness-watch`.
5. If the repo variable `HARNESS_WATCH_AUTOMERGE` is `true`:
   `gh pr merge --auto --squash`. **Off by default** — merging is the human
   decision; flipping the variable enables auto-merge with no code change.

All `gh` calls in this leg authenticate with `HARNESS_WATCH_PAT` (fine-grained:
this repository, Contents RW + Pull requests RW) because a branch pushed with
the default token does not trigger CI. The PAT needs no Issues scope: issue
steps override `GH_TOKEN: ${{ github.token }}` per step.

## Reporting and dedupe

- **Playback failure** → issue `harness-watch: <harness> <version> failed
  model-free playback`, label `harness-watch`, deduped by title search: an
  existing open issue gets a comment with the new run link instead of a
  duplicate. Body carries the outcome class, a local-reproduce command, and
  the runbook checklist.
- **Range extension** → same convention with its own title; it re-fires every
  week until resolved (out-of-range releases never advance the baseline), so
  the comment-or-create dedupe is what keeps it to one thread.

## Repository configuration (ops, not commits)

| Item | Type | Purpose |
| --- | --- | --- |
| `HARNESS_WATCH_PAT` | secret | Fine-grained PAT: this repo, Contents RW + Pull requests RW. Rotate like `RELEASE_PAT` (docs/releases.md). |
| `HARNESS_WATCH_AUTOMERGE` | repo variable | Opt-in auto-merge of record PRs; absent/false = human merge. |
| `harness-watch` | label | Created by the first run if missing. |

## Failure runbook

1. Read the issue's outcome class: `install-failure` (packaging/toolchain) vs
   `playback-failure` (behavior drift).
2. Reproduce locally:
   `pnpm --filter @hooknostic/sdk run bundle && pnpm --filter hooknostic run bundle`
   then
   `HOOKNOSTIC_PLAYBACK=<harness> HOOKNOSTIC_PLAYBACK_VERSION=<version> pnpm exec vitest run packages/cli/test/harness-playback.test.ts`.
3. Playback failure → follow the harness-capture skill; the failing
   scenario's driver names the capability family. Fixtures and ranges extend
   only with captured evidence; a failing scenario that pins an
   `unsupported` cell means the harness started honouring a channel —
   re-rate with fresh captures (ADR-0010's inverted watch).
4. Install failure → check the package's install scripts; if a harness
   genuinely needs them, adjust the verify step per the workflow comment
   (keep it secret-free, keep `persist-credentials: false`).
5. A transient pass on the next scheduled run closes the failure issue
   automatically (the reconciliation in the publish step, issue #1 §7 —
   arrives with the drift lane).
6. If scheduled runs stop (60-day auto-disable): dispatch manually, then
   commit anything — a push re-arms the schedule.
