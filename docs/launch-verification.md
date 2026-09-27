# Public launch verification

Local preparation results, 2026-09-27, Windows. These results cover the launch
changes in the working tree; hosted verification of the final revision is still
required before publication. No Actions workflows or npm publication were started.

## Completed locally

| Check | Result |
| --- | --- |
| `pnpm lint` | Exit 0 |
| `pnpm format:check` | Exit 0 |
| `pnpm build` | Exit 0 |
| `HOOKNOSTIC_PACK=1 pnpm test` | Exit 0; 1,436 passed, 78 skipped |
| `pnpm check:dependencies` | Exit 0; 82 maintained references |
| `node scripts/check-version-literals.mjs` | Exit 0; 126 tracked files |
| `pnpm build:examples` from repository root | Exit 0; repeat generation reproduced all 57 artifact files |
| Dedicated Claude and Codex marketplace gates | Exit 0 at recorded package baselines and additional installed versions |
| Selected OpenCode v2 component, registry-package, and hooks-only playback | Exit 0; five tests passed |

The full suite's opt-in tarball test uses actual `pnpm pack` output, installs all
three public packages in a clean consumer, and exercises the installed CLI's
project and components-only package paths. See [testing](testing.md#marketplace-release-gates)
for commands and [marketplace evidence](../.capture/marketplace-launch/README.md)
for exact harness versions and observations. Skipped tests include separate
harness lanes and paid smoke tests; a normal suite pass does not establish those.

The new checks were demonstrated to reject unsupported package support, the wrong
reference-version selection, unbundled MCP output, and a missing CLI executable
registration. The installed Claude example also exposed duplicate tool-call ids
in the loopback model server; it failed before that server defect was fixed.

## Publication review

A targeted history scan inspected 299 commits and 3,558 text blobs for private-key
headers and common GitHub, AWS, and model-provider credential patterns. It found
no candidate paths; no blobs exceeded the scan's size threshold. A tracked-content
search for the local account name also found no matches.

This is limited evidence, not exhaustive privacy or credential clearance. The
owner's final publication review should include captured data and downstream
consumer anonymity. Keep that review separate from test results.

## Remaining launch steps

Follow [the release runbook](releases.md#launch-readiness-before-changing-visibility):

1. Review the final diff and publication content while private.
2. At the owner-approved visibility change, configure release protections, the
   `npm` environment, and private vulnerability reporting.
3. Run final hosted CI, including the new marketplace lanes and tarball consumer.
   The latest budget-blocked jobs never started; no increased private Actions
   budget is assumed.
4. Review publish-guard removal, obtain CI-built tarballs, and have the owner
   perform the documented first-package bootstrap before trusted publishing.
5. Verify registry installs, documentation links, and dist-tags before announcing.

macOS real-harness verification, remote marketplace listing acceptance, and
automatic marketplace updates remain outside this local evidence. OpenCode v2
and component fidelity retain the limits documented in the support matrix.
