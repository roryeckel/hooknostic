# Dependencies and maintained versions

This is the inventory of version ownership. The initial catalog migration
preserves dependency requirements and installed resolutions; dependency upgrades
belong in subsequent reviewed PRs. Contribution scope remains in
[CONTRIBUTING](../CONTRIBUTING.md).

| Category | Authoritative location | Update mechanism | Verification |
| --- | --- | --- | --- |
| External workspace requirements | `pnpm-workspace.yaml`: `catalog`, `catalogs` | Renovate npm manager; package manifests reference `catalog:` | `pnpm check:dependencies`; `pnpm install --frozen-lockfile`; lint, build, test |
| Standalone example runtime | `examples/agent-plugin/runtime/package.json` and its sibling `package-lock.json` | Renovate npm manager; exact pins and a native npm lockfile, outside the pnpm workspace | Extraction comparison; `pnpm check:dependencies`; `pnpm build:examples` validates the runtime lock graph |
| pnpm | Root `package.json#packageManager` | Renovate npm manager; `pnpm/action-setup` reads the pin | `pnpm --version`; frozen install; local pack checks below |
| Supported Node floor | Root `package.json#engines.node` | Manual compatibility decision; all package declarations must agree | `pnpm check:dependencies`; normal gates and playback |
| General CI Node | `.github/node/ci/.node-version` | Renovate nodenv manager | CI matrix; `pnpm check:dependencies` checks workflow references |
| Playback Node | `.github/node/playback/.node-version` | Renovate nodenv manager; also supplies `node:<version>-bookworm` in harness-watch | All three model-free playback lanes; workflow tests |
| Node 22 compatibility | `.github/node/compatibility/.node-version` | Manual mirror of the root engine minimum, checked by `pnpm check:dependencies` | Dedicated CI build, tests and package-consumer checks exercise the declared minimum while general CI/playback use Node 24 |
| Publishing Node | `.github/node/publishing/.node-version` | Renovate nodenv manager | Release workflow tests and packing; see [release gates](releases.md) |
| GitHub Actions | `uses:` references in `.github/workflows/*.yml` | Renovate github-actions manager | Workflow tests and CI; extraction comparison |
| Renovate validation runtime | `dependency-policy.container.image` in `.github/workflows/ci.yml` | Renovate github-actions manager (container image) | Strict config validation and extraction comparison in that job |
| LiteLLM proxy | `.github/requirements/litellm.txt` | Renovate pip_requirements manager; pipx consumes the single requirement | Extraction comparison; workflow tests; optional owner-requested sidecar validation |
| Harness reference/compatibility versions | Adapter `harness` metadata and profile `validatedOn` records | Existing [harness-watch](harness-watch.md) and evidence review | `node scripts/generate-harness-support.mjs`; `node scripts/check-version-literals.mjs`; [playback](testing.md) |
| Hooknostic release versions | Workspace manifests, managed by `scripts/set-versions.mjs` | Existing human-reviewed [release flow](releases.md) | `node scripts/set-versions.mjs --check <release-version>`; release workflow tests |
| Locked resolutions | Root `pnpm-lock.yaml` and the standalone runtime's npm lockfile | Package managers after requirement changes; monthly Renovate maintenance | Frozen install; lint, build, test; pack and example drift checks |
| Generated dependency manifests and bundled versions | Build outputs, including both committed example `dist` directories | Compiler regeneration, never direct bot edits | `pnpm build:examples`; existing CI artifact drift gate |
| Captures, fixtures, historical observations | `.capture/`, `fixtures/`, dated docs and provenance records | Historical evidence; new captures record new observations | Existing fixture replay and provenance checks; never dependency-bot upgrades |

## Catalogs and lockfiles

The default catalog holds shared external requirements. `zod3` serves the SDK
and core; `zod4` serves the MCP example. `semver-runtime` preserves the library
and CLI requirement, while `semver-tooling` preserves the root tooling's higher
minimum. Their names encode intentional differences, even when a lockfile
resolves the two semver requirements to the same package. Renovate retains each
named catalog's major line. Moving consumers between catalogs or changing those
lines is a separate manual migration.

The standalone runtime pair formerly named `runtime.package.json` and
`runtime.package-lock.json` now lives under `examples/agent-plugin/runtime/`
using npm's standard filenames, so Renovate can update both requirements and
their lockfile. Its exact pins are preserved during migration. This installable
package uses native npm requirements, independently of the example's pnpm
development dependencies; it cannot ship `catalog:` references. Its Zod major
line is also retained. These are maintained source inputs, distinct from the
generated manifests under `dist/`, which remain excluded from direct bot edits.

