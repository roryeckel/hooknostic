# Target-aware skills and component delivery

0.11.0 adds build-time skill context and per-target component exclusions. One
portable skill can identify its intended harness and refer to sibling skills,
while one configuration can select different component files for each target.
Project synchronization also reports generated-file ownership conflicts together,
with recovery guidance for the command you ran.

## What is included

- **Build-time skill context.** `${HARNESS}` becomes the intended projection
  identifier, and `${SKILL_REF:setup}` becomes the native prompt reference for an
  available sibling named `setup`. Both work in owned `SKILL.md` bodies for
  package and project delivery, including package-sourced project skills. Sibling
  names follow the actual emitted naming policy. See
  [skill context tokens](configuration.md#identifying-the-target-and-naming-sibling-skills)
  and [ADR-0037](decisions/0037-skill-context-tokens.md).
- **Per-target exclusions.** `components.excludeFor` maps configured target names
  to additional file exclusion globs. Global `components.exclude` still applies.
  Filtering works for package components and direct project sources, before
  discovery and validation; excluding a skill's `SKILL.md` omits the whole skill.
  Reports distinguish omitted files from files still exposed through shared
  discovery, with optional `authorExclusions` and per-target `sourceFiles` in
  report schema version 2. See [configuration](configuration.md) and
  [ADR-0038](decisions/0038-per-target-component-exclusions.md).
- **Generated-file conflicts together.** `sync`, `sync --dry-run`, and `verify`
  list all whole generated-file ownership conflicts with project-relative paths.
  Recovery guidance explains how to preserve edits, move aside conflicting files,
  then synchronize and verify. Ownership rules, JSON output shape, and exit codes
  are unchanged. See [ownership and recovery](project-integration.md#ownership-and-recovery).

For example, a portable skill body can contain:

```markdown
Run `node scripts/status.mjs --harness ${HARNESS}`.
If setup is needed, run ${SKILL_REF:setup} first.
```

The values are resolved during projection. `${HARNESS}` identifies the intended
target; it does not detect the running process or consult inherited environment
variables. A sibling reference is prompt text and does not guarantee invocation.

## Upgrading from 0.10.1

- **Rebuild packages or re-sync projects** after upgrading to regenerate owned
  output. Existing configurations do not need new options.
- **Review newly recognized skill tokens.** `${HARNESS}` and `${SKILL_REF:...}`
  now have compiler meaning in owned skill bodies, including code blocks. Missing
  or skipped siblings, malformed closed references, and tokens in frontmatter or
  skills discovered in place remain literal and report
  `skill-reference-unexpanded` (HN101), failing by default under the existing
  degradation policy. Scripts and other bundled files are not rewritten.
- **Key exclusions by configured target name.** Package exclusion paths are
  relative to `components.root`; direct skill paths are relative to each skill
  collection, and a direct MCP document is addressed as `mcp.json` regardless of
  its source filename. Materializers keep their existing execution policy even
  when their output is excluded.
- **Preserve the ownership record when recovering conflicts.** Keep an existing
  `.hooknostic/integration.json`, preserve needed edits, move aside the reported
  conflicting files, run `sync` with the same configuration, then `verify`.
  Removing conflicts alone does not establish the integration verification needs.

## Limits

- **Shared project discovery still applies.** A file excluded for one target may
  remain discoverable through another target's retained copy or an authored
  native copy. An unenforced skill exclusion reports
  `skill-exclusion-unenforced` (HN101) and fails by default. Warning or explicit
  acceptance retains the exposed content; it does not make the exclusion work.
- **Different skill bytes cannot share one destination.** If target-specific
  token substitutions produce different bytes at a shared project skill path,
  synchronization rejects the conflict before writing. Use separate package
  projections or shared native text where appropriate.
- **Sibling references stay within the selected skill set.** Arbitrary external
  plugin references need native text in target-specific sources or supported
  package overlays. Successful context-token substitutions add no degradation;
  `${SKILL_DIR}` retains its existing independent policy.
- **Harness support ranges are unchanged.** The context-token feature reuses
  existing reference evidence, with a bounded Claude overlay-name probe recorded
  in ADR-0037. It does not promise automatic skill invocation or broader native
  alias behavior.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
