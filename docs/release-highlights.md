# Skills can require explicit invocation

0.6.0 adds a portable declaration for skills that should be loaded only when the
user explicitly invokes them. Declare it once in a neutral project source or an
Agent Plugin package:

```yaml
metadata:
  hooknostic/allow-implicit-invocation: "false"
```

Hooknostic projects the policy into each target's native settings and reports
support through the separate `agent-plugin.skills.invocation-policy` component
capability. Native explicit invocation remains available on supported targets;
the declaration withholds automatic model selection. See
[project integration](project-integration.md) and
[ADR-0030](decisions/0030-skill-invocation-policy.md) for the authoring and
compatibility rules.

- Both project delivery and packaged skills use the same string-valued metadata.
  The portable setting takes precedence over native settings during projection,
  while unrelated native fields, comments and skill body bytes are preserved.
- Policy is composed for every configured reader of a generated discovery
  directory, including readers excluded by `components.targets`. That setting
  does not prevent a harness from discovering another target's generated copy.
- A missing gate fails by default. `components.onUnsupported: "warn"` omits the
  affected skill instead of delivering it without the requested policy. Shared
  copies are omitted for every affected reader.
- Named `components.accept` entries can explicitly accept an unavailable gate
  or an unchanged authored native source. Reports retain the actual support
  rating and record the accepted HN101 degradation.

## Migrating

- Existing skills without the declaration retain their authored native behavior.
  Add it only to skills that need explicit invocation.
- Quote `"false"` and `"true"`: YAML booleans are invalid for this reserved
  metadata. Invalid policy remains an error even with
  `components.onInvalid: "warn"`.
- Keep authored skills in a neutral directory such as `skills/` and let
  Hooknostic own the native copies. Sources already inside a configured harness's
  native discovery directory are left untouched; move them to a neutral source
  to let Hooknostic enforce and verify the policy.
- Inspect `agent-plugin.skills.invocation-policy` for the configured target,
  delivery and version range before building. Broad ranges may include versions
  without a captured gate and need narrowing; exact support and evidence live in
  [harness support](harness-support.md).
- Removing the declaration regenerates from the authored source and restores
  its native settings. Generic warning settings do not authorize delivery
  without a gate; use the precise shortfall IDs documented in
  [project integration](project-integration.md) for deliberate acceptance.

## Limits

- This is discovery policy, not access control. Direct reads and forced skill
  loads can remain possible; command-menu visibility, tool grants and execution
  settings are outside this release's policy.
- Gate support is version-scoped and separate from skill delivery. Unprobed
  older versions remain unsupported, and the captured OpenCode v1 permission
  translation is rated emulated.
- An unowned native copy cannot be overwritten or reported as omitted. A missing
  gate can remove a shared copy for other configured readers too.

## Other changes

- Fix Windows Claude playback's folder-trust selection when a private terminal
  control sequence follows the options.
- Preserve valid unions of complementary version-range clauses while rejecting
  gaps and wider coverage in the version-literal check.
- Record OpenCode v2 playback phases and subprocess output as work happens.
  Failed CI playback retains diagnostic artifacts, so a setup timeout identifies
  the stalled phase and command.
- Include the latest recorded harness playback validation, dependency refreshes
  and authenticated LiteLLM sidecar verification.

Start with the [README](../README.md); the [release runbook](releases.md)
describes the preparation, draft and publication stages.
