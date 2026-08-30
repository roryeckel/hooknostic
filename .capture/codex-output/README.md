# Codex Stop-hook output capture

Provenance for the Codex cells of `turn.stop.notify` / `agent.stop.notify`, and a
correction to how `preventStop` is understood to work.

The `stop.command.output` wire schema accepts `systemMessage`. Accepting a field
and rendering it are different things, and the 0.148.0 binary has no rendering
path for it — the string appears only in serde field tables. This settles it.

**Captured against codex-cli 0.148.0 on Windows, 2026-08-29.**

## How to reproduce

`.codex/hooks.json` needs an absolute path, so it is generated from the tracked
template and gitignored:

```bash
cd .capture/codex-output
sed "s|\${CAPTURE_DIR}|$(pwd -W)|g" .codex/hooks.json.template > .codex/hooks.json
mkdir -p captured && rm -f captured/Stop.jsonl
HOOKNOSTIC_PROBE=<variant> codex exec --model gpt-5.3-codex-spark \
  --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox \
  "Say the single word ready, then stop."
```

**Discriminator for "was the stop prevented":** count records in
`captured/Stop.jsonl` — two, the second with `stop_hook_active: true`, means
prevented.

Note `--json` is **not** usable for observing hook feedback: neither a block
reason nor a `systemMessage` appears anywhere in the JSONL event stream. Use the
default human-readable output.

## Results

| Variant | Emitted | Stop dispatches | Prevented? | Rendered? |
| --- | --- | --- | --- | --- |
| `A-exit2` | exit 2 + stderr | 1 | **no** | — |
| `B-json-block` | exit 0, `{decision:"block",reason}` | 2 | **yes** | — |
| `D-notify` | exit 0, `{systemMessage}` | 1 | no (correct) | **no** |
| `E-compose` | exit 0, `decision`+`reason`+`systemMessage` | 2 | **yes** | notice not rendered |

### `systemMessage` is accepted and discarded

The `D-notify` run completed cleanly — Codex logged `hook: Stop Completed`, so the
response validated against the `additionalProperties: false` wire schema. The
message itself appears **nowhere** in the output.

So `turn.stop.notify` and `agent.stop.notify` on Codex are **unsupported**.
Accepted-but-discarded is not support, and claiming it would mean a portable hook
silently loses its notices on one target — the exact failure this capability was
added to prevent.

This is the one place the three harnesses genuinely diverge, and it is why the
capability model is event-scoped and per-adapter rather than assumed from a shared
wire format.

### Exit 2 does **not** prevent a stop on Codex

`A-exit2` wrote a continuation prompt to stderr and exited 2 — the shape the
binary's own error string (`"Stop hook exited with code 2 but did not write a
continuation prompt to stderr"`) implies should work. The turn ended anyway: one
dispatch, no `stop_hook_active` follow-up.

`B-json-block` prevented it. The JSON body is the only mechanism that works here,
which is what the adapter already emits — so this changes nothing in the code, but
it does mean Claude and Codex are **not** interchangeable on this point. Claude
honours both encodings; Codex honours only JSON.
