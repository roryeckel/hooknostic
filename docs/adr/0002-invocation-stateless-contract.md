# ADR 0002 — Invocation-stateless portable hooks

**Status:** Accepted — 2026-08-20

## Context

The three initial targets have different process models:

- Claude Code and Codex CLI execute command hooks as **subprocesses** — one process per
  hook invocation, receiving JSON on stdin and answering on stdout/exit code.
- OpenCode loads plugins as **persistent JS modules** inside a long-lived process; module
  globals survive across events.

Any portable state contract built on module memory would work on OpenCode and silently
fail on Claude/Codex.

## Decision

Portable hooks are documented and treated as **invocation-stateless**. Module-level
mutable state is not part of the portable contract. v0.1 ships **no persistence API**.
The generated OpenCode shim must not surface its persistent module lifetime as a feature:
the portable runtime behaves as if every event invocation is independent.

## Consequences

- Handlers receive everything they need via the event envelope and context object.
- A future storage API (per-plugin data directories, locking, cross-process concurrency)
  may be added deliberately later; it must work identically across subprocess and
  persistent-module targets before it ships.
- Tests for the OpenCode adapter explicitly exercise repeated dispatch in one module
  lifetime and assert no cross-invocation observable state.
