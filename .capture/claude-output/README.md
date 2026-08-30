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
