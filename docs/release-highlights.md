# First public release

Hooknostic compiles portable hooks, skills, and MCP servers into native coding-agent
integrations. Agent Plugins 1.0 packages can be projected for Claude Code and Codex
marketplaces and OpenCode package delivery. Repository maintainers can use direct sources
with `init --local`, `sync`, and `verify`.

- Author portable TypeScript hooks and inspect exact, emulated, approximate, or unsupported behavior.
- Read shell commands through `tool.shell` and every file a tool targets through `tool.file`, including multi-file Codex patches; both views come from captured harness shapes, and `tool.input` stays verbatim. See [writing hooks safely](writing-hooks-safely.md).
- Declare capabilities relative to the event (`block`, `input.replace`), check them with a typed `ctx.capabilities.has()`, and return several effects from one handler.
- Keep the standard package source unchanged while adapters translate manifests, skills, MCP, and hooks.
- Build combined or hookless packages; the combined example bundles its MCP server for installation without workspace dependencies.
- Inspect component policies and accepted exceptions in diagnostics and build reports.
- Test hook decisions with portable-event `dispatch`, and verify marketplace installation locally without model spend.

Start with the [README](../README.md), [marketplace walkthrough](tutorials/04-packaging-with-agent-plugins.md),
or [repository integration](project-integration.md). Supported versions and evidence are
listed in the generated table. macOS has unit/fixture coverage but no real-harness validation.

The initial owner bootstrap uses verified CI-built tarballs and has no npm provenance
attestation. Subsequent trusted-publishing releases carry provenance; see [releases](releases.md).

## OpenCode v2 support

The public adapter remains `opencode`. Your configured version range selects
v1 or v2; the installed CLI does not override that choice. New configurations
recommend v2, while explicit v1 targets retain their own implementation and
validation. To build both, use two named targets with separate output directories.
A range spanning both families is rejected with HN203.

V2 supports portable hooks, skills, and stdio/Streamable HTTP MCP through
project and package delivery. Coverage includes model context on ordinary,
title, generation, and compaction requests over the captured HTTP provider
paths, plus default MCP OAuth against a local test issuer.

Support has explicit limits:

- Session-start observation, typed tool-error observation, permission handling,
  model context, and output conversion have approximate coverage. Plain custom
  tool exceptions can bypass observation; permissions cover pending ask decisions.
- Stop prevention and notification are approximate. Both post a synthetic
  user-role message after a succeeded top-level execution; interrupts, model
  failures and subagent children post nothing. A notice surfaces only when the
  session next runs: there is no user-only notification channel. Legacy MCP SSE
  remains unsupported.
- A checkout nested inside another (a linked worktree in the main checkout)
  runs its own generated hooks and MCP servers, and each session dispatches only
  its own location's hooks.
- MCP calls remain `kind: "other"`; `kind: "mcp"` guards do not cover them.
  A captured native name can be guarded explicitly.
- WebSocket and other provider paths, provider/custom OAuth, executed websearch,
  and background or deeply nested subagents remain unverified. macOS has unit
  and fixture coverage, but no real-harness playback evidence.

See [OpenCode families](opencode-families.md) for migration instructions,
evidence, and the supported alternatives. The support table below records each
family's reference build separately; v1 evidence does not establish v2 support.
