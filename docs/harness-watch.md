# Harness watch: scheduled harness-version compatibility automation

`.github/workflows/harness-watch.yml` keeps harness compatibility current
without manual polling: it detects newer harness builds on npm, verifies them
with the model-free playback suite, records passes into the rolling
scheduled-playback record, and files deduped issues on failures. Human
attention shrinks to approving a one-line PR or acting on a drift issue.

Implementation plan: repository issue #1. The policy decisions this page
summarizes live in ADR-0008 (version facts have one home), ADR-0009 (one
mutable rolling record), and ADR-0010 (capability coverage policy).

For a release rehearsal, dispatch the candidate branch with `harness=opencode-v2`,
pin `version` to the v2 reference build from adapter metadata, set `dry_run=true`,
and leave `force_llm=false`. Verification and free drift capture run; record,
issue, and comment writers are skipped. Inspect the run's verification summary
and uploaded drift artifacts. This does not advance either family's rolling
record. The local lane tests exercise record advancement in a scratch copy and
check that v1 remains unchanged.

## Lanes and costs

| Lane | Job(s) | Cost | What it establishes |
| --- | --- | --- | --- |
| Detect | `detect` | Free, secret-free | npm dist-tag `latest` vs the playback baseline per harness |
| Playback verify | `verify` | Free, secret-free | The newer build passes model-free playback (artifact discovery, rewrite/block markers, lifecycle events) |
| Record | `record` | PAT job; never runs harness code | Pass → rolling `live-probe` record + PR; range exit → deduped issue |
| Report | `report-failure` | `GITHUB_TOKEN` only | Deduped failure issue with a runbook |
| Drift | `drift` | Free (playback transport) / paid (`force_llm`) | Capture-compare of a real harness session's native hook payloads against committed fixtures |
| Publish | `publish-verdict` | `GITHUB_TOKEN` only | Single final writer: step summary + PR/issue comment + reconciliation |

The drift lane's two transports (issue #1 §6–7):

- **`playback` (default, free)** — `scripts/drive-capture-session.mjs` starts
  the loopback model server (`startModelPlayback`) and drives the installed
  harness with the committed tee-capture templates (`.capture/claude/`,
  `.capture/codex-capture/`, `.capture/opencode-capture/`) attached. The
  harness is real and its hook payloads are real native output; only the
  model side is scripted. No secrets, no spend.
- **`llm` (paid, `force_llm` dispatch only)** — same session shape, but the
  model side is the owner's OpenAI-compatible endpoint through a pinned
  LiteLLM sidecar (`/v1/messages` and `/v1/responses` translation; the driver
  probes each path first and degrades to exit 5 inconclusive on probe failure).
  The sidecar remains on the runner host while the harness runs in a
  restricted Docker container with a read-only workspace mount; the container
  receives only the host-gateway proxy URL and a disposable local proxy
  credential, never the upstream API key. What only this lane establishes:
  how a real model's tool-call emission patterns flow through the real
  provider path into hooks (the repo's codex router history shows these vary
  by model).

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
  under test, overriding the dist-tag), `force_llm` (enables the paid drift
  transport).

Scheduled workflows are disabled by GitHub after 60 days of repository
inactivity; the dispatch backstop is the documented recovery (`Actions →
Harness watch → Run workflow`). The `detect` job no-ops on forks.

## The verify leg, in detail

