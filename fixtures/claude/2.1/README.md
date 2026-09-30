# Claude Code 2.1 fixtures

Captured from a real **Claude Code 2.1.238** session on Windows (2026-08-20) via
stdin-teeing command hooks (`.capture/claude`), except where noted.

- `*.input.json` — native hook stdin payload, verbatim as captured.
- `*.canonical.json` — expected canonical event from `decode()`, **minus `raw`**:
  tests assert `decode(input) === { ...canonical, raw: input }`.
- `*.output.json` — expected native result from `apply()` for a given canonical
  HookResult (the driving HookResult lives in the adapter's apply tests).

**One redaction.** The capturing machine's Windows account name is replaced with
`user` throughout — in `cwd`, in `transcript_path`, and in the mangled
`C--Users-user-…` project directory derived from it. Nothing else was altered:
these stay Windows paths with their real drive letter, backslash escaping, and
structure, because that shape is itself evidence about what the harness sends.

Provenance notes:

| Fixture | Source |
| --- | --- |
| session-start, session-end, prompt-submit, pre-tool-bash, pre-tool-read, post-tool-bash, post-tool-failure, subagent-start, subagent-stop, stop | **captured** 2.1.238 |
| pre-tool-powershell | **captured** 2.1.250 (2026-08-30) -- pins that `PowerShell` shares `Bash`'s `command` key, which until then rested on inference |
| pre-tool-write, pre-tool-edit, pre-tool-notebookedit | **captured** 2.1.283 (2026-09-27) over the loopback playback model (`.capture/file-tools`): the hook payloads are native, the argument *values* are scripted. Pins the path keys (`file_path`; `notebook_path` for NotebookEdit). The harness itself adds `replace_all: false` to Edit input. MultiEdit was not advertised on 2.1.283 and stays uncaptured. |
| pre-tool-read-subagent, post-tool-read-subagent | **captured** 2.1.283 (2026-09-29) over the loopback playback model (`.capture/agents`, `direct` case, `promote.mjs`): a `Read` made inside a delegated project subagent. The payloads carry `agent_id` and `agent_type` (the subagent's name); the parent's own tool payloads in the same session carry neither. The delegation and the read's argument values are scripted. The additive `effort` object is the capturing session's own setting. |
| pre-tool-read-primary-agent, session-start-primary-agent | **captured** 2.1.283 (2026-09-29) over the loopback playback model (`.capture/agents`, `primary-flag` case, `promote.mjs`): a session started with `--agent hn-probe`, and its `Read`. Every event of such a session carries `agent_type` (the agent's name) and none carries `agent_id`, which a subagent's events do. The prompt and the read's argument values are scripted. The additive `effort` object is the capturing session's own setting. |
| pre-tool-approval.output.json | constructed expected output; `ask` schema-derived from the 2.1.263 binary and verified in the Windows PTY live probe (2026-09-07), see `.capture/harness-playback/README.md` |
| permission-request | doc-derived (R2, fetched 2026-08-20) — PermissionRequest hooks do not fire in headless `-p` capture |
| pre-compact, post-compact | doc-derived (R2) — compaction is impractical to trigger in a short headless session |

Field-name ground truth established by capture (differs from some doc phrasing):
`UserPromptSubmit.prompt` (not `user_prompt`), `SessionStart.source`,
`SessionEnd.reason`, `PostToolUseFailure.error` / `is_interrupt`, `Stop`
carries additive `background_tasks` / `session_crons` arrays.
