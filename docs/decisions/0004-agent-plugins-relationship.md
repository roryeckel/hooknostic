# Decision 0004 — Agent Plugins is a peer, not a dependency

**Status:** Accepted — 2026-08-20 · Referenced from code and docs as **ADR-0004**

**In short:** the Agent Plugins standard already covers portable packaging (skills, MCP
config). Hooknostic fills the one gap it leaves open — lifecycle hooks — using the
standard's own extension mechanism, and never modifies or forks its schema. You can use
Hooknostic with or without an Agent Plugins package.

## Context

Agent Plugins 1.0 standardizes a portable plugin package (skills, MCP config) and
provides a formal client-extension mechanism: reverse-domain namespaced entries under the
`extensions` manifest key and top-level namespaced extension directories
(e.g. `com.example.client/hooks/hooks.json`). Its root `plugin.json` schema is closed:
unknown top-level fields are non-conforming (clients report and ignore them).

Lifecycle hooks are intentionally client-specific in Agent Plugins 1.0. That is exactly
the gap Hooknostic fills.

## Decision

Hooknostic **consumes or augments** an Agent Plugins package; it never redefines it.

- When `plugin.json` is present, Hooknostic may reuse metadata (name/version/description)
  and generate harness-native hook artifacts into legal namespaced extension directories.
- Hooknostic never adds root-level fields to `plugin.json` outside the `extensions`
  mechanism, and never alters portable components (`skills/`, `mcp.json`).
- **Standalone mode is first-class**: a repo needs only `hooknostic.config.ts` + hook
  source. Agent Plugins integration is additive, not required.

## Consequences

- Combined packages remain valid Agent Plugins packages by construction.
- Extension namespace names are adapter-owned facts (confirmed against client
  conventions), not hardcoded core constants.
- If a standardized hook component ever emerges in Agent Plugins, Hooknostic semantics
  can be proposed as input; until then no speculative schema coupling.
