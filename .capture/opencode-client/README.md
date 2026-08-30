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
`turn.stop.prevent`: no native stop veto exists, but posting the reason back
genuinely keeps the agent working.

The cell is **`approximate`**, not `emulated`, because that only holds in a
session that outlives the event. Under `opencode run` the process exits at
`session.idle` before the posted turn can start — measured: the message lands in
the session and no assistant reply ever follows. Behaviour that depends on how
the harness was launched is a material semantic difference, not merely a
different mechanism. It also keeps the cell from being rated *above*
`turn.stop.notify`, which still lands its message under `opencode run`.

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

### `session.idle` cardinality — why `turn.stop.observe` stays `approximate`

On a normally-completed turn it is exactly one per turn: 1 idle on a 1-turn run,
2 on a 2-turn run.

**On an aborted turn it fires twice.** A single `POST /session/{id}/abort` on a
busy session produced, back to back:

```
201  session.status  {"status":{"type":"idle"}}
202  session.idle
205  message.updated
206  session.status  {"status":{"type":"idle"}}
207  session.idle
```

So one turn ending yields two `turn.stop` dispatches. That is a material
divergence from "the turn stopped", not merely a different mechanism, so
`turn.stop.observe` must stay **`approximate`** — raising it to `emulated` would
be overclaiming.

The consequence is load-bearing for consumers. `DEFAULT_COMPATIBILITY` is
`minimum: "emulated"` with `onBelowMinimum: "error"`, and the compiler checks the
*implicit* `turn.stop.observe` before it considers any declared capability. So
**any `turn.stop` hook fails the OpenCode build under the default policy**, and a
consumer that wants one must opt in with `compatibility: { minimum: "approximate" }`
on the OpenCode target. That is true today and is not changed by adding `notify`
or by making `turn.stop.prevent` supported.

A second consequence for hook authors: because a single turn can dispatch
`turn.stop` twice, a hook that posts on every dispatch will post twice. Hooks that
prevent a stop need their own terminating condition regardless — OpenCode has no
`stop_hook_active` equivalent and no block cap.
