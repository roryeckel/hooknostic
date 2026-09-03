# Codex shell tool argument shapes

Captured against `codex-cli` **0.151.0** on Windows, 2026-08-30.

## Why

`packages/adapter-codex/src/toolmap.ts` maps `Bash`, `exec_command` and `shell`
to `kind: "shell"`, but only `Bash` had a fixture — and `Bash` names its argument
`command`. Whether the others share that shape was unverified, while every
example in this repo, the README front page and tutorial 01 all read
`event.tool.input.command`.

That gap is not cosmetic. A portable guard written `match: { kind: "shell" }` +
`input.command` compiles clean, checks clean, matches on all three targets, and
silently permits every Codex `exec_command` call if the key differs. The first
consumer found the difference by accident, in a debug log.

## Procedure

No hook is involved — Codex's own debug channel prints the tool call with its
arguments, which avoids needing `pre_tool_use` hook trust:

```bash
RUST_LOG=codex_core=debug codex exec -m <model> -s read-only \
  "Run the shell command: echo hooknostic-capture" 2>&1 \
  | grep "ToolCall:"
```

The command being *rejected* afterwards by a sandbox does not matter — the tool
call is routed, and therefore logged, before the process is spawned. That is
what makes this capturable in a restricted environment.

## Observed

Three variants in one turn, as the model retried with different wrappers:

```
ToolCall: exec_command {"cmd":"echo hooknostic-capture","workdir":"<abs path>"}
ToolCall: exec_command {"cmd":"echo hooknostic-capture","workdir":"<abs path>","shell":"cmd"}
ToolCall: exec_command {"cmd":"echo hooknostic-capture","login":false,"workdir":"<abs path>"}
```

| Key | Type | Notes |
|---|---|---|
| `cmd` | string | The command line. **Not `command`** — this is the whole finding. |
| `workdir` | string | Absolute working directory for the call. |
| `shell` | string | Optional. Observed `"cmd"`; selects the interpreter. |
| `login` | boolean | Optional. Observed `false`. |

## Consequences recorded in the adapter

- `classifyCodexTool` extracts `shell.command` from `cmd` for `exec_command` and
  from `command` for `Bash`, so a portable hook reads one field either way.
- `shell` as a *tool name* was never observed. It stays in the classification
  map because removing a name from a security-relevant matcher on the strength
  of not having seen it is the wrong direction, but it has no fixture and its
  argument shape is unknown — so `classifyCodexTool` leaves `shell` undefined
  for it rather than guessing, and a hook must fall back to `input`.

## Write-path verification (2026-08-30, codex-cli 0.151.0)

Question: does Codex honour `hookSpecificOutput.updatedInput` from a
`PreToolUse` hook for its shell tools? Answered by swapping the trusted
`.capture/codex` project's PreToolUse entry for a hook that tees stdin and
returns `permissionDecision: "allow"` + `updatedInput` with a changed command,
then running `codex exec` with `--dangerously-bypass-hook-trust` and
`RUST_LOG=codex_core=debug`. The sandbox rejecting the spawn does not matter:
the router logs the exact command line it tried to spawn, so the rewrite is
visible either way.

Observed, same turn, same tool call:

```
router:  ToolCall: exec_command {"cmd":"echo hooknostic-original","workdir":"...","shell":"powershell"}
hook in: {"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hooknostic-original"}}
hook out: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"echo hooknostic-rewritten> ..."}}}
spawned: powershell.exe -Command "echo hooknostic-rewritten> ..."
```

Three findings:

1. **`updatedInput` is honoured** — the spawned command was the rewritten one.
   The write channel is captured provenance, not just doc-derived.
2. **The hook boundary translates.** The router's `exec_command {cmd, workdir}`
   call reaches the hook as `tool_name: "Bash"`, `tool_input: {command}` —
   Claude-compatible vocabulary. `workdir` is dropped entirely: the hook
   payload carried no working-directory key at all.
3. Repo-level `.codex/hooks.json` loads only in **trusted** projects; in an
   untrusted directory the same run executes tools with no hook fired and no
   error (verified with a scratch project first).

Consequence for the tables in this repo: `exec_command`'s `cmd`/`workdir`
shape is real at the *router*, but on 0.151.0 no hook ever receives it — the
hook-visible shell shape is `Bash`/`command`. The `exec_command` mapping stays
as defensive coverage (another version or surface may pass it through), but
its provenance is "router debug log", not "captured hook payload", and
`fixtures/codex/0.148/pre-tool-exec-command.input.json` is a constructed
payload (log-derived args in a schema-derived envelope), not a capture.

## Namespaced tool-call routing + MCP output replacement (2026-09-02, 0.151.0)

Two follow-ups captured during the loopback playback drives:

1. **The router resolves `{namespace, name}` exactly.** A scripted
   `function_call` for an MCP tool must carry `name` = the bare inner tool
   name and `namespace` = the namespace tool spec's `name` verbatim
   (`mcp__<server>`, no trailing underscores). The flattened-name form
   (`mcp__<server>__<tool>` in `name` alone) and a trailing-`__` namespace
   both fail the exact match with `unsupported call`. The earlier reading in
   this file's history — that codex's router "rejects scripted namespaced
   calls from custom providers" as an upstream limitation (#31354) — was
   wrong: the emission shape was ours to fix. The same pair emission routes
   the `multi_agent_v1` agent tools (`spawn_agent` and siblings), which the
   0.151.0 router also registers under a namespace container. `spawn_agent`
   additionally validates "Provide one of: message or items" — the task key
   is `message`.
2. **`updatedMCPToolOutput` is rejected, not honoured.** A PostToolUse hook
   returning `hookSpecificOutput.updatedMCPToolOutput` fails open: the run
   logs `hook: PostToolUse Failed`, the original output reaches the model,
   and the replacement is discarded. This matches upstream codex-rs
   `hooks/src/events/post_tool_use.rs`'s own
   `unsupported_updated_mcp_tool_output_fails_open` test and the output
   parser's `unsupported_post_tool_use_hook_specific_output` (the field is
   unconditionally reported unsupported; only `additionalContext` is read).
   `tool.after.output.replace` is therefore `unsupported` on the hook
   channel for codex — the 0.148.0-era "approximate" rating came from the
   wire schema's existence, never from a live honoured write.

Also observed on 0.151.0: `SubagentStart`/`SubagentStop` fire in the spawned
child session, which does not inherit the parent's
`--dangerously-bypass-hook-trust` (upstream openai/codex#33097) — with the
bypass flag, `collab: SpawnAgent` runs and the parent dispatches
PreToolUse/PostToolUse, but no subagent lifecycle hook ever reaches the
artifact.
