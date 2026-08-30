# Decision 0001 — Capabilities are separate from events

**Status:** Accepted — 2026-08-20 · Referenced from code and docs as **ADR-0001**

**In short:** two tools can both fire a "before tool runs" event and still let hook code
do very different things with it. Hooknostic tracks *what you can do* (block, rewrite,
add context, …) separately from *when you're told about it*, and makes every gap
visible instead of papering over it.

## Context

Coding-agent harnesses (Claude Code, Codex CLI, OpenCode) expose overlapping lifecycle
hook surfaces, but with materially different control semantics. A harness may expose a
"before tool" event while differing in whether hook code can block the call, ask for user
approval, rewrite the tool input, add model-visible context, or merely observe.
Optimistic adapters that map "closest equivalent" behavior silently change plugin meaning
across targets.

## Decision

Event availability and effect semantics are modeled separately:

- A normalized **event vocabulary** (`tool.before`, `session.start`, …) describes
  lifecycle meaning, not vendor event strings.
- **Capability IDs** are stable, event-scoped semantic strings
  (`tool.before.block`, `tool.after.output.replace`, …). Event-scoping prevents false
  equivalence between, say, blocking a pending tool call and "blocking" after a tool
  already ran.
- Every hook statically declares each non-observation capability it may rely on as
  `required` or `optional`. Using an event implies its `<event>.observe` capability.
- Adapters publish **versioned capability matrices** mapping each capability to a support
  level: `exact > emulated > approximate > unsupported`, with rationale for non-exact
  entries.
- The compiler resolves every declared capability against every configured target
  *before* artifact emission and applies a configurable compatibility policy
  (default: `minimum: "emulated"`, `onBelowMinimum: "error"`).

## Consequences

- Degradation is always visible: diagnostics and the build report record every
  exact/emulated/approximate resolution and every optional miss. Nothing is silently
  dropped.
- Returning an effect whose capability was not declared (or is unsupported on the
  executing target) is a runtime contract violation (HN401), not a soft fallback.
- "Harness X supports Y" is never a timeless boolean: capability data is a function of
  harness *and version range*, stored as data in adapters, not as scattered version
  checks.
- Adding a harness means writing a capability matrix + decoder/encoder, never changing
  core SDK semantics.