`catalog:` and `workspace:` are authoring references. `pnpm pack` rewrites both
to distributable requirements. Never use `npm pack` here. A lockfile records
resolved versions, peer combinations, and integrity hashes; moving a requirement
into a catalog changes importer specifiers and adds catalog records without
requiring a new resolution. Compare every old requirement after dereferencing
catalogs, every importer resolution, and the entire `packages` and `snapshots`
maps when reviewing a migration. Do not delete the lockfile during that step.

Monthly lockfile maintenance intentionally refreshes transitive resolutions
within the declared ranges in both lockfiles. The example plugin's generated `package-lock.json`
belongs to its generated native output, and must be reviewed as part of the
artifact diff. Bundled license notices and manifests are generated too.
Historical version strings describe what was observed at the time; updating
them would falsify the evidence. Renovate excludes captures, fixtures, docs,
all `dist` directories, and generated `examples/*/com.*` trees. Its enabled
managers do not edit adapter TypeScript metadata or release-version fields.

## Reviewed update policy

Use the free [Mend-hosted Renovate GitHub app](https://docs.renovatebot.com/mend-hosted/).
`renovate.json` permits routine updates Mondays, 06:00–11:59 America/Chicago.
The app's own run timing determines when it visits that window. Non-major npm
updates share one PR; non-major Node, pnpm, Actions, validator image, and LiteLLM
updates share a CI/tooling PR. Major upgrades get individual PRs only after
Dependency Dashboard approval. Named catalog major lines and the Node engine
floor remain manual. Automerge is disabled, including for security fixes.

Lockfile maintenance runs monthly on day 1, 06:00–11:59 in the same timezone.
Vulnerability-fix PRs can bypass the routine window and dashboard approval;
enable GitHub dependency graph and vulnerability alerts for this integration.
See Renovate's [security update behavior](https://docs.renovatebot.com/configuration-options/#vulnerabilityalerts).
Humans review and merge every update, after all required checks pass.

The CI `dependency-policy` job validates the configuration and performs a real
Renovate extraction dry run. `scripts/check-dependencies.mjs` compares that
extraction with every catalog, standalone runtime requirement, pnpm pin, Node
file, Action/container reference, and LiteLLM requirement. Missing or unexpectedly extracted dependencies fail
the check. Embedded Node, pnpm, or LiteLLM pins and disconnected tooling files
also fail the ownership check.

To reproduce using the Renovate CLI version from CI (install it in a scratch
directory, with its supported Node runtime; it is not a workspace dependency):

```bash
renovate-config-validator --strict renovate.json
LOG_LEVEL=warn LOG_FILE_LEVEL=debug LOG_FILE=/tmp/renovate-extraction.ndjson \
  renovate --platform=local --dry-run=extract --require-config=required --onboarding=false
node scripts/check-dependencies.mjs /tmp/renovate-extraction.ndjson
```

Use a fresh log file. Run from the repository root after installation, with new
dependency files added to Git so they appear in Renovate's file inventory. The
token-free local extraction discovers Action references but reports that GitHub
lookups require a token; it neither looks up upgrades nor opens PRs. The hosted
app supplies that token. See [Renovate local dry runs](https://docs.renovatebot.com/modules/platform/local/).

## Artifact refresh

pnpm installs enforce a 24-hour minimum release age (`minimumReleaseAge: 1440`).
Renovate's npm datasource uses the same one-day wait, requires release timestamps,
and filters pending releases before routine branch creation. The install guard
still applies to transitive dependencies and lockfile maintenance; Renovate's
direct-update check does not replace it. A companion dependency published later
can therefore still delay a frozen install.

Requesting an update through a Dependency Dashboard checkbox can override
Renovate's wait. If CI reports `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, leave the
install guard intact and retry after the newest rejected package is 24 hours old.
Rerun both the failed CI prerequisite and artifact-generation workflow at the
unchanged PR head; if the writer pushes a successor, let its new CI run finish.
Do not interpret this install failure as proof of the dirty-artifact path.
See [Renovate's release-age behavior](https://docs.renovatebot.com/key-concepts/minimum-release-age/).

Run `pnpm build:examples` at the repository root. The command builds the workspace
and invokes both example builds **from the repository root**. It first removes
each output directory so outputs that are no longer emitted become deletions.
It moves each generated build report to `dist/hooknostic-build.json`, keeping
the complete committed result inside the same two output directories. Direct
CLI builds still write their report at the usual config-root location.
The regular CI drift gate uses this same command and still checks new files,
modified files, and deletions.

`renovate-artifacts.yml` runs only for same-repository PRs authored by
`renovate[bot]` on `renovate/` branches. It checks out the exact PR head without
persisted credentials, installs dependencies, generates the examples with a
read-only workflow token, and uploads one JSON manifest containing the PR number,
originating SHA, and complete file contents, including hidden files.

`renovate-artifacts-apply.yml` runs from the default branch on successful
generation. It checks the workflow ID and path, event, repository, successful
generation job, associated PR, bot author, branch, and current head. It reads
one bounded JSON member from the downloaded ZIP without extracting paths or
executing downloaded content. It never checks out or installs code from the PR.

The writer permits only regular files beneath `examples/rewrite-shell/dist/`
and `examples/agent-plugin/dist/`. It rejects traversal, absolute paths,
backslashes, control characters, duplicate/conflicting paths, symlinks, and
gitlinks. A complete snapshot permits additions and deletions. Git blob hashes
avoid commits when bytes match. GitHub's atomic `expectedHeadOid` check prevents
overwriting a newer push; stale heads, closed PRs, and superseded attempts are
skipped. A newer run regenerates from the new head.

The dedicated token makes the resulting commit trigger normal PR checks. That
commit must pass the existing artifact drift gate before human merging. The
next generation run should be a no-op, ending the refresh cycle.

CI first runs a five-minute-bounded artifact readiness job for these same-repository
Renovate PRs. It rebuilds the examples on the PR merge checkout before starting
the seven full-validation jobs. Changed, deleted, or new generated files fail
readiness, so the intermediate commit never starts the full matrix. The existing
artifact writer pushes a refresh; that successor goes through readiness and the
full matrix. An already reproducible update proceeds without waiting for the
writer's no-op run. Build, install, and Git errors fail closed.

An initial red readiness check is expected when artifacts need refreshing. If
no successor arrives, inspect **Renovate artifacts** and **Apply Renovate artifacts**
for failures or stale-head skips. A merge-base change can also cause reproducibility
failure; rebase the PR and regenerate rather than accepting skipped matrix jobs.
Require **Renovate artifact readiness** alongside the matrix checks in branch
protection: skipped jobs alone are not evidence of validation.

Human PRs (including forks and human-authored `renovate/` branches) and pushes to
`master` skip readiness and retain the full matrix. Release drafting still waits
for CI on its exact target commit. This change reduces artifact-refresh fan-out;
it does not deduplicate merges, separate Renovate updates, or later rebases.
Plan their runner costs before merging. No write token is used by the readiness
job, and the credentialed artifact writer remains unchanged.

## Verification and rollout

Run `pnpm lint`, `pnpm format:check`, `pnpm build`, and `pnpm test`, recording each exit code
separately. Run all three `HOOKNOSTIC_PLAYBACK=<harness>` lanes as described in
[testing.md](testing.md), regenerate the harness-support page, check version
literals, and run `pnpm build:examples`. No paid smoke tests or local publishing
are part of dependency-update validation. Regression tests cover engine drift,
extraction omissions, changed/no-op/deleted outputs, stale heads, foreign PRs,
and disallowed paths; demonstrate failure against a corresponding mutant when
adding or changing these tests.

After building, inspect all three local distributable tarballs:

```bash
mkdir -p /tmp/hooknostic-packs
pnpm --filter @hooknostic/agent-plugin exec pnpm pack --pack-destination /tmp/hooknostic-packs
pnpm --filter @hooknostic/sdk exec pnpm pack --pack-destination /tmp/hooknostic-packs
pnpm --filter hooknostic exec pnpm pack --pack-destination /tmp/hooknostic-packs
```

Read each `package/package.json` inside those tarballs and verify no dependency
section retains a `catalog:` or `workspace:` reference. See
[packaging](publishing.md) for local consumer installation checks.

The hosted rollout requires these owner actions and checks; the dated records below track completion:

1. Merge the migration and workflow configuration without dependency upgrades.
2. Create `RENOVATE_ARTIFACTS_PAT`: a dedicated fine-grained PAT restricted to
   this repository, with **Contents: read/write** and **Pull requests: read/write**.
   Store it as a repository Actions secret; use an expiry and rotation owner.
   No Actions-write or workflow-write permission is needed. The ordinary
   read-only `GITHUB_TOKEN` reads run metadata and artifacts.
3. Set `gitIgnoredAuthors` in `renovate.json` to the exact Git author email of
   that credential's account (prefer a dedicated automation account). GitHub
   attributes GraphQL commits to the token owner. This lets Renovate rebase
   after a refresh; otherwise it treats that commit as a human modification.
   See [Renovate's author setting](https://docs.renovatebot.com/configuration-options/#gitignoredauthors).
4. Install/activate the hosted Renovate app for **this repository only**, after
   the configuration is merged. Enable the dashboard and vulnerability alerts;
   retain branch protection and human merging. No app installation or secret
   creation is performed by adding these files.
5. Review the first dashboard: confirm every maintained category appears,
   evidence and release versions are absent, majors await approval, and named
   catalog lines remain distinct. Review the first grouped PRs and monthly
   maintenance PR when available. Confirm a generated artifact commit triggers
   normal checks, passes the drift gate, and is followed by a no-op refresh.
   Exercise a rebase and verify stale results are skipped. Only then mark the
   hosted rollout complete.

### Hosted audit: 2026-10-03

At this audit, the hosted workflows were operational. Rollout remained **pending** on the
owner settings below; successful runs do not establish that those settings are
enforced.

Verified against the dashboard, PR history, and individual job logs:

- [Dependency Dashboard #18](https://github.com/roryeckel/hooknostic/issues/18)
  lists the workspace catalogs, standalone runtime, pnpm, all three Node files,
  Actions and the validator container, and LiteLLM. Majors await approval, and
  the Zod and semver catalog entries remain distinct. The grouped
  [npm PR #27](https://github.com/roryeckel/hooknostic/pull/27),
  [CI/tooling PR #46](https://github.com/roryeckel/hooknostic/pull/46), and
  [monthly maintenance PR #57](https://github.com/roryeckel/hooknostic/pull/57)
  have been reviewed and merged.
- For #57, the [writer run](https://github.com/roryeckel/hooknostic/actions/runs/36890629447)
  logged `committed example artifacts`. The resulting commit triggered
  [CI](https://github.com/roryeckel/hooknostic/actions/runs/36890668345): readiness,
  the full matrix, dependency extraction, and the example drift gates all passed.
  The [follow-up writer](https://github.com/roryeckel/hooknostic/actions/runs/36890784737)
  logged `no changes`.
- [Maintenance PR #19](https://github.com/roryeckel/hooknostic/pull/19) records a
  Renovate force-push at 2026-09-24 03:13:41 UTC, replacing the artifact-refresh
  head `393c1b9` with rebased bot commit `a069714`. The
  [new writer](https://github.com/roryeckel/hooknostic/actions/runs/35950644695)
  committed refreshed artifacts, and its
  [follow-up](https://github.com/roryeckel/hooknostic/actions/runs/35950735936)
  logged `no changes`. This verifies that the configured ignored author permits
  Renovate to rebase after a refresh.
- An earlier [queued writer](https://github.com/roryeckel/hooknostic/actions/runs/35943844404)
  logged `stale head or closed PR` at 2026-09-24 01:49:11 UTC. The
  lock-maintenance branch had advanced and #19 remained open until 03:53:17 UTC.
  The hosted skip path has therefore been observed; the existing regression
  tests cover the additional stale-attempt and atomic-write race cases.
- The dependency graph is available, vulnerability alerts are enabled, and the
  `RENOVATE_ARTIFACTS_PAT` repository secret exists. The generated commit's author
  email matches `gitIgnoredAuthors`.

Remaining owner checks at that audit:

1. Protect `master` with required checks, including **Renovate artifact
   readiness** alongside the existing matrix. At audit time, the branch
   protection API reported `Branch not protected`, and the applicable branch
   rules API returned no rules. Human merging remains the configured policy,
   but required-check enforcement is not yet installed.
2. Confirm that the dedicated PAT has only the repository and permissions
   specified above, with a recorded expiry and rotation owner. Secret metadata
   and successful writer runs cannot establish its full permission scope or
   lifecycle.
3. Confirm that the hosted app's installation is restricted to the intended
   repository. Dashboard and PR activity prove activation here, but do not prove
   the installation's access to other repositories.

### Hosted rollout completion: 2026-10-04

Rollout is **complete with an owner-approved no-expiry exception**.

- `master` now requires all 13 checks from the CI workflow, including
  **Renovate artifact readiness**, with GitHub Actions as their required source.
  Protection applies to administrators, requires the branch to be current, and
  disallows force pushes and deletion. PRs require no additional approving
  reviewer, so the single-maintainer review flow remains usable.
- The Renovate installation settings show **Only select repositories**, with
  this repository as the sole selection.
- The owner confirmed that `HARNESS_WATCH_PAT` and `RENOVATE_ARTIFACTS_PAT`
  contain the same fine-grained credential. Its settings grant only this
  repository, metadata read access, and Contents/Pull requests read/write;
  there are no user, Actions-write, or workflow-write permissions.
- The credential has no expiration. The owner explicitly accepted that
  exception on this date and owns rotation. Any future rotation must replace
  both repository secrets together before either automation runs again.

The preceding audit remains the historical record of the missing settings.
Repository protection and token settings can change independently of these
files; recheck them during later operational audits.

### Routine update validation: 2026-10-04

The first routine updates after protection was enabled exercised both artifact
paths against the required CI matrix:

- [CI/tooling PR #64](https://github.com/roryeckel/hooknostic/pull/64) passed
  generation and readiness without changing generated bytes. The successful
  [writer run](https://github.com/roryeckel/hooknostic/actions/runs/37181129143)
  returned `no changes`; all 13 required checks passed before merge.
- [npm PR #65](https://github.com/roryeckel/hooknostic/pull/65) changed the MCP
  example dependency. Its initial readiness run rejected stale generated files
  and skipped the remaining validation jobs. The
  [writer run](https://github.com/roryeckel/hooknostic/actions/runs/37181471351)
  committed regenerated examples in `22fe70a`; the successor head passed
  readiness and the full required matrix. The
  [next writer run](https://github.com/roryeckel/hooknostic/actions/runs/37181529998)
  returned `no changes`, confirming that regeneration stopped after one commit.

- [Lockfile-maintenance PR #67](https://github.com/roryeckel/hooknostic/pull/67)
  refreshed three transitive tooling dependencies without changing requirements
  or generated examples. All 13 required checks passed before merge.

All three PRs were merged at their validated heads. These runs used the hosted
Renovate app and the configured shared PAT; credential values were not read.

### Compatibility trials: 2026-10-04

The owner retained the declared `>=22.13.0` Node support range. These isolated
Windows probes explain the upgrades held back during toolchain maintenance:

| Candidate | Observed result | Decision |
| --- | --- | --- |
| TypeScript 7.0.2 with typescript-eslint 8.71.0 | Install succeeded with a peer warning; `pnpm lint` exited 2 because typescript-eslint rejects the missing TS 7 compiler API. `pnpm build` exited 1 because the CLI bundler resolves `typescript/bin/tsc`, which TS 7 no longer exports. | Keep the supported TypeScript 6.0 line. A future TS 7 migration needs compiler-entrypoint changes and an explicit plan for lint's TS 6 API dependency. |
| @types/node 26.6.4 with TypeScript 6.0.3 | The repository build and lint passed. A separate import of `convertProcessSignalToExitCode` from `node:util` compiled, but failed at runtime on Node 22.13.0 with a missing-export error. The same source correctly failed compilation with @types/node 22.20.5. | Retain Node 22 declarations so this newer API is rejected at compile time. Passing the current build alone does not establish compatibility for newly admitted APIs. |
| npm-package-arg 14.0.0 | An isolated `npm install --engine-strict --ignore-scripts` under Node 22.13.0 exited 1 with `EBADENGINE`. | Retain 13.x while the current Node support range is promised. |
| validate-npm-package-name 8.0.0 | The same isolated engine-strict installation under Node 22.13.0 exited 1 with `EBADENGINE`. | Retain 7.x while the current Node support range is promised. |

Both npm utility majors declare `^22.22.2 || ^24.15.0 || >=26.0.0` as their Node
engine range. The runtime probe used the official Node 22.13.0 Windows archive
verified against its published SHA-256 checksum. No unsupported package was
installed by bypassing engine enforcement, and no public engine declaration was
changed. The compiler and type probes used temporary worktrees, not product
source changes.

References: [TypeScript's side-by-side compiler guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0),
[typescript-eslint's supported versions](https://typescript-eslint.io/users/dependency-versions/),
[npm-package-arg 14 release](https://github.com/npm/npm-package-arg/releases/tag/v14.0.0),
[validate-npm-package-name 8 release](https://github.com/npm/validate-npm-package-name/releases/tag/v8.0.0).
