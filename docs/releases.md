# Releases

The maintainer runbook. For what ships inside the packages and the everyday
tarball-testing flow, see [publishing.md](./publishing.md).

## What ships

Two npm packages: `@hooknostic/sdk` and `hooknostic` (the CLI). Everything
else in `packages/` is bundled into the CLI at build time — internal package
versions are metadata only, so the whole workspace versions **in lockstep**:
one release version everywhere, written by `scripts/set-versions.mjs`.

## The pipeline: three stages, two human decisions

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

1. Run the **Release prepare** workflow with the version (no leading `v`,
   e.g. `0.2.0`; a `-rc.1` suffix marks a prerelease). It validates the
   version, guards against duplicates, bumps every carrier, syncs the
   lockfile, rebuilds both committed example artifacts from the repo root,
   and opens `Release vX.Y.Z` with a checklist.
2. Review the PR — CI runs the 3-OS matrix, the artifact byte gate, and the
   docs drift gate on it. Merge it (**decision 1**).
3. **Release draft** fires on the merge: asserts every version carrier agrees
   (`set-versions.mjs --check`), asserts the publish guard was removed (see
   below), polls CI green at the merge sha, generates the notes (harness
   support table + PR-grouped section + direct-commit section), and creates a
   **draft** release.
4. Open the draft in the GitHub UI, read the notes (edit freely — it is just
   text), and click **Publish** (**decision 2**).
5. **Release publish** fires: checks out the tag, re-verifies versions and
   the guard, builds, tests, and publishes sdk then cli via npm Trusted
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

While unreleased, `packages/sdk` and `packages/cli` carry `"private": true` —
an executable never-publish guard. The release flow **cooperates** with it:
`release-draft` and `release-publish` both fail while the fields exist,
naming the checklist item. The first release PR removes them (and adds
`publishConfig: { access: "public", provenance: true }`) as a deliberate,
reviewed step tied to the release that consumes it.

What protects against accidental publish after the fields are gone, in
descending order of strength:

1. **Trusted Publishing with no token anywhere.** No `NPM_TOKEN` exists;
   publication is only possible from `release-publish.yml` in the `npm`
   environment. Stronger than `private: true` ever was.
2. The `npm` environment (required reviewer; deployments limited to `v*`).
3. A tag ruleset on `v*`.
4. The "exactly two publishable packages" test in `versions.test.ts`.
5. `provenance: true` — an out-of-band publish shows unattested on npm.

## First public release — one-time bootstrap

- Flip the repository to public.
- **Immediately after**, enable private vulnerability reporting (Settings →
  Advanced Security, or `gh api --method PUT
  repos/roryeckel/hooknostic/private-vulnerability-reporting`). This cannot be
  done earlier: the endpoint 404s on a private repository, because the feature
  exists so *outside* researchers can report privately and there are none while
  nobody can see the repo. Until it is on, `SECURITY.md`'s advisory-form link
  is dead and its email fallback is the only route.
- npmjs.com: Trusted Publisher for **both** packages → this repository,
  workflow **`release-publish.yml`**, environment **`npm`**.
- GitHub: create environment `npm` (required reviewer: owner; deployment
  tags limited to `v*`); add a tag ruleset for `v*`; create the fine-grained
  `RELEASE_PAT` secret (this repo only, Contents RW + Pull requests RW —
  needed so the release PR triggers CI, which a `GITHUB_TOKEN` push cannot).
- Run prepare, and tick the FIRST-PUBLIC-RELEASE-ONLY checklist items in the
  release PR, including the AGENTS.md carve-out update.

## Recovery

| Situation | Action |
| --- | --- |
| Prepare failed midway | The cleanup step deletes the branch; if not: `git push origin --delete release/vX.Y.Z`, re-run |
| Release PR is wrong | Close it, delete the branch, re-run prepare. No tag exists — nothing is public |
| Draft notes are wrong | Edit the body in the UI |
| Draft points at the wrong sha | Delete the draft (leaves no tag), re-run **Release draft** via dispatch with `version`/`target_ref`/`previous_tag` |
| Published; notes wrong | Edit the body; tag and npm artifacts are unaffected |
| Published; npm publish failed | Re-run **Release publish** via dispatch with the tag — both publish steps skip versions already on the registry |
| sdk published, cli failed | Re-run the publish workflow (sdk skips, cli publishes). If the sdk artifact itself is defective: cut a patch for both and `npm deprecate @hooknostic/sdk@X.Y.Z "superseded by X.Y.Z+1"` — **never unpublish** |
| Tag points at the wrong sha, npm already published | Never move the tag; cut a patch release |

## Deliberately not automated

Changesets/semantic-release (two shipped packages, lockstep, one
maintainer), a hand-maintained CHANGELOG (the generated notes are the
changelog), conventional-commit version selection, required approvals on the
release PR (self-approval theater), routine release candidates, and
auto-merge of the release PR — the merge *is* decision 1.
