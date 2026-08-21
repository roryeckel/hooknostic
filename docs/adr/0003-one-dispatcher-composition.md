# ADR 0003 — One native dispatcher per lifecycle point

**Status:** Accepted — 2026-08-20

## Context

Claude Code and Codex may run multiple matching native hooks independently and
potentially concurrently, with harness-defined (or undefined) ordering and
result-merging behavior. If each portable handler were emitted as its own native hook,
composition semantics would be owned by each harness and differ per target.

## Decision

Hooknostic generates **one native entry point per lifecycle event/matcher group** and
dispatches all matching portable handlers internally, in declaration order.

Composition rules (v0.1):

1. Handlers execute sequentially in declaration order after matcher filtering.
2. Input replacements apply immediately; later handlers see the updated input.
3. Context additions accumulate in declaration order, subject to a conservative
   configurable size cap.
4. A `block` effect is terminal for the dispatch.
5. A `requestApproval` effect is terminal (mutating after escalation is ambiguous).
6. For post-tool events, output replacements apply immediately; `blockContinuation` is
   terminal.
7. No effect means continue unchanged.
8. Conflicting terminal effects resolve to the first terminal effect in declaration
   order; the runtime records which handler terminated dispatch.

## Consequences

- Ordering is deterministic and identical on every target.
- The host harness never merges Hooknostic results; it sees exactly one hook result per
  lifecycle point.
- Handler errors/timeouts are governed by the plugin's configured policy
  (`onHookError: "continue"` default, per ADR-0001 visibility rules).
