# Claude Code Stop-hook output capture

Provenance for the Claude cells of `turn.stop.notify` / `agent.stop.notify`, and
for moving `preventStop` off exit 2.

`.capture/claude/` tees hook **stdin**, which answers what Claude sends. This
answers the opposite question — which *responses* Claude honours — by emitting one
candidate per run and observing what came back.

**Captured against Claude Code 2.1.250 on Windows, 2026-08-29.**

## How to reproduce

```bash
cd .capture/claude-output
mkdir -p captured && rm -f captured/Stop.jsonl
CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=2 HOOKNOSTIC_PROBE=<variant> \
  claude -p "Say the single word ready. Then stop." \
    --model sonnet --output-format stream-json --verbose \
    --dangerously-skip-permissions --max-turns 4 > captured/stream-<variant>.jsonl
```

`captured/` is gitignored; this file is the durable record.

**Discriminator for "was the stop prevented":** count records in
`captured/Stop.jsonl`. Two records, the second with `stop_hook_active: true`,
means prevented. One record means not prevented. This is exact and needs no UI.

`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (default 8) is a hard vendor-side circuit
breaker on consecutive blocks. Set it to 2 so a misbehaving candidate cannot run
away.

## Results

| Variant | Emitted | Stop dispatches | Prevented? | Where the text surfaced |
| --- | --- | --- | --- | --- |
| `A-exit2` | exit 2 + stderr | 2 | **yes** | model-visible (control) |
| `B-json-block` | exit 0, `{decision:"block",reason}` | 2 | **yes** | model-visible |
| `C-json-deny` | exit 0, `{decision:"deny",reason}` | 1 | no — rejected | nowhere |
| `D-notify` | exit 0, `{systemMessage}` | 1 | no (correct) | system notice only |
| `E-compose` | exit 0, `decision`+`reason`+`systemMessage` | 2 | **yes** | both, separately |
| `F-hso` | exit 0, `hookSpecificOutput.additionalContext` | 2 | **yes** | not observed in stream |
| `G-stdout` | exit 0, plain stdout | 1 | no | **discarded** |

### Exit-0 JSON prevents a stop, exactly like exit 2

`B` matched the `A` control. Both emit a `stop-hook-error` system notification —
that is simply how Claude reports "a hook blocked the turn", not a defect, and the
control emits it too.

This is what lets `preventStop` move from `{exitCode: 2, stderr}` to an exit-0 JSON
body, which is the only encoding that can also carry a notice.

### `systemMessage` is exactly the `notify` semantic

`D` surfaced as, verbatim:

```json
{"type":"system","subtype":"informational","content":"Stop says: HKN-S-3ba90","level":"notice"}
```

A system notice — not an assistant message, not a synthetic user message. The
model never sees it, and the turn is not affected. `turn.stop.notify` on Claude is
therefore **`exact`**.

### Both stop events behave identically

The table above is the `Stop` run. `SubagentStop` was driven separately, with a
prompt forcing one Task-tool subagent, and matched on every point: `D-notify`
surfaced the same `{"type":"system","subtype":"informational"}` notice, and
`E-compose` produced **two** `SubagentStop` dispatches with `stop_hook_active:
true` on the second — so exit-0 JSON prevents a subagent stop exactly as it
prevents a turn stop. Both `agent.stop` cells rest on that run, not on
extrapolation from `Stop`.

### They compose in one body

`E` produced both, from a single response:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text",
  "text":"Stop hook feedback:\nHKN-R-7c4f1 keep working"}]},"isSynthetic":true}
{"type":"system","subtype":"informational","content":"Stop says: HKN-S-3ba90"}
```

The block reason reaches the model as synthetic user feedback; the notice reaches
only the user. This is the composition the whole change depends on, and it works.

### Corrections to `docs/baseline-2026-08-20.md`

- **`:74-75` is wrong.** It says stop-family events take `decision: "allow"|"deny"`.
  `C` was rejected outright and did not prevent the stop. The binary's enum is
  `["approve","block"]`; `"block"` is what works, matching Codex.
- **`:86-87` does not extend to `Stop`.** Plain exit-0 stdout becomes context on
  `SessionStart` / `UserPromptSubmit`, but `G` shows it is discarded on `Stop` —
  not shown, not context, not blocking.

### Out of scope, but observed

`F` **prevented the stop**. Claude has a `StopHookSpecificOutput` variant carrying
`additionalContext`, whose own schema description says the conversation continues
so the model can act on it. hooknostic has no `turn.stop.context.add` capability,
so this is currently unreachable through the portable API — a real gap worth
filing separately.

## SessionStart output

Provenance for a possible `session.start.notify` cell, beside the existing
`session.start.context.add`.

**Live-probed against Claude Code 2.1.296 on Windows, 2026-10-12, and
re-run unchanged against 2.1.312 on 2026-10-29, over the loopback playback
model.** Both builds gave the results below. The interactive TUI was driven
through every source against 2.1.312 and the reference build 2.1.238 on
Windows, 2026-10-30 (the TUI table below). No model credits; the model side is
observed as the requests the playback server recorded. Each run uses its own
`CLAUDE_CONFIG_DIR`, so the account's settings and installed plugins (and
their SessionStart hooks) cannot reach the probe session.

