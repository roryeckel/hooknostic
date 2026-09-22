# ADR-0015: First-class repository-local integration

Status: accepted for implementation.

**Superseded in part by:** [ADR-0019](0019-agent-plugin-spec-deviations.md). A
Claude package remote declaration containing an environment reference is now
emitted and reported as the `claude:mcp-environment-expansion` deviation (HN106),
not omitted with HN205.

## Context

Artifact generation left each consumer responsible for native registrations,
loaders, timeout synchronization, and drift tests. These values already belong to
the compiler plan. Package projection also coupled portable component loading to
package identity, although local skill and MCP sources need no manifest.

## Decision

Separate source components from delivery. Targets declare `delivery: project` or
`delivery: package`; adapters own native formats. Named targets may share an
adapter, with at most one project target per adapter. Obsolete `mode` and
`agentPlugin` fields are not recognised; the unreleased API has one model. The
dedicated migration error they once raised has been withdrawn: no release ever
accepted those names, so there is nothing to migrate from, and the configuration
schema rejects them on its own.

The compiler's in-memory artifact plan feeds check, build, sync, and verify.
Adapters contribute generated files, structural edits, component capabilities,
and activation guidance. Core reconciles these against one configuration's
root-relative ownership manifest. Runtime filtering remains the default; native
registration budgets derive from the same hook IR as the generated dispatcher.

Dedicated generated files have whole-file ownership. JSON/JSONC native settings
have structural ownership, canonical content hashes, and array context hashes.
Equivalent unowned content is a conflict. Missing owned content can be repaired;
modified or ambiguous content requires resolution. Removing a target removes only
unchanged owned content. Shared documents remain in place.
When a configured skill source moves onto its native discovery destination,
reconciliation relinquishes prior whole-file ownership without rewriting or
deleting the source bytes, including the generated skill-directory attributes
marker when no copied skills still need it.

A project lock serializes synchronization. All replacement bytes are staged
before applying changes. A durable journal records preimages and expected hashes;
the ownership manifest is replaced last. Ordinary failures attempt rollback.
Interrupted or failed rollback requires recovery, which refuses unexpected edits.
This is recoverable multi-file reconciliation, with no atomic-visibility promise
to running harnesses. File data is flushed before rename; filesystem/power-loss
rename durability remains subject to platform guarantees.

Direct components reuse standards validation, inventory, and MCP launchers.
Native discovery is used where it already reads the source location; otherwise
owned copies retain skill-relative resources. Project component capability
profiles are independent from package projection and hook effects. Unverified
surfaces remain unsupported. Codex project MCP now uses format-aware TOML
ownership and a repository-locating stdio bootstrap, with Streamable HTTP native
projection; SSE is still declined. See `.capture/codex-project-mcp` for
configuration layering, trust, working-directory, and diagnostic boundaries.
Direct-source exclusions are evaluated relative to each configured skill root.
Per-target MCP overrides exist only for direct project sources: core validates
and applies them to clones before adapters generate launchers and configuration,
so the canonical Agent Plugins document remains unchanged. Argument and cwd
replacement is stdio-only; direct declarations and overrides may move cwd above
their source root only while remaining inside the project. A target
startup timeout becomes a per-server default, with adapters required to represent
every configured value or reject the build.

Codex hook registration uses the same repository-locating ownership boundary as
project MCP. The command finds the nearest integration from the session cwd,
validates configuration identity plus generated runtime hash and containment,
then imports the runtime with inherited standard streams and command-style argv.

Direct MCP sources and Agent Plugin packages retain distinct runtime contracts.
Generated project artifacts keep `${NAME}` references as text and resolve them
from the harness environment only when the project integration activates. An
missing OpenCode remote variable disables that declaration with a warning while
unaffected servers remain available. Packaged remote declarations remain literal
because the Agent Plugins standard prohibits environment expansion there. OpenCode performs its
native interpolation before project plugin hooks, so its generated direct-source
module resolves remote URL and header references itself. Project declarations
replace same-named inherited OpenCode servers and preserve unrelated entries.
Claude project MCP expands set references in both remote URLs and headers. No
lossless literal-preserving spelling across both fields was found in the live
probe, so a package-origin remote declaration containing such a reference is
omitted with HN205 rather than exposed to ambient environment values. Direct
Claude declarations continue to use the native runtime expansion.
Codex maps exact header
references to `env_http_headers` and bearer authorization to
`bearer_token_env_var`; references in URLs or mixed header values are rejected
because Codex has no equivalent native field.

## Amendment — 2026-09-22: default forms in direct sources

- **A direct source may write `${NAME:-default}`, and it resolves as Claude
  resolves it.** Hooknostic resolves a direct source's references itself in
  two places: the stdio launcher, on every harness, and OpenCode's remote
  module. Both understood only `${NAME}`. So a `${NAME:-default}` that Claude
  honors in a native declaration reached the server as literal text.
  - A capture on Claude 2.1.278 (`.capture/claude-project-mcp-environment`)
    established the rules: a defined variable wins even when it is empty, and
    only an undefined one takes the default.
  - Both places now implement those rules.
- **An unset `${NAME}` without a default still stops a stdio server.** Claude
  would pass the text on literally. The launcher keeps refusing, because a
  startup error that names the variable is better than a server that silently
  receives `${TOKEN}`. OpenCode's remote module still disables the server.
- **Codex forwards defaulted names too.** `env_vars` lists every name the
  launcher may expand, defaulted ones included, so a set value still wins. Codex
  0.154.0 starts the server when a listed name is absent from its environment
  (`.capture/project-integration`).
- **Codex remote declarations refuse the default form.** Codex's
  environment-backed header fields name a variable and have no fallback. A
  default form in a remote URL or header is now rejected, like the other
  references Codex cannot represent. It used to be sent on as literal text.

## Boundaries

Hooknostic compiles artifacts and optionally reconciles explicitly configured
project files. It never installs dependencies, starts servers while compiling,
changes trust, installs user-wide configuration, or publishes a release.
`doctor` reports validity, discoverability, runtime observations, and unresolved
activation steps without claiming successful hook execution.

## Delivery

Stage one establishes hook integration, ownership, recovery, and verification.
Stage two uses that infrastructure for skills and evidenced MCP surfaces. Both
are exercised by the synthetic local project, engine failure injection, and
credential-free harness playback. Contributor workflow commits artifacts and
ownership state together; publication remains human-triggered.
