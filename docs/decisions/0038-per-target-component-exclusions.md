# ADR-0038: Author exclusions are target-specific delivery decisions

## Status

Accepted, 2026-11-06. Implements issue #158 and extends ADR-0011, ADR-0022,
ADR-0030 and ADR-0033.

## Decision

`components.excludeFor` maps configured target names to additional exclusion
globs on package and project delivery, including direct sources. Global exclusions
remain in force. Filtering precedes component discovery and validation, so
intentional absence is not unsupported delivery. The package manifest remains
mandatory; compiled hook artifacts are not component source files.

Package paths are relative to `components.root`. Direct skill paths are relative
to each collection (`review/SKILL.md`); direct MCP is addressed as `mcp.json`
regardless of its filename. Matching uses the existing case-insensitive POSIX
glob rules. Excluding `SKILL.md` excludes the whole skill; excluding an auxiliary
file retains the skill.

Materializers retain their existing execution policy. Their output is filtered
per target at its `into` path before projection and final command validation.
Exclusions do not suppress provider execution or remove its build inputs.
Retaining an MCP declaration while excluding its required executable fails input
validation. Explicit runtime-package configuration cannot name excluded inputs.

Independent target views feed analysis and generation. Report schema version 2
gains optional `authorExclusions` and target `sourceFiles`. Exclusion records
distinguish `omitted` from `exposed`; unsupported omissions and adapter support
ratings retain their meaning. Aggregate source inventory is the union of selected
target inventories. Target MCP inventories describe retained declarations.

## Shared project discovery

Each physical skill copy contains the files its retaining writers require.
Configured readers participate through adapter-owned, evidence-backed discovery
paths. Excluded content another target retains may remain discoverable. Authored
native copies also remain untouched. Previously owned generated copies are
reconciled normally rather than mistaken for authored content.

Unenforced exclusions use the `skill-exclusion-unenforced` degradation, qualified
by adapter in `components.accept`. HN101 follows `onDegraded`: error by default,
warning when configured, information when accepted. Warning and acceptance retain
the other target's content and report the exposed path and reader/writer. Exposed
skills count as delivered. Invocation-policy checks remain independent: hiding
implicit invocation does not prevent explicit invocation and is not exclusion.

Shared MCP files use existing adapter-owned disable settings where captured.
Ownership conflicts, drift and differing shared definitions remain errors.
Acceptance does not authorize overwriting authored files. Removing an exclusion
restores generated delivery through normal sync.

## Consequences

One config and report can describe asymmetric delivery. This is author policy,
not a new claim about MCP or plugin capabilities. Additional discovery paths or
native isolation mechanisms still require captured evidence.