```bash
node --experimental-strip-types .capture/claude-output/session-start.mjs       # headless, three variants
node --experimental-strip-types .capture/claude-output/session-start-pty.mjs   # interactive TUI, every source, three variants
```

Set `HOOKNOSTIC_CLAUDE_BIN` to pick the build `session-start-pty.mjs` drives.

A second SessionStart hook beside the stdin tee answers with a body whose
strings carry a per-run nonce and the payload's `source`, so a match names the
field and the start reason. `session-start.mjs` runs each variant three times
in one project: a fresh start, `--resume <id>`, and `/compact` on the resumed
session. `session-start-pty.mjs` starts the interactive TUI under node-pty and
walks the first-run dialogs (a reduced copy of the playback suite's walk). One
process then runs startup, a prompt, `/clear`, three prompts, `/compact`, a
prompt, `/resume` (taking the picker's preselected entry, the startup
session), and a prompt. A second process starts with `--resume <startup id>`
and sends a prompt. Each step waits until the hook logs the source the step
should produce, then searches only the screen output rendered since the step
began. The prompts make model requests, so after each source the context is
observed reaching the model and the notice is observed not reaching it. The
playback model answers every request, the `/compact` summary included, with
`ready`. 2.1.238 refused `/compact` after a single exchange ("Not enough
messages to compact."), which is why the script sends three prompts before it.

The `/compact` run fires SessionStart twice: `resume` when the session loads,
then `compact`.

### Results

| Variant | Emitted | Reached a model request | Headless stream (`-p --output-format stream-json --verbose`) |
| --- | --- | --- | --- |
| `notify` | `{systemMessage}` | never | `system/informational` "SessionStart:compact says: …" for source `compact` only |
| `compose` | `systemMessage` + `hookSpecificOutput.additionalContext` | context: yes, for `startup`, `resume`, `compact`; notice: never | the same notice, `compact` only |
| `context` | `hookSpecificOutput.additionalContext` | yes, for all three | no notice |

Every run also streams a `system/hook_response` record carrying the hook's raw
stdout. That is verbose tracing of every hook, not a notice, and is not counted
above.

**Interactive TUI.** Each cell below is the same on both builds and for both
the `notify` and `compose` variants. A notice that is "shown" rendered as
`⎿  SessionStart:<source> says: HKN-NOTICE-…-<source>`, beneath the command or
the input line.

| Source (how driven) | Notice shown | Notice in a model request | Context in the next model request (`compose`, `context`) |
| --- | --- | --- | --- |
| `startup` (launch) | yes | never | yes |
| `clear` (`/clear`) | yes | never | yes |
| `compact` (`/compact`) | yes, after `Compacted` | never, including the compaction request | yes |
| `resume` (`/resume`) | yes | never | yes, with the resumed session's `startup` context |
| `resume` (`--resume <id>`) | yes | never | yes, with the resumed session's `startup` context |

The `context` variant showed nothing on screen for any source, and the context
string never appeared on screen in any variant. In the `notify` variant no
request carried either string. Across the six runs (two builds, three
variants), no recorded request carried a notice string.

Earlier notices are redrawn. The TUI stores each notice in the session
transcript as an `attachment` record of type `hook_system_message`, beside the
`hook_success` record. When a session is resumed, the earlier notices are
redrawn with the restored history: `--resume` showed the old `startup` notice
above the new `resume` one. Screen repaints after `/compact` and `/resume` also
redrew notices from earlier in the current process. Redraws are history, not
new deliveries: the notice for a source never appeared before its hook ran.

### What this establishes

- **`systemMessage` on SessionStart is a user-only notice.** It reached no model
  request in any run, headless or interactive. The interactive TUI showed it
  for every source: `startup`, `clear`, `compact`, and `resume` both through
  `/resume` and `--resume`. That is the `notify` semantic the Stop family has
  (above).
- **Headless delivery differs by source.** In `-p` mode the notice was streamed
  for `compact` and not for `startup` or `resume`. In the recorded streams the
  `startup` and `resume` hooks finished before the `init` record, while the
  `compact` notice followed it. An SDK or `-p` consumer does not see a startup
  notice.
- **`additionalContext` reached the model for every source**: the three
  headless ones, and `clear` in the TUI. It arrived as a system-level message
  beginning `SessionStart hook additional context:`. On resume, the request
  carried the earlier run's context as well as the new one.
- **The difference is the surface, not the source.** The interactive TUI
  shows the notice for every source. Headless `-p` streams it only for
  `compact`.

### Not established

- Interactive builds other than 2.1.238 and 2.1.312. Headless builds other
  than 2.1.296 and 2.1.312.
- macOS and Linux. Linux was reachable from the capturing host through WSL
  (Ubuntu) and Docker, but driving it needs a Linux Claude install and a Linux
  node-pty build. That setup was not built for this probe.
- Auto-compaction. Only `/compact` was driven.
- IDE and other non-terminal front ends.