Per harness (matrix from detect's `--matrix` output):

1. `pnpm install --frozen-lockfile` for the workspace toolchain.
2. `npm install -g --ignore-scripts <pkg>@<latest>` installs the newer build
   with one retry for registry flakiness. Package lifecycle scripts stay
   disabled during installation; the workflow then invokes the package-owned
   bootstrap explicitly for Claude and OpenCode, while Codex needs none.
   Keeping those steps explicit preserves a secret-free failure boundary and
   makes a missing harness binary an `install-failure`, not behavior drift.
   Checkout still uses `persist-credentials: false`.
3. SDK + CLI bundles, then the playback suite with
   `HOOKNOSTIC_PLAYBACK=<harness>` and `HOOKNOSTIC_PLAYBACK_VERSION=<latest>`
   (`docs/testing.md`) — identical to CI's own playback job except for the
   version override.
   OpenCode additionally receives a scratch-only `XDG_CONFIG_HOME`; before
   each drive, the exact-version `@opencode-ai/plugin` dependency is installed
   into both its project `.opencode/` directory and redirected config
   directory. This avoids OpenCode's non-interactive dependency wait without
   changing the user's global harness installation or config.
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

## The drift lane, in detail

Gate (per harness): playback failure, a non-`patch` jump, or a `force_llm`
dispatch. `drift` runs with `contents: read` only — it posts nothing and
executes third-party harness code; `publish-verdict` owns every write. The
job's steps:

1. Gate on the verify outcome artifact (`pass==false || jump != 'patch' ||
   inputs.force_llm == 'true'`).
2. Bundle the workspace on the runner, install the pinned LiteLLM dependency
   before injecting its upstream key, then start the installed harness inside
   `node:<playback version>-bookworm` (from `.github/node/playback/.node-version`): the third-party harness package is installed there
   with `--ignore-scripts`, the repository is mounted read-only, only the
   throwaway capture directory is writable, and no Docker socket is mounted.
   The container runs as the image's unprivileged `node` user with an init
   process; npm installs into a temporary prefix owned by that user. Claude
   refuses the driver's permission-bypassing session when run as root.
   Claude and OpenCode then run their package-owned bootstrap explicitly.
   For OpenCode, the driver also pre-seeds the exact-version plugin dependency
   into its project and redirected config directories, both under the
   throwaway capture root.
   In the paid transport, LiteLLM stays outside that container, so its upstream
   credential cannot be read by the harness.
3. The container runs `node --experimental-strip-types
   scripts/drive-capture-session.mjs <harness> --transport playback|llm
   --scratch ...`; its exit code is captured, never propagated: 0 clean,
   **4 drift**, **5 inconclusive**, and 6 (drive failure) are all reportable
   outcomes. Under `always()` the job uploads `drift-verdict-<harness>.json`,
   the complete driver report, and the raw captures.
4. The driver reuses `startModelPlayback` from
   `packages/cli/test/harness-playback.ts` outside vitest via module-loader
   hooks (`scripts/ts-resolve-hook.mjs` + `scripts/vitest-stub.mjs`), copies
   the committed tee templates into the scratch dir (instantiating the Codex
   `${CAPTURE_DIR}` hooks template), drives the harness with the same
   provider wiring the playback lane uses (Codex: `wire_api="responses"` +
   project trust + `git init`; OpenCode: `PWD` trap, `.opencode/plugins/`
   load location, and exact-version dependency bootstrap in scratch), flattens
   the tee's `.jsonl` for the comparator, and exits
   with the comparator's verdict code.

**Advisory only.** The drift lane never writes fixtures and never upgrades
provenance — a "clean" verdict is a confidence note, not captured evidence;
drift routes humans to the harness-capture skill. The procedure and its
provenance boundary are recorded in `.capture/harness-drift/README.md`. The
OpenCode 1.18 fixtures the drift session exercises (`chat-message`,
`session-created`, `session-idle`, `tool-before`, `tool-after`) are captured
on 1.18.33, promoted from a reviewed drift artifact
(`.capture/harness-drift/promote-opencode-v1.mjs`); other 1.18 variants the
session does not exercise keep their recorded provenance.

## The publish leg, in detail

`publish-verdict` is the single final writer (`needs: [detect, record,
report-failure, drift]`, `if: always() && detect succeeded && count != '0'` —
the `always()` also fires after a skipped/failed detect, where `count` is
empty, so the guards exclude the fork no-op and detect failure). Per harness:

1. Download `drift-verdict-<harness>` if present; absent → nothing to publish.
2. **Always write the verdict into `$GITHUB_STEP_SUMMARY`** — a forced run of
   an already-recorded version produces no PR and no failure issue, and a
   clean/inconclusive result must not vanish.
3. Locate the conversation destination: an open `harness-watch/<harness>` PR
   whose title names this exact version first, else the deduped failure issue.
   A non-clean verdict (drift *or* inconclusive) with no destination files a
   new deduped report issue; the verdict comment lands on whichever matching
   destination exists.
4. **Failure-issue reconciliation**: when the harness passed and its PR
   exists, the matching failure issue (exact harness+version title) is closed
   with the passing run link — a transient failure must not linger as a stale
   signal.

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

The paid sidecar reads `.github/litellm.json`. Its two explicit bridge settings
keep both Messages and Responses requests on the upstream chat-completions API;
provider defaults alone can select a native Responses endpoint instead.
Two model-side shims cover upstream strictness the real harnesses trip over:
`additional_drop_params` removes `reasoning_effort` (Codex's Responses
`reasoning` object is forwarded as a non-string value that the upstream
rejects), and `.github/litellm_callbacks.py` merges system messages into one
leading message (Claude Code's requests carry a system block after the first
user turn, which strict chat templates reject). Both only reshape the
model-side request; harness hook payloads are untouched.
Configuration references environment variables, so no upstream key is written
to the config file. Before upgrading the pinned proxy, exercise its real
streaming and non-streaming translations against a loopback-only stub:

```bash
uv run --with-requirements .github/requirements/litellm.txt python scripts/probe-litellm-sidecar.py
```

This installs the pinned proxy in an isolated environment and makes no paid
model calls. It proves proxy translation, not a live harness session or the
owner's upstream credentials.

| Item | Type | Purpose |
| --- | --- | --- |
| `HARNESS_WATCH_PAT` | secret | Fine-grained PAT: this repo, Contents RW + Pull requests RW. Rotate like `RELEASE_PAT` (docs/releases.md). |
| `HARNESS_WATCH_AUTOMERGE` | repo variable | Opt-in auto-merge of record PRs; absent/false = human merge. |
| `HARNESS_LLM_BASE_URL` | repo variable | Upstream OpenAI-compatible endpoint for the paid llm drift transport. |
| `HARNESS_LLM_MODEL` | repo variable | Model name the llm transport drives. |
| `HARNESS_LLM_API_KEY` | secret | Spend-capped upstream key; supplied only to the host-side LiteLLM process, outside the harness container. |
| `harness-watch` | label | Created by the first run if missing. |

## Failure runbook

1. Read the issue's outcome class: `install-failure` (packaging/toolchain) vs
   `playback-failure` (behavior drift).
2. Reproduce locally:
   `pnpm run bundle`
   then
   `HOOKNOSTIC_PLAYBACK=<harness> HOOKNOSTIC_PLAYBACK_VERSION=<version> pnpm exec vitest run packages/cli/test/harness-playback.test.ts`.
3. Playback failure → follow the harness-capture skill; the failing
   scenario's driver names the capability family. Fixtures and ranges extend
   only with captured evidence; a failing scenario that pins an
   `unsupported` cell means the harness started honouring a channel —
   re-rate with fresh captures (ADR-0010's inverted watch).
4. Install failure → check the explicit package bootstrap and binary path
   before changing playback assertions. Keep lifecycle scripts disabled during
   install, run only the documented package-owned bootstrap, and preserve the
   secret-free `persist-credentials: false` boundary.
5. A transient pass on the next scheduled run closes the failure issue
   automatically (`publish-verdict`'s reconciliation step).
6. If scheduled runs stop (60-day auto-disable): dispatch manually, then
   commit anything — a push re-arms the schedule.
7. A drift or inconclusive verdict: download the run's
   `drift-verdict-<harness>` artifact (raw captures + report), then follow
   the harness-capture skill. Drift is advisory; ranges and fixtures extend
   only with captured evidence.


## OpenCode families

The independent `opencode-v1` and `opencode-v2` lanes install `opencode-ai`
and `@opencode/cli`. Installation, bootstrap paths, profile modules and metadata
exports live in `scripts/harness-lanes.mjs`. V2 validation updates only its own
rolling record. `opencode` remains an alias for the v1 automation lane.
See [OpenCode families](opencode-families.md) for the target selection contract.
