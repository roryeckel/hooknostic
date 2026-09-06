# Decision 0012 — Claude plugin runtime dependencies

**Status:** Accepted — 2026-09-05 · Extends [ADR-0011](0011-agent-plugin-native-projection.md)

## Context

Hook runtimes are bundled, so they execute without a package manager or
`node_modules`. An Agent Plugin may also carry an MCP server implemented with
ordinary Node.js imports. Copying that server into a Claude plugin without its
dependency closure makes an installed marketplace copy fail at module
resolution.

Claude Code 2.1.260 was captured installing a plugin's npm dependencies in
its copied cache entry when the plugin root contained a `package.json` and
`package-lock.json` (`.capture/claude-marketplace-deps`). Its documented
install runs `npm ci --ignore-scripts`; it does not use pnpm or Yarn locks.

## Decision

`agentPlugin.runtimePackage` is a portable source input containing paths to a
runtime package manifest and npm lockfile. It is not an installed dependency
tree and does not make npm packaging a requirement for every projector.

Claude projection supports this input exactly. It writes the named source files
as `package.json` and `package-lock.json` at the emitted plugin root, replacing
the source package's development manifest. Claude owns the subsequent locked
install in its cache; Hooknostic neither invokes a package manager nor writes
`node_modules`.

The runtime manifest must be separate from the source project's build manifest.
It contains only production dependencies needed by projected Node components.

## Consequences

- A Claude marketplace plugin can use pure-JavaScript npm dependencies without
  committing `node_modules`.
- Dependency installation is reproducible from the emitted npm lockfile and
  runs with lifecycle scripts disabled. Dependencies that require lifecycle
  scripts or native compilation are outside this contract.
- The build report records `agent-plugin.runtime-package` and the generated
  manifest and lockfile, so review covers the exact inputs Claude will install.
- Future projectors choose their own materialization. In particular, OpenCode
  v2 is not committed to npm or npm-lock semantics by this decision.
