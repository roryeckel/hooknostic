# GitHub Copilot CLI baseline — 2026-10-20

Primary-source snapshot for `@hooknostic/adapter-copilot`, captured against
**GitHub Copilot CLI 1.0.101**. The [capture record](../.capture/copilot/README.md)
holds the procedure, raw observations, and effect probes; the adapter profile
and [fixtures](../fixtures/copilot/1.0/README.md) hold the normative per-claim
ratings. This page is the dated native-surface summary in the shape of
[the 2026-08-20 baseline](baseline-2026-08-20.md).

## Installation and identity

- npm package `@github/copilot`; `copilot --version` prints
  `GitHub Copilot CLI 1.0.101.`
- The npm package is a launcher for a per-platform native binary
  (`@github/copilot-<platform>-<arch>`). No package bootstrap is needed; install
  with `--ignore-scripts`.

## Process model

Command hooks: JSON on **stdin**, a subprocess, one JSON object on **stdout**
and an exit code. Entries support `exec` + `args` (no shell; Copilot CLI only),
`bash`, `powershell`, or a cross-platform `command`; `cwd`, `env`, `timeoutSec`
(default 30, `timeout` alias), and an optional `type: "command"`.

Configuration: `{ "version": 1, "hooks": { "<event>": [entries] } }`.
Hook files load at CLI start.

## Discovery and trust

| Question | Observation |
| --- | --- |
| Repository hooks | `.github/hooks/*.json`, loaded from the **session's working directory**, not the git root. A session started in `nested/` loaded only `nested/.github/hooks`; a linked worktree loaded the worktree's own file. |
| Trust | Repository hooks run only in a trusted folder (`--trust-folder`, or `COPILOT_ALLOW_ALL=true`). Without it they are skipped silently. |
| User hooks | `$COPILOT_HOME/hooks/*.json` (default `~/.copilot/hooks/`). |
| Inline hooks | A `hooks` field in `.github/copilot/settings.json`, `settings.local.json`, `.claude/settings.json`, or the user `settings.json`. |
| Plugin hooks | A legacy plugin's `hooks.json` or an Agent Plugins package's `com.github.copilot/hooks/hooks.json`; both fire on 1.0.101. |
| Policy hooks | Machine-wide files under the platform policy directory / registry; not emitted by Hooknostic. |

## Events and payloads

Two configuration spellings select two payload shapes. Both can be configured
for one event and both fire.

- **camelCase** (`sessionStart`, `preToolUse`, …): `sessionId`, `timestamp`
  (epoch ms), `cwd`, `toolName`, `toolArgs`.
- **VS Code compatible / PascalCase** (`SessionStart`, `PreToolUse`, …):
  `hook_event_name`, `session_id`, `timestamp` (ISO), `cwd`, `tool_name`,
  `tool_input`.
- CamelCase payloads carry **no event name**. `permissionRequest` is the
  exception with `hookName: "permissionRequest"`; `notification` carries
  `hook_event_name: "Notification"`.
- `permissionRequest` uses `toolInput` (not `toolArgs`) and may omit the shell
  `description` sibling.
- PascalCase `SubagentStart` is a hybrid: camelCase base fields
  (`sessionId`, `transcriptPath`) beside snake_case agent fields
  (`agent_id`, `agent_type`, `parent_agent_id`), with no `hook_event_name`.
- PascalCase `tool_name` reports the Claude alias: runtime `bash` and
  `powershell` both arrive as `Bash`; `view`/`create`/`edit` as
  `Read`/`Write`/`Edit`, with the runtime input keys unchanged.
- Events fired inside a subagent add `agentId`, `agentType`,
  `parentAgentId` (camel) / `agent_id`, `agent_type`, `parent_agent_id`.
  A subagent's `sessionId` equals its `agentId`.
- No payload carries a turn id or a tool-call id.

| Native event | Canonical | Notes |
| --- | --- | --- |
| `sessionStart` / `SessionStart` | `session.start` | `source: startup\|resume\|new`; optional `initialPrompt`; `additionalContext` output |
| `sessionEnd` / `SessionEnd` | `session.end` | `reason: complete\|error\|abort\|timeout\|user_exit` |
| `userPromptSubmitted` / `UserPromptSubmit` | `prompt.before` | command-hook output is dropped |
| `userPromptTransformed` | — | transforms model-facing prompt content; no portable event |
| `preToolUse` / `PreToolUse` | `tool.before` | `permissionDecision`, `permissionDecisionReason`, `modifiedArgs`, `additionalContext` |
| `permissionRequest` / `PermissionRequest` | `permission.request` | `behavior`, `message`, `interrupt`; fires in `-p` too |
| `postToolUse` / `PostToolUse` | `tool.after` | `modifiedResult`, `additionalContext` |
| `postToolUseFailure` / `PostToolUseFailure` | `tool.error` | `error` string; `additionalContext` |
| `preCompact` / `PreCompact` | `context.compact.before` | not captured; not advertised |
| `agentStop` / `Stop` | `turn.stop` | `transcriptPath`, `stopReason`, `stop_hook_active`; `decision`/`reason` |
| `subagentStart` / `SubagentStart` | `agent.start` | `agentName`, `agentId`, `agentType`, `parentAgentId` |
| `subagentStop` / `SubagentStop` | `agent.stop` | adds `response` / `last_assistant_message`; `decision`/`reason` |
| `errorOccurred` / `ErrorOccurred` | — | generic error context, no tool invocation |
| `notification` | — | async shell/agent/permission notices |

