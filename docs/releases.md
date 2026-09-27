# Releases

The maintainer runbook. For what ships inside the packages and the everyday
tarball-testing flow, see [publishing.md](./publishing.md).

## What ships

Three npm packages: `@hooknostic/agent-plugin`, `@hooknostic/sdk`, and `hooknostic`
(the CLI). Everything
else in `packages/` is bundled into the CLI at build time — internal package
versions are metadata only, so the whole workspace versions **in lockstep**:
one release version everywhere, written by `scripts/set-versions.mjs`.

## The routine pipeline: three stages, two human decisions

```
workflow_dispatch          merge the PR              publish the draft
release-prepare.yml  ──►  release-draft.yml    ──►  release-publish.yml
bump + branch + PR        notes + DRAFT release      npm publish (OIDC)
        │                        │                          │
        └── decision 1: merge ───┘── decision 2: publish ───┘
```

Key safety property: **a draft release materializes no tag.** Until decision
2, deleting the draft leaves nothing public anywhere.

## Cutting a release

Before preparation, update [release highlights](release-highlights.md) with the
scope, migration steps, and limits for the upcoming release. The notes generator
places these before the family-specific harness support table. Review or replace
them for each release so older announcements are not repeated.

1. Run the **Release prepare** workflow with the version (no leading `v`,
   e.g. `0.2.0`; a `-rc.1` suffix marks a prerelease). It validates the
   version, guards against duplicates, bumps every carrier, syncs the
   lockfile, rebuilds both committed example artifacts from the repo root,
   and opens `Release vX.Y.Z` with a checklist.
   For a rehearsal, set `dry_run=true`: preparation uses the workflow token,
   needs no `RELEASE_PAT`, and never pushes a branch or opens a PR. Duplicate
   checks stop on authentication/service errors, and failure cleanup deletes
   only a branch created by that run.
2. Review the PR — CI runs the 3-OS matrix, the artifact byte gate, and the
   docs drift gate on it. Merge it (**decision 1**).
3. **Release draft** fires on the merge: asserts every version carrier agrees
   (`set-versions.mjs --check`), asserts the publish guard was removed (see
   below), polls CI green at the merge sha, generates the notes (harness
   support table + PR-grouped section + direct-commit section), and creates a
   **draft** release.
4. Open the draft in the GitHub UI, read the notes (edit freely — it is just
   text), and click **Publish** (**decision 2**).
5. In normal `oidc` mode, **Release publish** fires: checks out the tag, re-verifies versions and
   the guard, builds, tests, and publishes the two libraries then the CLI via npm Trusted
   Publishing. A prerelease version gets the `next` dist-tag, never `latest`.

## Version policy

- SemVer, lockstep across the workspace, chosen by the human running
  prepare — no conventional-commit inference.
- Prerelease suffixes (`-rc.N`, `-beta.N`, …) set the GitHub prerelease flag
  and the npm `next` dist-tag automatically.
- Carriers beyond the manifests (three inlined `adapterVersion` literals,
  `HOOKNOSTIC_VERSION`) are rewritten by `set-versions.mjs` and pinned by
  `packages/cli/src/versions.test.ts`.

## The publish guard

While unreleased, `packages/agent-plugin`, `packages/sdk`, and `packages/cli` carry `"private": true` —
an executable never-publish guard. The release flow **cooperates** with it:
`release-draft` and `release-publish` both fail while the fields exist,
naming the checklist item. The first release PR removes them (and adds
`publishConfig: { access: "public", provenance: true }`) as a deliberate,
reviewed step tied to the release that consumes it.

What protects against accidental publish after the fields are gone, in
descending order of strength:

1. **Trusted Publishing with no npm token secret.** Routine automated
   publication uses `release-publish.yml` in the `npm` environment. The owner
   retains interactive 2FA account access; the first-package bootstrap below
   is the only repository-authorized local publication.
2. The `npm` environment (required reviewer; deployments limited to `v*`).
3. A tag ruleset on `v*`.
4. The "exactly three publishable packages" test in `versions.test.ts`.
5. `provenance: true` for routine OIDC releases. The interactive bootstrap is
   explicitly unattested; its build assets and checksums remain on GitHub.

## First public release — one-time owner bootstrap

