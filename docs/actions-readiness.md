# GitHub Actions readiness

Validation snapshot: 2026-09-23, starting at
[`c5ff598`](https://github.com/roryeckel/hooknostic/commit/c5ff59882678a95349ab03e8e7b7babf18b4fb72).
Hosted verification is **not complete**. Local execution does not prove GitHub
credentials, event delivery, environment protection, or cross-job artifacts.

## Evidence collected

| Workflow | Exercised | Still needs hosted proof |
| --- | --- | --- |
| CI | Windows and Linux lint, format, build, and tests; generated examples and docs; version literals; actionlint; all three reference playback lanes; strict Renovate validation and extraction in the pinned image | Full corrected matrix, including macOS |
| Harness watch | npm detection; all three current-release playback lanes; capture/compare drivers; record CLI write, repeat no-op, out-of-range refusal, and older-version refusal | PAT checkout/push, PR creation, issue/report routing, artifacts between jobs, quiet scheduled run, optional paid sidecar |
| Release prepare | Disposable checkout: version bump, lockfile sync, example regeneration, version agreement; failure guards tested with actual Bash bodies | Dry-run dispatch, then credentialed PR creation |
| Release draft | Real GitHub generate-notes API and local composition; existing release metadata and CI-gate tests | Protected release process after an approved release PR; draft creation |
| Release publish | Three pnpm tarballs inspected; no workspace/catalog dependency references remain; registry error, existing-version, and missing-prerelease branches tested using fake commands | Protected bootstrap asset upload; later owner bootstrap and OIDC publication |
| Renovate artifacts | Example regeneration, manifest/ZIP tests, changed/no-op/deleted-output tests | An authentic same-repository Renovate PR and artifact upload |
| Apply Renovate artifacts | Provenance, stale-head, no-op, path rejection, and atomic write behavior covered by tests | Dedicated PAT commit, follow-up CI, no-op cycle, and rebase |

Final local gates passed with each exit code recorded separately. Windows:
1,296 tests passed, 43 skipped. Linux: 1,297 passed, 42 skipped. The differences
are platform-specific tests. Playback's explicit driver limitations remain
inconclusive; see [testing.md](testing.md).

The only hosted job started during this pass was the Ubuntu CI canary:
[run 35921735562, attempt 2](https://github.com/roryeckel/hooknostic/actions/runs/35921735562/attempts/2).
It ran for 2 minutes 50 seconds and exposed the stderr fixture defect below.
Other failed jobs displayed on that run were inherited from the earlier billing
failure, not newly executed jobs. No paid model calls or registry publication
were performed.

## Defects corrected

- The verbose-provider test forced process exit before piped stderr drained on
  Linux. The original failure reproduced locally; allowing natural exit passed.
- Harness-watch treated skipped playback as behavioral failure and let a closed
  PR suppress a fresh validation. Actual Bash-step regression tests failed
  before both fixes.
- The drift container ran Claude as root, which the binary rejected. The same
  model-free session passed as the image's `node` user and captured six native
  payloads with a clean comparison. A mutation test pins the user setting.
- Release preparation treated API errors as absent refs. Cleanup could then
  delete an existing release branch even though this run had never created it.
  Regression tests pin error handling and ownership of cleanup.
- Publication retries treated every npm lookup failure as a missing version.
  They now require a confirmed E404. Tests use fake npm/pnpm functions: no
  publication command is executed against a registry.
- Every job has a bounded timeout. CI explicitly requests read-only contents
  permission. Harness-watch records formatting and all verification exit codes.
- Release preparation's dry run can use the ordinary workflow token, without
  needing the release PAT.

Codex capture/compare was clean. OpenCode completed its session and returned
the documented advisory drift verdict against its existing fixtures; this is
not evidence that its full fixture set matches live payloads. No fixtures,
capability ranges, or validation records were changed by these rehearsals.

## Owner setup and next hosted checks

At audit time, `HARNESS_WATCH_PAT` and the LLM connection settings existed.
`HARNESS_WATCH_AUTOMERGE` was false. `RELEASE_PAT` and
`RENOVATE_ARTIFACTS_TOKEN` were absent; `gitIgnoredAuthors` was empty. No `npm`
environment existed. GitHub refused ruleset access on the current private
repository plan. Renovate installation has not been established.

1. Agree a runner budget and push the reviewed readiness patch. Run the full
   PR CI once; rerun only failed jobs after diagnosis.
2. Dispatch release preparation with `dry_run=true` and an explicitly chosen
   rehearsal version. It must create no branch, PR, or tag.
3. Exercise harness-watch on a pinned reference version first, then one newer
   passing harness after the fixes land. Check the no-op route and the actual
   record PR/CI route before expanding to all harnesses. Review artifacts and
   summaries, not just the overall green status. Paid `force_llm` is a separate
   spend decision.
4. Complete the scoped credentials and hosted Renovate rollout in
   [dependencies.md](dependencies.md), including its authentic bot identity and
   rebase/no-op checks. Do not weaken provenance checks to manufacture a test PR.
5. Configure the protected environment and tag ruleset when the repository's
   plan/visibility supports them. Follow [releases.md](releases.md) for the
   deliberate first-release guard removal, owner bootstrap, and trusted
   publisher configuration. Publication and visibility changes remain owner
   launch decisions.

Job timeouts bound individual failures; they are not an account spending cap.
GitHub's billing budget remains the final cap.