## Exit codes and failure behavior

- `0`: stdout is parsed as one JSON document (after progress lines are
  stripped).
- `2`: `preToolUse` and `permissionRequest` deny; other events treat it as a
  warning and keep running. `postToolUseFailure` documents stdout as
  `additionalContext`, but on 1.0.101 plain stdout was dropped; the JSON field
  is what reaches the model.
- Any other non-zero exit: ordinary events fail open; `preToolUse` is
  **fail-closed** and denies the call.
- Timeouts are fail-open for every event, including `preToolUse` and policy
  hooks.

## Tools

| Tool | Input | Kind |
| --- | --- | --- |
| `bash` (Linux/macOS) | `{command, description}` | shell, posix |
| `powershell` (Windows) | `{command, description}` | shell, powershell |
| `view` | `{path, view_range?, forceReadLargeFiles?}` | file.read |
| `create` | `{path, file_text}` | file.write |
| `edit` | `{path, old_str, new_str}` | file.edit |
| `grep` | `{pattern, paths?, output_mode?, …}` | file.read, no file view |
| `glob` | `{pattern, paths?}` | file.read, no file view |
| `web_fetch` | `{url, …}` | web.fetch |
| `web_search` | `{query}` | web.search |
| `task` | `{name, prompt, agent_type, description, …}` | agent |
| `skill` | `{skill}` | other |
| `list_powershell`, `read_powershell`, `stop_powershell`, `run_dynamic_workflow`, `sql`, … | background/workflow controls | other |

Shell dialects were observed by effect: the Windows `powershell` tool ran
Windows PowerShell 5.1 and was the only shell tool advertised there; the Linux
`bash` tool ran `/usr/bin/bash`. The PascalCase `Bash` name aliases both runtime
tools, so it establishes no family. macOS was not captured.

MCP tools arrive as `<server>-<tool>` (`probe-probe_echo`) on tool events and
`<server>/<tool>` on `permissionRequest`. Both segments may contain a hyphen
and no payload states the split, so Hooknostic classifies the call as `mcp` from
the separator when the name is not a native tool, and never sets `tool.mcp`
(ADR-0032).

## Skills

- Project discovery: `.github/skills`, `.agents/skills`, `.claude/skills`;
  personal: `~/.copilot/skills`, `~/.agents/skills`.
- A loaded skill's context is prefixed with
  `Base directory for this skill: <absolute path>`. The body is shown as
  written: `${SKILL_DIR}`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` and
  `$CLAUDE_SESSION_ID` are not expanded.
- `disable-model-invocation: true` withholds a skill from automatic selection.
  Interactively, `/skill` injects the gated body; a package skill uses
  `/<plugin-name>:<skill>`. `-p` has no slash path: a prompt naming the skill
  reaches the model-facing `skill` tool, which excludes gated skills and
  returns "Skill not found", so a headless session can only read the file
  directly. An explicit `disable-model-invocation: false` control stays in the
  tool's available list.

## MCP

- Project: `.mcp.json` (or `.github/mcp.json`) with `mcpServers`; stdio,
  `type: "http"` (Streamable HTTP) and `type: "sse"` all work. `cwd`, `env` and
  relative `args` resolve from the project root. Ambient `${NAME}` expands in
  args/env/headers; `${PLUGIN_ROOT}` stays literal.
- Plugin (Agent Plugins 1.0): `mcp.json` at the plugin root. `${PLUGIN_ROOT}`
  and `${PLUGIN_DATA}` expand in `command`, `args`, `env` and `cwd`;
  `PLUGIN_DATA` is a persistent directory under
  `$COPILOT_HOME/plugin-data/_direct/<hash>`. Ambient variables also expand,
  including in remote headers, where Agent Plugins 1.0 forbids all expansion.
- Plugin roots also receive `PLUGIN_ROOT` and `PLUGIN_DATA` in the subprocess
  environment.

## Plugins

- Agent Plugins 1.0 is native: canonical `$schema` in `plugin.json`, `skills/`,
  `mcp.json`, and client components under `com.github.copilot/` (including
  `hooks/hooks.json`).
- Legacy plugins still load (`plugin.json`, `hooks.json`, `.mcp.json`).
- `--plugin-dir <dir>` loads a plugin live. A local marketplace install
  (`copilot plugin marketplace add <path>`; `copilot plugin install`) also loads
  it live: nothing is copied, and a `package.json` + lockfile produced no
  `node_modules`.
- `${PLUGIN_ROOT}/script.mjs` in a plugin hook's `exec` args expands; a relative
  `script.mjs` also runs, so a plugin hook's cwd is the plugin root.

## Sources

Fetched 2026-10-20:

- Hooks reference — https://docs.github.com/en/copilot/reference/hooks-reference
- Using hooks — https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks
- Plugins — https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins
- Plugin reference — https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference
- Agent skills — https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
- Adding MCP servers — https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- Agent Plugins 1.0 — https://agent-plugins.org/specification
- `copilot --help`, `copilot help config`, `copilot help environment`,
  `copilot help providers`, and the subcommand help on 1.0.101