npm currently requires a package to exist before either
[trusted publishing](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)
or [staged publishing](https://docs.npmjs.com/staged-publishing/#prerequisites)
can be configured. A bypass token is not our bootstrap: npm has
[announced the removal of its direct-publish ability around January 2027](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/).
The narrow exception below is for the owner with interactive 2FA, never agents.

1. Create GitHub environment `npm`: required reviewer owner, deployments
   limited to `v*` tags. Add its environment variable
   `NPM_PUBLICATION_MODE=bootstrap`. Valid values are `bootstrap` and `oidc`;
   omission defaults to `oidc`, and any other value fails before packaging.
   Add a `v*` tag ruleset and the fine-grained `RELEASE_PAT` secret for this
   repository only (Contents RW + Pull requests RW), so release PRs trigger CI.
2. Make the repository public when ready. Immediately enable private
   vulnerability reporting (Settings → Advanced Security, or
   `gh api --method PUT repos/roryeckel/hooknostic/private-vulnerability-reporting`).
   It is unavailable while the repo is private; until enabled, `SECURITY.md`'s
   email fallback is the working reporting route.
3. Run prepare and review the release PR. Remove `private: true` and add
   `publishConfig: { access: "public", provenance: true }` in **only** the
   three public package manifests. Keep all other packages private. Merge
   after CI passes, then review and publish the resulting draft release.
4. Approve the protected release workflow. In `bootstrap` mode it builds,
   tests, packs the three packages with `pnpm pack`, and attaches their
   tarballs plus `SHA256SUMS`. It performs **no registry publication**.
   Existing matching assets are retained on retry; differing assets cause a
   failure and are never overwritten.
5. As the owner, download the assets from that release into an empty directory.
   Verify every tarball against `SHA256SUMS` (`sha256sum --check SHA256SUMS`
   on Linux, `shasum -a 256 --check SHA256SUMS` on macOS, or `Get-FileHash
   -Algorithm SHA256` on Windows). Inspect the tarball contents. Do not
   rebuild or repack locally.
6. Authenticate interactively with `npm login` and account 2FA. For each
   package, check `npm view PACKAGE@VERSION version`: skip an already-published
   version, continue only on a confirmed E404, and stop on authentication or
   network errors. Publish the SDK tarball, then agent-plugin, then CLI:

   ```bash
   npm publish ./hooknostic-sdk-VERSION.tgz --access public --provenance=false
   npm publish ./hooknostic-agent-plugin-VERSION.tgz --access public --provenance=false
   npm publish ./hooknostic-VERSION.tgz --access public --provenance=false
   ```

   Substitute the release version. Append `--tag next` to **each** command
   for prereleases. These tarballs already have pnpm's workspace dependency
   rewrite. The explicit provenance override is required because this
   interactive publication occurs outside CI; do not claim npm attestations
   for the bootstrap versions.
7. Once all three packages exist, configure each trusted publisher
   interactively with 2FA for this repository, workflow `release-publish.yml`,
   environment `npm`, and **Allow publish** enabled (CLI: `--allow-publish`).
   Staging-only permission does not allow our direct OIDC flow. Select
   package access requiring 2FA and disallowing token publishing.
8. Set the environment variable to `NPM_PUBLICATION_MODE=oidc`. Future
   GitHub Release publications use OIDC with automatic provenance. No npm
   token secret is created or needed. Verify the published versions,
   prerelease dist-tags where applicable, and subsequent OIDC provenance.

Publication and visibility changes are owner launch actions. Repository fixes,
local tests, and tarball inspection do not authorize them.

## Recovery

For a **Release publish** dispatch retry, select the release tag in **Use
workflow from** as well as supplying that tag as the input. The protected
environment allows tag deployments; dispatching from `master` is rejected
even when the checkout step would select a release tag.

| Situation | Action |
| --- | --- |
| Prepare failed midway | The cleanup step deletes the branch; if not: `git push origin --delete release/vX.Y.Z`, re-run |
| Release PR is wrong | Close it, delete the branch, re-run prepare. No tag exists — nothing is public |
| Draft notes are wrong | Edit the body in the UI |
| Draft points at the wrong sha | Delete the draft (leaves no tag), re-run **Release draft** via dispatch with `version`/`target_ref`/`previous_tag` |
| Published; notes wrong | Edit the body; tag and npm artifacts are unaffected |
| Bootstrap workflow failed | Re-run with the same tag while mode remains `bootstrap`; matching uploaded assets are retained |
| Owner bootstrap partially published | Keep the mode `bootstrap`, verify the release assets again, and publish only confirmed missing versions with 2FA; configure OIDC after all three exist |
| Published; npm publish failed | Re-run **Release publish** via dispatch with the tag — all publish steps skip versions already on the registry |
| sdk published, cli failed | Re-run the publish workflow (sdk skips, cli publishes). If the sdk artifact itself is defective: cut a patch for both and `npm deprecate @hooknostic/sdk@X.Y.Z "superseded by X.Y.Z+1"` — **never unpublish** |
| Tag points at the wrong sha, npm already published | Never move the tag; cut a patch release |

## Deliberately not automated

Changesets/semantic-release (three shipped packages, lockstep, one
maintainer), a hand-maintained CHANGELOG (the generated notes are the
changelog), conventional-commit version selection, required approvals on the
release PR (self-approval theater), routine release candidates, and
auto-merge of the release PR — the merge *is* decision 1.
