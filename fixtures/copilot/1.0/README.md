# GitHub Copilot CLI 1.0.101 fixtures

Captured from a real **GitHub Copilot CLI 1.0.101** session on 2026-10-20 via
stdin-teeing command hooks, on Windows except `tool-before-bash`, which is from a
Debian container. See [`.capture/copilot/README.md`](../../../.capture/copilot/README.md)
for the procedure and the effect probes.

- `*.input.json` — native hook stdin payload, verbatim as captured.
- `*.enrichment.json` — the native event the hook entry was registered for.
  CamelCase Copilot payloads do not name their own event, so the generated entry
  passes it to the shim; the canonical fixture is not derived from this file, it
  only tells the canonical generator what the harness did.
- `*.canonical.json` — expected canonical event from `decode()` **minus `raw`**:
  tests assert `decode(input, hint) === { ...canonical, raw: input }`.
- `declined.json` — captured inputs the adapter declines, with the expected
  error.

**One redaction.** The capturing machine's Windows account name is replaced with
`user` throughout. Drive letters, backslash escaping, the container's `/work`
path, and every other path shape stay as captured, because the shape is evidence.

## Provenance

| Fixture | Source |
| --- | --- |
| session-start, session-end, prompt-before, tool-before, tool-after, permission-request, turn-stop | **captured** 1.0.101 (2026-10-20), Windows |
| session-start-pascal, tool-before-pascal, tool-before-pascal-bash, tool-before-pascal-read, tool-before-pascal-edit, tool-after-pascal, turn-stop-pascal | **captured** 1.0.101 (2026-10-20), Windows, VS Code compatible PascalCase entries beside the camelCase ones. `tool-before-pascal-bash` pins that the PascalCase `Bash` alias carries `command` and no dialect. |
| tool-before-bash | **captured** 1.0.101 (2026-10-20), Debian `node:24-bookworm` container; pins the `bash`/`posix` shape and dialect by effect (`/usr/bin/bash`) |
| tool-after-bash | **captured** 1.0.101 (2026-10-20), Debian `node:24-bookworm` container; the Linux `postToolUse` counterpart of the `bash` call, so the drift lane's Linux exchange has a fixture. |
| tool-before-create, tool-before-edit | **captured** 1.0.101 (2026-10-20) over the model provider; the tool calls were prompted, the payloads are native |
| tool-before-subagent, turn-stop-subagent | **captured** 1.0.101 (2026-10-20) during a subagent run; pin that a tool event and a turn stop fired inside a subagent carry `agentId`/`agentType`/`parentAgentId` |
| tool-before-mcp | **captured** 1.0.101 (2026-10-20) in `.capture/copilot/captured/mcp-stdio`; pins the `<server>-<tool>` name (`probe-probe_echo`) classified as `mcp` with no `tool.mcp` split |
| permission-request-mcp | **captured** 1.0.101 (2026-10-21) in a Debian container (`probe.mjs mcp-permission`); the same MCP call as `probe/probe_echo` on `permissionRequest` (its `preToolUse` was `probe-probe_echo`), classified as `mcp` with no `tool.mcp` split. Linux paths carry no account name |
| tool-error | **captured** 1.0.101 (2026-10-20): `view` on a missing path produces `postToolUseFailure` with `error: "Path does not exist"` |
| agent-start, agent-stop | **captured** 1.0.101 (2026-10-20): `task` with `agent_type: "explore"` |
| agent-start-pascal | **captured** 1.0.101 (2026-10-20) with a PascalCase `SubagentStart` entry: the payload is hybrid camel base + snake agent fields and omits `hook_event_name` |
| pre-compact | **captured** 1.0.101 (2026-10-21) in an interactive session using `/compact`; the payload carries `trigger: "manual"` and `transcriptPath` |
| user-prompt-transformed, error-occurred | **captured** 1.0.101 (2026-10-20) and **declined**: no portable event names a pre-model prompt transformation or a generic error |
| notification-shell-completed, notification-agent-idle | **captured** 1.0.101 (2026-10-21) in a Debian container and **declined**: `notification_type` `shell_completed` (a background shell finished while the agent was busy) and `agent_idle` (a background subagent). Linux paths carry no account name |

`tool.shell.dialect` is not in any payload. The decoder derives it from the
runtime tool name (ADR-0029): `powershell` ran Windows PowerShell 5.1, `bash`
ran `/usr/bin/bash`. A PascalCase `Bash` name is the Claude alias for both
runtime tools, so its shape entry carries no dialect.

The `permissionRequest` payload is the one camelCase shape with `toolInput`
instead of `toolArgs`, and it omits the shell `description` sibling.
