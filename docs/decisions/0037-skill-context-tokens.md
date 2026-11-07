# ADR-0037: Build-time harness and sibling skill references

## Status

Accepted, 2026-11-06. Addresses [issue #157](https://github.com/roryeckel/hooknostic/issues/157)
and extends [ADR-0028](0028-skill-directory-token.md).

## Context

A script launched by a skill cannot reliably identify its harness from inherited
environment variables: a nested harness inherits the outer harness's markers.
The compiler already knows which projection it is emitting. Static skill text
also needs to name sibling skills whose native references differ by target and
delivery, including OpenCode's package renaming (ADR-0021).

## Decision

In owned SKILL.md bodies, substitute `${HARNESS}` with the projection identifier:
`claude`, `codex`, `copilot`, `opencode`, `opencode-v2`, or `pi`. This is the intended
projection, not runtime detection. A different harness reading the artifact does
not change the value. Adapter IDs, version selection, and configuration keys stay
unchanged; in particular both OpenCode families still use adapter `opencode`.

`${SKILL_REF:setup}` names an available sibling by its authored name. Package
delivery resolves within the package; project delivery resolves within the
selected project skill set, including a package delivered as project skills.

| Target | Package reference | Project reference |
| --- | --- | --- |
| Claude Code | `/plugin:setup` | `/setup` |
| Codex | `$plugin:setup` | `$setup` |
| Copilot | `/plugin:setup` | `/setup` |
| OpenCode 1 | `/final-emitted-name` | `/setup` |
| OpenCode 2 | `@plugin/setup` | `@setup` |
| Pi | `/skill:setup` | `/skill:setup` |

Adapters supply the projection identifier and a map from authored names to full
native prompt references. Shared code never branches on a harness name. Build
these maps after component selection. OpenCode 1 uses the actual rename result,
including `skillNames: "authored"`, already-prefixed names, collisions, and names
whose frontmatter cannot be safely rewritten. Apply body substitutions after any
supported native overlay and name rewrite. Existing exported helper calls remain
valid; missing context leaves the relevant token unexpanded and reported.

Only the body is rewritten, including code blocks. Preserve all other text,
line endings and BOMs, and do not rewrite scripts or other bundled files.
Substitution is a single pass: replacement text is not itself interpreted as a
portable token. No environment lookup, dependency discovery, or runtime shim is
involved. These substitutions are exact compiler transforms and add no
degradation; a `${SKILL_DIR}` rewrite retains its existing independent policy.

Unresolved sibling references, malformed closed `${SKILL_REF:...}` tokens, and
portable tokens in frontmatter or skills discovered in place stay literal and
report `skill-reference-unexpanded` (HN101). It fails by default and follows
`components.onDegraded` / `components.accept`. Missing or omitted siblings are
never guessed. Other shell expressions remain untouched and unreported.

External plugin references are native text in target-specific source files or
supported overlays. `${SKILL_REF:plugin/setup}` is not supported: an arbitrary
third-party plugin's naming cannot be inferred from Hooknostic's conventions.
There is no external-reference map or new configuration option. Native plugin
overlays retain their existing package-only delivery boundary.

## Evidence and limits

The harness identifier is compiler-owned data. The native reference spellings
reuse existing evidence; this change does not claim a new live capture:

- [Skill invocation probes](../../.capture/skill-invocation/README.md) establish
  Claude and Codex project/package reference forms. OpenCode 1's native
  `run --command` loads its final skill name. The slash spelling for that command
  is owner-reported in issue #157, weaker than an independently captured TUI
  interaction. [Namespace captures](../../.capture/opencode-skill-namespace/README.md)
  establish OpenCode 1's final names and rename behavior.
- The [Claude overlay-name probe](../../.capture/skill-invocation/claude-overlay-name.md)
  confirms the canonical directory-based reference still loads a package skill
  when a native overlay changes its frontmatter name. Claude retains that
  canonical reference while projecting the effective overlay body.
- OpenCode 2's same invocation probes use `@skill` / `@plugin/skill` with a
  scripted skill-tool call. They establish a reference and successful loading,
  not automatic injection by a TUI picker.
- [Copilot's interactive probes](../../.capture/copilot/README.md) observe
  `/skill` and `/plugin:skill` delivering the body through user invocation.
- [Pi's feature probes](../../.capture/pi/FEATURES.md) cover explicit
  `/skill:feature-probe` invocation for project and installed-package skills.

References are prompt text, not a promise that a model will invoke a skill.
They do not bypass invocation policy or guarantee a unique installed skill in
a harness with a flat namespace. Existing profile evidence and support levels
remain in force; no harness version range is widened.

## Consequences

A script can receive `--harness ${HARNESS}` through its authored command, while
prose can say `Run ${SKILL_REF:setup} first.` Successful rewrites are generated
artifacts rather than byte-for-byte copies, using ADR-0028's existing report.
Project reconciliation still rejects different bytes at a shared destination
before writing. Use separate package projections or shared native text when
targets cannot share the same project skill file. MCP launch hints are separate
work.
