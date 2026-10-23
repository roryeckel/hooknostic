# pi 1.3 fixtures

Captured from live pi (`@earendil-works/pi-coding-agent` 1.3.0) sessions on
Windows, 2026-10-19, against the scripted loopback model, except the MCP
payloads, captured on Linux, 2026-10-20 (below). No model provider was
contacted. The tee extension and the drivers are in `.capture/pi/`:
`probe-sessions.mjs` (lifecycle, shells, error, compaction, continuation),
`probe-features.mjs` (file tools, configured shell, final message), and
`probe-completion.mjs` (completion edges). `promote-sessions.mjs` and
`promote-features.mjs` curate them here, and `make-canonical.mjs` writes the
canonicals. The scripted loopback replies and tool arguments are constructed
inputs; every payload below is pi's own.

Canonical files are the decode result **minus `raw`**. Every input has one
except the captures the adapter declines, which `declined.json` names with the
reason and the decline message each must still produce. Generation fails if
any other input stops decoding, and removes a canonical left beside a
declined input or left without one. Output files are the adapter's expected native application of
effects; they are unchanged from `fixtures/pi/0.84`, and Pi playback verified
each effect by effect on 1.3.0.
The account name is redacted to `user` in all path forms. The temporary
project directories (`hkn-pi-sessions-*`, `hkn-pi-features-*`,
`hkn-pi-completion-*`) are volatile.

The input shape is the shim invocation `{event, ctx: {cwd, mode}}`, as for 0.84.

## Changes from 0.84.4

Each change below is additive, except the custom-message run:

- `before_agent_start` carries `messageType` (`"user"` for a submitted prompt)
  and new `systemPromptOptions` keys (`hiddenTools`, `toolGuidelines`,
  `appendSystemPrompt`, `sections`).
- **A run started by a custom message also fires `before_agent_start`**, with
  `messageType: "custom"`, the `message`, and no `prompt` (pi 1.2.0). The
  continuation that `turn.stop` prevent posts is such a run; 0.84.4 fired no
  event for it. The adapter declines it rather than mapping it to `prompt.before`.
- `tool_result` carries `structuredContent` (`{output, truncated, exit_code,
  wall_time_seconds}` for shells, a string for `read`). The failed bash result
  carries no `details`.
- `agent_settled` carries `aborted`.
- `session_compact`'s `compactionEntry` carries `systemMessage`.

## Provenance table

| Case | Class | Notes |
|---|---|---|
| `session-start`, `session-shutdown` | captured | `basic` session; reasons `"startup"`, `"quit"` |
| `before-agent-start-isolated` | captured | `basic` session: fresh project and agent home, `--no-skills`, no context file; `messageType: "user"` |
| `before-agent-start` | captured | `populated` session: a project `AGENTS.md` and a `.pi/skills` skill populate `contextFiles` and `skills`. Unlike the 0.84 fixture, no third-party extensions were installed, so no `mcp`/`subagent` tool snippets |
| `before-agent-start-custom` | captured | `continuation` session: the tee's `prevent-stop` probe called `sendMessage({triggerTurn: true})` from `agent_settled`; the second `before_agent_start` carries `messageType: "custom"` and no `prompt`. No canonical: the adapter declines it |
| `context` | captured | `basic` session, first model request |
| `tool-call-bash`, `tool-result-bash` | captured | `basic` session; **bash `{command}`**, the ShellShapes evidence |
| `tool-call-powershell`, `tool-result-powershell` | captured | `powershell` session, `--tools powershell`; **powershell `{command}`** |
| `tool-call-bash-configured-powershell`, `tool-result-bash-configured-powershell` | captured | feature probe; unchanged bash `{command}` while `shellPath` selects PowerShell |
| `tool-call-read`, `tool-result-read` | captured | feature probe; `read` `{path}` |
| `tool-call-write`, `tool-result-write` | captured | feature probe; `write` `{path, content}` |
| `tool-call-edit`, `tool-result-edit` | captured | feature probe; `edit` `{path, edits}` |
| `tool-result-error` | captured | `populated` session; `exit 7`, `isError: true` |
| `agent-settled` | captured | `basic` session; `aborted: false` |
| `agent-settled-with-message` | captured | feature probe; native envelope plus `.enrichment.json` holding `ctx.sessionManager.getBranch()` |
| `agent-settled-error`, `agent-settled-aborted`, `agent-settled-retry-aborted` | captured | Windows RPC completion probe: HTTP failure, in-flight cancellation (`aborted: true`), and retry-backoff cancellation. Enrichment holds the last three native message entries |
| `agent-settled-retry`, `agent-settled-resumed` | captured | Same probe: a successful native retry, and a reply after reopening the persisted session in another process |
| `session-before-compact`, `session-compact` | captured | `compact-run` session: an RPC `compact` command with `compaction.keepRecentTokens: 1` after one tool exchange; reason `"manual"` (the 0.84 pair was an overflow compaction) |
| `session-compact-failed` | captured | `compact-cancel` session: `{cancel: true}` from `session_before_compact`; `aborted: true`, no `session_compact` |
| `tool-call-mcp`, `tool-result-mcp` | captured | [pi native MCP](../../../.capture/pi-mcp/README.md) `extension-direct` case: a server registered with `exposure: "direct"`, called directly as `mcp__probe__probe_echo`; the result carries `details: {server, tool}` |
| `tool-result-mcp-error`, `tool-result-mcp-rpc-error` | captured | `extension-tool-error` case: a server's error result (`isError: true`) still carries `details: {server, tool}`; a JSON-RPC error arrives with `isError: true` and `details: {}` |
| `tool-call-codemode`, `tool-call-mcp-nested`, `tool-result-mcp-nested` | captured | `codemode-nested` case, default exposure: the `codemode` call with its `{code}`, and the script's MCP call as a nested call with `toolCallId` `<parent>/1` and `parentToolCallId` |
| `tool-result-mcp-extension` | captured | `extension-mcp-name` case: another extension's `pi.registerTool` tool, `mcp__fake__echo`, whose result carries the `details: {server: "fake", tool: "echo"}` that extension returned. No split: its source is not pi's MCP extension |
| `tool-result-mcp-shadow` | captured | `extension-mcp-shadow` case: another extension's tool registered under the native `mcp__probe__probe_echo`, which ran in its place with `details: {server: "shadow", tool: "echo"}`. No split, as above |

The MCP rows were captured on Linux, 2026-10-20, by `.capture/pi-mcp/probe.mjs`,
and promoted by `promote.mjs`. They are identical to the Windows captures of
2026-10-19 apart from `ctx.cwd`. Each `tool-result-mcp*` input has an
`.enrichment.json` from the same session: the `sourceInfo` that
`pi.getAllTools()` reported for its tool, which the generated extension reads
beside the callback. Their temporary `hkn-pi-mcp-*` directories are volatile.

## Not captured (declined, not defaulted)

- Nested calls made through `ctx.executeTool()` rather than codemode.
- `grep`, `find`, and `ls` payloads are in the feature-probe evidence but, as
  for 0.84, are not single-file views.
- `context_with_system`, `agent_before_settle`, `mcp_servers_change`,
  `provider_stream_event`, and the other unmapped events.
