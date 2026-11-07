---
name: release-preparation
description: Prepare a Hooknostic release when asked to prepare the next release, cut a release, bump the release version, or write release highlights. Use when working on docs/release-highlights.md, scripts/set-versions.mjs, or .github/workflows/release-prepare.yml.
---

# Release preparation

## Required context

Read [the release runbook](../../../docs/releases.md#prepare-one-release-pr)
and `.github/workflows/release-prepare.yml` before changing version carriers,
rebuilding release artifacts, or dispatching preparation. The runbook owns the
procedure, commands, gates, and recovery paths.

## Workflow

- Establish the release version from the user's request or prior session
  decisions. Ask for a version only when it has not already been chosen;
  version selection is a human decision.
- Follow the runbook's single-PR preparation flow. Put highlights and related
  release documentation on the preparation branch at the current release
  version; let the workflow generate the bump and artifacts.
- Apply the repository's verification and upstream-push rules. When pushing
  and dispatching are authorized, use the pushed preparation branch as the
  dispatch ref. Follow the run through completion and verify the resulting
  release PR contains the intended changes.
- If a release PR already exists, follow the runbook's instructions for
  updates after preparation. Do not start a second preparation run for the
  same version merely to add follow-up changes.
- Finish with the PR link and validation results. Merging the PR and publishing
  the draft are separate human decisions; preparation stops before them.
