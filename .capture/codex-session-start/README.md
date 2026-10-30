# Codex SessionStart notice probe

Question: can a Codex SessionStart hook show the **user** a notice that the
**model** never sees? This is the Codex half of the evidence for a possible
portable `session.start.notify` capability. The Claude half is in
`.capture/claude-output` (§SessionStart output). The Stop-time counterpart on
Codex is `.capture/codex-output`, where `systemMessage` is accepted and
discarded.

This records evidence only. It adds no vocabulary, capability cell or adapter
behaviour.

**Live-probed against codex-cli 0.148.0 and 0.166.0 on Windows, 2026-10-30,
over the loopback playback model.** Both builds were scratch
`npm install --prefix` installs, and each passed `--version` before use. No model
credits were spent: the model side is observed as the requests the playback
server recorded.

## Method

```bash
HOOKNOSTIC_CODEX_BIN=<path to codex.exe> \
  node --experimental-strip-types .capture/codex-session-start/drive.mjs [--surface exec|tui|all] [variant...]
```

Each variant gets a fresh scratch project and a fresh `CODEX_HOME`. The home
holds a `config.toml` with the playback provider, a trust entry for the project
and `[windows] sandbox = "unelevated"`, so `~/.codex` is never read or written.
The project's `.codex/hooks.json` has one SessionStart hook. Its answer depends
on the variant, and every string in it carries a per-run nonce and the
payload's `source`:

| Variant | Hook stdout |
| --- | --- |
| `notify` | `{systemMessage: "HKN-NOTICE-<hex>-<source>"}` |
| `compose` | the same, plus `hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: "HKN-CONTEXT-<hex>-<source>"}` |
| `context` | `hookSpecificOutput.additionalContext` only (control) |
| `invalid` | `{hknUnknownField: …}`, which the `additionalProperties: false` schema rejects (control) |

**exec surface:** `codex exec "<prompt>"` and `codex exec resume <id> "<prompt>"`.
Each runs once with the default human-readable output and once with `--json`.
stdout and stderr are searched for both nonces.

**TUI surface:** the interactive TUI runs under node-pty, and a headless xterm
(`@xterm/headless`, scrollback included) reads the screen. One session sends a
prompt, then `/compact` and a prompt, then `/clear` and a prompt. Then
`codex resume <id>` and `codex fork <id>` each start a new process and send one
prompt. `--no-daemon` is passed where the build has it (0.166.0). The driver
types only into an idle composer and resends Enter until the playback server
sees the request. Keystrokes typed while a resumed thread was still loading, or
while compaction ran, were otherwise dropped or merged into the next command.

**Model-invisibility:** every recorded request is searched for each nonce, and
the Responses `input` item that holds it is recorded.

## Wire schema

`session-start.command.output` is identical in both binaries:
`continue`, `stopReason`, `suppressOutput`, `systemMessage`, and
`hookSpecificOutput: {hookEventName: "SessionStart", additionalContext}`, with
`additionalProperties: false`. The input `source` enum is
`startup | resume | clear | compact` on 0.148.0. 0.166.0 adds `fork`.

**`systemMessage` is accepted.** Every `notify` and `compose` run logged
`hook: SessionStart Completed` in exec and rendered no error in the TUI. The
`invalid` control shows what a rejection looks like: exec logged
`hook: SessionStart Failed`, and the TUI rendered
`hook returned invalid session start JSON output`. So "Completed" here means the
body validated.

## Results

The results are identical across both builds and all three answering variants,
except where a row says otherwise.

| Source | Surface | Notice shown to the user? | Notice reached the model? |
| --- | --- | --- | --- |
| startup | `codex exec` (human-readable) | **no**, on stdout or stderr | no |
| startup | `codex exec --json` | **no**: no event carries it, and no hook event is emitted at all | no |
| resume | `codex exec resume` (human-readable) | **no** | no |
| resume | `codex exec resume --json` | **no** | no |
| startup | TUI | **yes**, after the first prompt is submitted | no |
| compact | TUI (`/compact`, then a prompt) | **yes**, after the next prompt | no |
| clear | TUI (`/clear`, then a prompt) | **yes**, after the next prompt | no |
| resume | TUI (`codex resume <id>`) | **yes**, after the first prompt | no |
| fork | TUI (`codex fork <id>`) | **yes**, after the first prompt. 0.148.0 sends `source: "startup"`; 0.166.0 sends `"fork"` | no |

How the notice is drawn in the transcript, above the model's reply:

- 0.148.0: `• SessionStart (completed) says: HKN-NOTICE-…-startup`
- 0.166.0: `↳ Hook · HKN-NOTICE-…-startup`

### `additionalContext`

- **It reached the model on every source and surface,** as a Responses `input`
  item `{type: "message", role: "developer", content: [{type: "input_text",
  text: "HKN-CONTEXT-…"}]}` with the bare string and no prefix. On resume and
  fork the request carried the earlier run's context item as well as the new
  one.
- **0.148.0's TUI also shows it to the user**, as a second line under the
  notice (`hook context: HKN-CONTEXT-…`), in both `compose` and `context`.
  0.166.0's TUI does not show it.
- exec showed it on neither stream, in either build.

## What this establishes

- **On the interactive TUI, SessionStart `systemMessage` is a user-only notice,
  for every source Codex fires.** It rendered for startup, compact, clear,
  resume and fork, and no model request carried it, on both builds.
- **`codex exec` accepts it and discards it**, on both output modes, as Stop
  does. A headless or `--json` consumer never sees a SessionStart notice.
- **The TUI dispatches SessionStart lazily.** The hook does not run when the TUI
  opens. It runs when the session's first prompt is submitted, so the notice
  appears with the first turn and not on an idle startup screen. Every
  pre-prompt snapshot had no hook dispatch and no notice. After `/compact` and
  `/clear` the next SessionStart also waited for the next prompt. Claude, by
  contrast, renders its startup notice before any prompt.
- **On 0.148.0, context is not model-only either**: the TUI shows it to the user
  too.

## Not established

- Versions other than 0.148.0 and 0.166.0, and macOS and Linux.
- The app-server and daemon surfaces (`codex app-server`, the desktop app), and
  other clients of the shared daemon. 0.166.0 ran with `--no-daemon`.
- Auto-compaction. Only the manual `/compact` command was driven.
- Whether `suppressOutput` or `continue: false` change any of this.

The captures (`captured/<version>/<variant>/`, git-ignored) hold each run's
stdout and stderr, TUI viewport snapshots and full-buffer screens, every
playback request, and the hook's received payloads.
