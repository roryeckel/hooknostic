# Decision 0011 — Project Agent Plugins into native plugins

**Status:** Accepted — 2026-09-04 · Supersedes [ADR-0004](0004-agent-plugins-relationship.md)

**In short:** Agent Plugins remains a peer standard and the portable source of truth.
Hooknostic may now compile a validated Agent Plugins 1.0 package into a complete
harness-native plugin, independently of whether the package also contains Hooknostic
hooks. Projection never mutates the source package.

## Context

Agent Plugins 1.0 standardizes manifests, Agent Skills, MCP servers, and namespaced
client extensions. Codex consumes that package model natively. Claude Code and OpenCode
have their own plugin surfaces, so authors otherwise need to maintain parallel package
trees even when the underlying components are representable.

ADR-0004 limited Hooknostic to adding hook artifacts under a client-extension directory
inside the portable package. That kept the package conforming, but it did not solve the
inverse problem: producing an installable native plugin from the portable package, and
it required a source-side generated tree.

## Decision

- `@hooknostic/agent-plugin` owns offline Agent Plugins 1.0 loading, validation, secure
  file inventory, and target-neutral projection contracts.
- A harness adapter may expose a versioned `agentPluginProjector`. Component support is
  reported with the same exact/emulated/approximate/unsupported vocabulary used for
  hooks, but component IDs are a separate public vocabulary.
- `hooknostic build` composes package files, target-specific overlay files, native
  metadata, and optional compiled hook artifacts into one staged target output. The
  existing transaction commits all selected targets or none.
- `entry` is optional when `agentPlugin` is present. A hookless build performs no runtime
  bundle. Projection targets are explicit and default to failing on an unrepresentable
  valid component; `onUnsupported: "warn"` records precise omissions instead.
- The Agent Plugin root is read-only input. Configured outputs and transaction paths are
  excluded from inventory, and the old source-side namespaced output is removed. A
  non-excluded symbolic link that escapes the package rejects the whole package before
  component contents are parsed; this deliberately strengthens the standard's narrower
  component failure boundary so projection never reads outside its declared input root.
- Claude Code is the first projector. Codex continues to consume Agent Plugins directly
  and receives only Hooknostic's separate local hook artifact. OpenCode projection is
  deferred until its plugin API has its own capture and adapter work.

## Consequences

- An Agent Plugin author can produce a Claude Code plugin without authoring any hooks.
- Harness-specific merge and transport rules remain in adapters; core coordinates
  validation, reporting, and atomicity only.
- The public projection interface can accommodate another versioned projector without a
  core redesign.
- Hooknostic remains a compiler. It does not install plugins, manage marketplaces, run
  MCP servers, or become an Agent Skills authoring framework.
