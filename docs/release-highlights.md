# GitHub Copilot CLI, and harnesses that read each other's files

0.9.0 adds GitHub Copilot CLI as the sixth target. Package delivery emits an
Agent Plugins 1.0 package that Copilot loads natively, and project delivery
writes `.github/hooks`, `.agents/skills` and the root `.mcp.json`. Copilot also
reads Claude Code's hooks, skills and MCP file. This release makes each harness
run only the output generated for it, and records that rule as
[ADR-0033](decisions/0033-no-cross-harness-compatibility-reads.md). See the
versioned [harness support table](harness-support.md) for support levels and
their evidence.

## What is included

- A `copilot` adapter for `>=1.0.101 <2`, referencing 1.0.101. Its hook
  payloads, tool argument shapes and effect channels were captured on Windows
  and Linux, and its shell dialect on macOS as well. It covers all of these
  events: session start and end, prompts, tools, tool errors, permission
  requests, compaction notices, subagents, and turn stops.
  - **Exact:** blocking and approval requests before a tool, input and output
    replacement, and tool-time context.
  - **Approximate:** blocking continuation after a tool, and preventing a
    subagent stop.
  - **Emulated:** prompt context, which reaches the model as prompt text.
- Package delivery: `copilot --plugin-dir ./dist/copilot`, or a local or
  git-hosted marketplace. Skills and stdio, streamable-HTTP and SSE MCP
  servers ship in the package, and the hooks go under
  `com.github.copilot/hooks/hooks.json`. The combined example now builds a
  Copilot package and includes a `.github/plugin/marketplace.json` for it.
- Project delivery for `sync`, `verify` and `recover`. It writes
  `.github/hooks/hooknostic.json`, copies skills to `.agents/skills`, and
  declares MCP servers in the root `.mcp.json`. `doctor` reports the installed
  version without triggering Copilot's self-update.
- **Claude and Copilot in one project.** Copilot runs `.claude/settings.json`
  hooks, so Hooknostic's Claude entries carry a non-numeric `timeoutSec`. That
  key makes Copilot drop the file's hooks; Claude ignores it. Both harnesses
  read the root `.mcp.json`, so each server has one entry that serves both.
  When `components.targets` selects only one of them, `sync` lists the shared
  servers in the other harness's native disable setting. Names you added to
  that setting yourself are kept.
- `tool.mcp` is never set on Copilot. It names an MCP tool
  `<server>-<tool>`, either part may contain hyphens, and no hook payload
  states the split. Guard MCP calls on `kind: "mcp"` and `nativeName`
  ([ADR-0032](decisions/0032-stated-mcp-identity.md)).
- The harness playback suite drives Copilot against a loopback model server
  on Windows and Linux, with no credentials and no spend. Claude Code's
  deferred MCP tools are now found through ToolSearch during playback.

## Upgrading from 0.8.0

- **Re-sync Claude projects.** `sync` rewrites Claude's project hook entries
  with the `timeoutSec` marker, and adds `cwd: "."` to stdio servers in the
  root `.mcp.json`. That `cwd` is needed under `GITHUB_WORKSPACE`, and Claude
  ignores it. Until you run `sync`, `verify` reports the old entries as drift.
- **`.github/mcp.json`.** If `sync` would create a root `.mcp.json` while
  `.github/mcp.json` lists servers, it now stops before writing anything. The
  root file would hide those servers from Copilot. This applies to a
  Claude-only project too. Move the servers into the root file, then fence
  any Claude should not start with `disabledMcpjsonServers`.
- **Conflicting definitions.** A server whose per-target overrides define it
  differently for Claude and Copilot fails `sync`, because the shared file
  holds one definition per name.

## Limits

- Copilot reads `.claude/skills` as well as `.agents/skills`. A skill in both
  resolves to Copilot's own `.agents/skills` copy, but a hand-written skill
  that only exists in `.claude/skills` still reaches Copilot.
- A hand-written hook in the same `.claude/settings.json` is dropped for
  Copilot, along with Hooknostic's entries.
- Repository hooks load only in a trusted folder, from the directory the
  session starts in. They load at startup, so restart Copilot after `sync`.
- `prompt.before.context.add` is emulated by appending to the prompt.
  Preventing a subagent stop has no observed loop guard. Compaction is a
  notice only, and there is no `model.request` or `turn.stop.notify` channel.
- Copilot expands `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` and ambient `${NAME}`
  references in MCP declarations that Agent Plugins 1.0 keeps literal. This
  is reported as the `copilot:mcp-environment-expansion` deviation (HN106),
  which warns by default.
- A git-hosted marketplace install is a copy, so a rebuilt package reaches
  Copilot only after `copilot plugin update`. No install route runs a
  dependency install, so bundle a package's Node dependencies.
- The interactive approval scenario has no automated driver on the playback
  lane. macOS evidence covers the shell dialect only.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
