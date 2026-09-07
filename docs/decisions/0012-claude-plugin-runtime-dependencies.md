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

Because Claude's install is locked and script-free, the pair is validated at
build time the way that install would validate it (amended 2026-09-06), with
the rules taken from npm's own packages rather than reimplemented —
`npm-package-arg` and `hosted-git-info` classify every spec,
`validate-npm-package-name` checks names, and arborist's `dep-valid` and
lockfile validation are ported literally: the manifest declares only
`dependencies`, under names npm accepts; the lockfile is an npm
`package-lock.json` with `lockfileVersion` 2 or 3 (pnpm and Yarn locks are
rejected by name rather than as generic JSON errors); its root entry declares
exactly the manifest's dependencies; every dependency's `node_modules/<name>`
entry satisfies its spec as npm checks it (loose semver without prereleases
for ranges and `npm:` aliases, a registry tarball resolution for dist-tags,
an identical `resolved` for tarball URLs, the same repository and pinned
commit for git specs); and every locked package's own dependencies and
required peers are locked where they resolve, so `npm ci` has nothing to
re-resolve, with flat `overrides` applied to every edge the way arborist
applies them (nested, selector, and `$ref` overrides are rejected as
unmodelled). Local paths, `file:`, `link:`, and other package-manager
protocols are rejected on any edge because the harness installs from a cached
copy.

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

## Amendments — 2026-09-07

- **The pure-JavaScript boundary is enforced, not just declared.** The
  consequence above put lifecycle-script and native dependencies outside this
  contract, but the validator only mirrored npm's own rejections — and
  `npm ci --ignore-scripts` does not reject such a package, it installs it with
  its setup skipped. So a dependency needing `preinstall`/`install`/`postinstall`
  passed `check` and failed at import time in the user's installed plugin. A
  lockfile entry declaring `hasInstallScript` is now rejected, which widens the
  validator's charter from "reject what `npm ci` rejects" to "…plus enforce this
  boundary". `agentPlugin.runtimePackage.allowInstallScripts` names packages
  exempted from the rule: it does not run the script — Hooknostic invokes no
  package manager and the flag is the harness's — it records that the author
  verified the package works without it, per package rather than as one switch.
- **`hasInstallScript` is npm's own signal, not a proof.** npm writes it only
  when true, so a hand-written or pre-v2 lock may omit it, and a package
  shipping a prebuilt binary with no install script is not caught at all. The
  lock's `os`/`cpu` fields are the complementary signal for platform-specific
  packages and remain unchecked; a plugin cache is per-machine, so that is a
  differently shaped problem than this one.
