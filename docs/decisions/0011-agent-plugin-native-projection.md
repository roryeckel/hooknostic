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
- Claude Code is the first projector. Codex and OpenCode projection are deferred
  until their plugin APIs have their own capture and adapter work.

## Consequences

- An Agent Plugin author can produce a Claude Code plugin without authoring any hooks.
- Harness-specific merge and transport rules remain in adapters; core coordinates
  validation, reporting, and atomicity only.
- The public projection interface can accommodate another versioned projector without a
  core redesign.
- Hooknostic remains a compiler. It does not install plugins, manage marketplaces, run
  MCP servers, or become an Agent Skills authoring framework.

## Amendments — 2026-09-06

Hardening after external review of the first projection release. None of these change
the boundary above; they close gaps between what the build reported and what it did.

- **A projection target without a projector is an error.** `onUnsupported` degrades
  individual components. It never applied to a whole projection, and a `"warn"` policy
  on a projector-less target used to commit an empty (or hook-only) output while
  reporting the target built. Core also refuses any projector plan with zero files.
- **Inventory is deny-listed by default.** The loader always omits `.git`,
  `node_modules`, `.env`, `.env.*`, and `.npmrc` at any depth; core omits the config
  file and hook `entry` alongside the outputs and transaction paths it already omitted.
  A deny-list was chosen over an `include` allow-list because authors — human or agent —
  forget to extend allow-lists when adding a skill or a server script, and a silently
  incomplete package is worse than an over-inclusive one. The build report lists every
  inventoried path (`agentPlugin.sourceFiles`).
- **Skipped components fail the build by default.** The loader keeps the specification's
  lenient skip-and-continue for library consumers; the build maps those skips to errors
  unless `agentPlugin.onInvalid: "warn"`. The shipped JSON schemas are the
  specification's own and are not tightened; the loader's stricter rules are documented
  instead.
- **`check` runs the whole pipeline.** Bundling, projection, overlay merging, and
  artifact validation all run in memory under `check`; only staging and the commit are
  skipped. Projector-time failures were previously reachable only from `build`; a write
  the target filesystem itself refuses (path length, reserved names) still is.
- **The runtime package pair is validated as `npm ci` would validate it** (see
  [ADR-0012](0012-claude-plugin-runtime-dependencies.md)): npm lockfile v2/v3 only,
  root dependencies equal to the manifest, every dependency locked at a satisfying
  version and resolution, the transitive graph complete. The validator lives in
  `@hooknostic/agent-plugin` so a future projector can reuse it.
- **`defineConfig` is generic** over the configured target names, so
  `agentPlugin.targets` and the entry-or-agentPlugin requirement are checked by the
  editor as well as by the schema.
