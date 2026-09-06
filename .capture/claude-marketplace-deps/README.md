# Claude marketplace dependency installation capture

## Question

When Claude Code installs a marketplace plugin whose root contains an npm
lockfile, does it install that plugin's Node.js dependencies inside the cached
plugin version?

## Method

Create a local marketplace with one plugin. The plugin declares a small npm
dependency and has an npm lockfile, but its source directory has no
`node_modules`. Install it with an isolated `CLAUDE_CODE_PLUGIN_CACHE_DIR`,
then inspect the copied cache entry for the resolved dependency.

## Observation

Captured on Claude Code 2.1.260 (2026-09-05) with a local marketplace and
`CLAUDE_CODE_PLUGIN_CACHE_DIR` directed at this capture directory. The source
plugin contained `package.json` and `package-lock.json`, declared
`is-number@7.0.0`, and had no `node_modules` directory. After
`claude plugin install dependency-probe@hooknostic-dependency-capture --scope local`,
Claude created a copied cache entry at
`cache/cache/hooknostic-dependency-capture/dependency-probe/1.0.0/` containing
`node_modules/is-number`. Running Node from that copied entry resolved the
dependency and returned `true` for `is-number(42)`.

This establishes cache-time npm dependency installation. It does not establish
MCP startup ordering, behavior after a dependency-install failure, or support
for dependencies requiring lifecycle scripts.

## Consequences

For a copied Claude marketplace plugin, a root `package.json` plus npm lockfile
is a viable distribution path for pure-JavaScript Node dependencies. The
compiler must preserve both files in the projected plugin and must not claim
equivalent support for pnpm, Yarn, native-module, or non-Node dependencies
without separate evidence.
