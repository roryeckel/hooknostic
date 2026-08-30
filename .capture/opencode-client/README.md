# OpenCode plugin-client capture

Provenance for the OpenCode cells of `turn.stop.prevent` and `turn.stop.notify`.

Everything in that work rests on `client.session.promptAsync`, which could not be
checked offline: `@opencode-ai/plugin` types `client` opaquely as
`ReturnType<typeof createOpencodeClient>`, `@opencode-ai/sdk` is not vendored, and
the installed CLI is a compiled Bun binary. So it was measured.

**Captured against `opencode-ai` 1.18.25 on Windows, 2026-08-29.**

## How to reproduce

`opencode run` **cannot** be used. It exits at `session.idle`, before a posted turn
can start — verified: the message lands in the session and no assistant reply ever
follows. Every run below drives a persistent `opencode serve` instead.

```bash
cd .capture/opencode-client
rm -rf captured
HOOKNOSTIC_PROBE=<variant> opencode serve --port 47331 &
HKN_PORT=47331 node drive.mjs
cat captured/posts.jsonl captured/transcript.jsonl
```

Variants: `surface` (enumerate the client, post nothing), `prevent`
(`promptAsync` without `noReply`), `notify` (`promptAsync` with `noReply: true`),
`toast` (`tui.showToast`). `captured/` is gitignored; this file is the durable
record.

## Findings

### The client surface exists

`PluginInput` carries `client, project, worktree, directory,
experimental_workspace, serverUrl, $`. On `client`:
`session.promptAsync` → `function`, `session.prompt` → `function`,
`tui.showToast` → `function`.

Note the generated hooknostic shim already receives all of this — the entry source
binds the whole `PluginInput` and passes it through; only the shim's structural
type narrows it away.

### `promptAsync` without `noReply` drives a real turn

Session transcript after the probe posted during the first `session.idle`:

| role | text |
| --- | --- |
| user | Say the single word ready, then stop. |
| assistant | ready |
| user | HKN-R-7c4f1 reply with the single word continued |
| **assistant** | **continued** |

`session.idle` fired **twice** — once per turn. This is the evidence for
`turn.stop.prevent: emulated`: no native stop veto exists, but posting the reason
back genuinely keeps the agent working.

### `noReply: true` posts without a turn — but the model still sees it

`session.idle` fired **once**; no second turn ran. The message is nonetheless
appended to the conversation **as a user-role message**:

| role | text |
| --- | --- |
| user | Say the single word ready, then stop. |
| assistant | ready |
| user | HKN-S-3ba90 |

So the user sees it without a turn being driven, but the model reads it on the next
turn. That extra observable effect is the `addContext` semantic that `notify` is
defined *not* to have, which is why the cell is **`approximate`**, not `emulated`.

`tui.showToast` exists and would be a clean user-only channel, but it renders only
under a TUI — inert under `opencode run` and `opencode serve`. Making the mechanism
depend on execution mode would be worse for a portability product than one honest
`approximate` cell.

### `session.idle` cardinality

One `session.idle` per completed turn, measured on a 1-turn run (1 idle) and a
2-turn run (2 idles). **Not yet measured:** aborted turns and compaction. This
bears on whether `turn.stop.observe` can be raised from `approximate` to
`emulated`, which is what decides whether a `turn.stop` hook can build against
OpenCode under the default compatibility policy at all.
