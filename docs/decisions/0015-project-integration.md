# ADR-0015: First-class repository-local integration

Status: accepted for implementation.

## Context

Artifact generation left each consumer responsible for native registrations,
loaders, timeout synchronization, and drift tests. These values already belong to
the compiler plan. Package projection also coupled portable component loading to
package identity, although local skill and MCP sources need no manifest.

## Decision

Separate source components from delivery. Targets declare `delivery: project` or
`delivery: package`; adapters own native formats. Named targets may share an
adapter, with at most one project target per adapter. Obsolete `mode` and
`agentPlugin` fields receive migration errors; the unreleased API has one model.

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
projection; legacy SSE is still declined. See `.capture/codex-project-mcp` for
configuration layering, trust, working-directory, and diagnostic boundaries.

Direct MCP sources and Agent Plugin packages retain distinct runtime contracts.
Generated project artifacts keep `${NAME}` references as text and resolve them
from the harness environment only when the project integration activates. An
unset reference fails activation instead of sending placeholder text as a
credential. Packaged remote declarations remain literal because the Agent
Plugins standard prohibits environment expansion there. OpenCode performs its
native interpolation before project plugin hooks, so its generated direct-source
module resolves remote URL and header references itself. Codex maps exact header
references to `env_http_headers` and bearer authorization to
`bearer_token_env_var`; references in URLs or mixed header values are rejected
because Codex has no equivalent native field.

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
