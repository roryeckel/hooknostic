# ADR-0031: Unsupported components can have named, accepted omissions

## Status

Accepted. Extends ADR-0022's named shortfalls to unsupported component omissions.

## Context

A package can be useful on a harness that cannot deliver every component. Pi
can deliver hooks and skills but has no native MCP channel. The existing
`components.onUnsupported: "warn"` permits every unsupported component to be
omitted. Authors need to acknowledge one known omission while keeping other
unsupported components fatal, using the same adapter-qualified naming style as
deviations and degradations.

## Decision

An unsupported component profile cell may declare one `omission` with a stable
`id`, `summary`, and `evidence`. Its evidence must be named by that profile's
`validatedOn` records. The declaration shares the adapter's shortfall ID space.
It is invalid on a supported cell. A version range retains the declaration only
when every unsupported profile in the range declares the same ID; acceptance
cannot excuse an unclassified unsupported portion of the range.

`components.accept` may name `<adapter>:<omission-id>`. For that component, the
HN205 diagnostic becomes information. Support remains `unsupported`, the native
component is omitted, and reports retain discovered/emitted/skipped counts and
the omission reason. The HN205 includes the qualified omission ID. Portable
source files may still be copied as package content; acceptance does not create
native activation wiring for them.

The rule applies to package and project delivery, including named targets that
select an adapter through `adapter`. Unknown IDs remain HN501 errors, checked
against the configured adapters' declarations in any profile as in ADR-0022.
`inspect` and generated support documentation expose the declarations.

Pi declares `mcp-stdio-omitted`, `mcp-streamable-http-omitted`, and
`mcp-sse-omitted`, each on its corresponding unsupported MCP component. Their
provenance is the existing Pi native-MCP limitation; this compiler policy adds
no claim that a native MCP channel exists.

## Boundaries

Acceptance does not change hook capability requirements, invalid-input policy,
missing-projector failures, or per-item translation errors on supported cells.
Accepting one transport does not permit omission of another. Unsupported
components without a declared omission retain `onUnsupported` behavior.

## Consequences

One strict example configuration can target Pi alongside harnesses that deliver
MCP. It accepts only Pi's known stdio MCP omission. New unsupported transports
and other missing components still fail until deliberately addressed.
