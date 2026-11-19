# Testing your hooks

`hooknostic dispatch` runs portable events through your hooks as one configured
target and prints what they decided: the effects, and the native reply that
target's harness would receive. Your tests describe events in the portable
vocabulary you author hooks against. They never write a harness's wire format,
and they need no stand-in for OpenCode's client. The reasoning is recorded in
[ADR-0023](decisions/0023-dispatch-portable-events.md).

## A first run

Using [`examples/basic`](../examples/basic/), whose hook blocks `git push --force`:

```jsonl
{"event":"tool.before","session":{"id":"s1"},"tool":{"nativeName":"Bash","input":{"command":"git push --force origin main"}}}
{"event":"tool.before","session":{"id":"s1"},"tool":{"nativeName":"Bash","input":{"command":"git status"}}}
```

```sh
npx hooknostic dispatch --config examples/basic/hooknostic.config.ts --target claude --events events.jsonl
```

```jsonl
{"schemaVersion":1,"event":"tool.before","effects":[{"hookId":"no-force-push","effect":{"kind":"block","reason":"Use --force-with-lease instead of --force."}}],"errors":[],"terminatedBy":"no-force-push","target":"claude","native":{"exitCode":0,"body":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Use --force-with-lease instead of --force."}}}}
{"schemaVersion":1,"event":"tool.before","effects":[],"errors":[],"target":"claude","native":{"exitCode":0}}
```

Without `--events`, events are read from stdin. Each input line is one event,
and each output line answers the input line with the same number.

## Events

An event is a JSON object in the shape your hooks receive, with the envelope
filled in for you:

| Field | Default |
| --- | --- |
| `event` | Required: the portable event name. |
| `session` | `{ "cwd": <the CLI's working directory> }`. Add `id` when a hook reads it. |
| `correlation` | `{}` |
| `raw` | `null`. Supply one if a hook reads the native payload. |
| `harness` | `id` is always the target's adapter. `nativeEvent` is `"hooknostic.dispatch"` unless you name one. |
| `schemaVersion` | `1` |

Each event's own fields are checked against its type in the SDK. A required one
must be there: `prompt.before` needs a string `prompt`, `tool.error` an `error`
object, and `agent.start` and `agent.stop` an `agent` object. An optional one,
such as `lastMessage`, must have the declared type when present, and an optional
field the target's decoder never produces is refused: a `turn.stop` with
`correlation.parentAgentId`, say, which no adapter sets (ADR-0027). A field the
target derives rather than receives, such as OpenCode's `lastMessage`, is accepted. A field the
event does not declare is rejected, so a misspelling fails instead of being
ignored.

**Tool events** (`tool.before`, `tool.after`, `tool.error`, `permission.request`)
need a `tool` holding `nativeName` and `input`. Other events refuse one.
These are the harness's own tool name and arguments: Claude's `Bash` takes
`command`, while OpenCode v2's `shell` takes `command` and `workdir`. Dispatch classifies the
call the way that target's decoder does and fills in `kind`, `mcp` and `shell`
itself. An event that supplies any of the three is rejected, with the two
exceptions described next. So Claude's
`Write` is a file write however its input looks, and an input the classifier
does not recognize leaves `tool.shell` absent, exactly as in a real session.

One part of `shell` can be stated: its `dialect`, the grammar family the command
runs in (ADR-0029). OpenCode states its shell at run time rather than in the
tool call, so an OpenCode event carries no dialect unless the test says what the
harness would have stated:

```json
{ "event": "tool.before", "tool": { "nativeName": "bash", "input": { "command": "ls" }, "shell": { "dialect": "powershell" } } }
```

`shell` may hold `dialect` and nothing else. The target's classifier decides
whether it applies, and an event is refused if the target would give that call a
different dialect or none: Claude's `Bash` is always `posix`, and Codex never
establishes one, so a hook's unknown-dialect branch is what a Codex event
exercises. `hooknostic inspect <target>` says where each target's dialect comes
from.

An MCP tool's `mcp` can be stated where the harness states it outside the tool
name (ADR-0032). pi's tool names cannot be split reliably, so a pi MCP call
carries no server or tool unless the test supplies what the harness would have
stated, which pi does only on the result of a tool its MCP extension
registered:

```json
{ "event": "tool.after", "tool": { "nativeName": "mcp__docs__search", "input": {}, "mcp": { "server": "docs", "tool": "search" } }, "output": "ok" }
```

`mcp` must hold `server` and `tool`, both strings, and is accepted only on the
events `hooknostic inspect <target>` lists as stating it. A pi `tool.before`
event is refused one. Claude and Codex derive the split from the name, so a test
never states it there.

## Results

Each result is the dispatch's `HookResult` (`event`, `effects`, `terminatedBy`,
`errors`) plus:

- `target`: the configured target it ran as.
- `native`: what that target's shim would send its harness, produced by the
  adapter's own encoder. Claude Code and Codex get `{ exitCode, body?, stderr? }`.
  OpenCode gets `{ body }`, which describes what the plugin does in process:
  `throwMessage` to block, `mutations` to its callback's output, `prompts` it
  posts into the session (`reply: true` makes the agent take another turn), and
  `permissionReply`.

A hook that throws or times out appears in `errors`, as it would under the
runtime policy in a real harness. That is still a successful dispatch.

Dispatch also runs the adapter's effect validator. For example, Pi rejects a
replacement input that is not a plain object with HN401. Rejected effects obey
`onHookError`: continue without the replacement, or block where supported.

## When the hook source fails outside a handler

`hooknostic dispatch` runs your source under the same guard as the command shims
(see [Writing hooks safely](writing-hooks-safely.md#see-why-a-hook-did-nothing-hooknostic_debug)).
A rejection nothing handles, an exception thrown from a timer or callback, or a
`process.exit` call after the source loads, outside a handler, is reported on
stderr against the event it interrupted, and dispatch exits 1. Usually the run
carries on and every event still gets its result line:

```text
hooknostic internal [event 2]: stray rejection
```

Some failures still end the run early, though with exit 1 rather than the hook
source's own code. That happens when your own `uncaughtException` listener calls
`process.exit`, or when the same `process.exit` call repeats within one event, as
from `setInterval`. Result lines are written only at the end, so some or all of
them are then missing.

The event number is best effort. Dispatch waits one zero-delay timer after each
event, so a rejected promise or a `setTimeout(..., 0)` your handler left behind
is reported against that event. Anything later may be reported against a later
event, or with no event at all (`hooknostic internal: ...`). As in the shims, a
failure more than 250 ms after the last result is not reported.

What `process.exit` does depends on where it is called and on the target:

- **In a handler, on a command target** such as Claude Code or Codex: it is that
  handler's error, `the hook source called process.exit(<code>)`, in `errors`.
  The run exits 0, which is what the shim does.
- **In a handler, on a module target** (OpenCode, Pi): the same error, plus one
  line on stderr, and the run exits 1:

  ```text
  hooknostic dispatch [event 2]: intercepted process.exit(5); the opencode shim runs in the harness's process and does not intercept it
  ```

  An exit outside a handler on these targets gets the same note at the end of
  its `hooknostic internal` line.
- **At the top level of your source**: a load failure, exit 2, with
  `failed to dispatch through entry ./hooks.ts: the hook source called process.exit(3)`.

A load that never settles is a load failure too, with exit 2 and no results. That
is a top-level `await` that never settles, or a default export that is a thenable
that never settles. For your hook source, on whichever event's load it happens:

```text
failed to dispatch through entry ./hooks.ts: its top-level await never settles
failed to dispatch through entry ./hooks.ts: its default export is a thenable that never settles
```

For the config, the same two messages come as HN501,
`failed to load config <path>: ...`, as `check` and `build` report them. A
rejection, a timer throw or a `process.exit` while the config loads is also its
HN501, with exit 2 and no results.

To see the raw crash instead, pass `--unguarded`. The source can then end the
run with its own exit code and stack trace, and because result lines are
written at the end, none appear. Other commands reject the flag.

Only the CLI is guarded. `dispatchEvents()` (see [From code](#from-code)) runs in
your test runner's process and installs nothing, so a stray failure there is the
runner's to report.

## What carries between events

A command target (Claude Code, Codex) starts a fresh process for every hook
call, so dispatch gives each event a fresh instance of your module: nothing a
hook keeps in a module-level variable survives to the next event. OpenCode
imports your plugin once and keeps it, so events dispatched as `opencode` share
one instance, in order. State that must survive on every target belongs
somewhere that outlives a process, such as a file.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every event was dispatched. The effects and errors are in the output. |
| `1` | Your hook source failed outside a handler, or ended the process before every result was written; some or all result lines may be missing. The reports are on stderr; see [When the hook source fails outside a handler](#when-the-hook-source-fails-outside-a-handler). |
| `2` | Nothing was dispatched: a command-line mistake, such as an option the command does not support (`--json`), an unreadable or invalid event, an unknown target, a configuration without an `entry`, a config or hook source that fails to load, including one that never settles, or hooks the target could not be built for. The reasons go to stderr, numbered by event. It takes precedence over `1`. |

## What dispatch does not cover

Dispatch runs your source the way a build compiles it. It does not replay the
committed artifacts or a harness's decoder. Pair it with the check that ties
source to output:

- Project delivery: `hooknostic verify` in CI.
- Committed package output: a fresh `hooknostic build` that leaves the committed
  files unchanged.

Behaviour that depends on the host process is also out of reach. That includes
which executable runs the hook (see [Writing hooks safely](writing-hooks-safely.md)),
environment a harness sets, and concurrent calls. Events in one run are
dispatched one at a time, in the same process.

The guard has the shims' limits. `process.kill(process.pid)`, `process.abort()`
and `process.reallyExit` still end the run, and a failure later than the exit's
250 ms grace after the last result goes unreported. An `exit` listener of your own
that throws while the run is leaving from inside your own `uncaughtException`
listener ends it with Node's 7 rather than 1. One added late, from a `beforeExit`
listener, can change the exit code too. A load that never settles while a handle
your source leaked, such as an interval, keeps the process alive hangs the run:
with work still pending, it cannot be told apart from a slow load.

Checks that require a live native object also remain in the shim. Dispatch can
validate a Pi replacement's shape, but cannot establish whether the harness's
actual input object is mutable.

## From code

The `hooknostic` package exports the same operation:

```ts
import { defaultAdapterRegistry, dispatchEvents } from "hooknostic";

const outcome = await dispatchEvents({
  config: "hooknostic.config.ts",
  target: "opencode",
  events: [{ event: "turn.stop", session: { id: "s1" } }],
  registry: defaultAdapterRegistry(),
});
if (!outcome.ok) throw new Error(outcome.errors.join("\n"));
const [result] = outcome.results;
```

A test suite in another language can drive the CLI instead. In Python:

```python
import json, subprocess

events = [{"event": "turn.stop", "session": {"id": "s1"}}]
run = subprocess.run(
    ["npx", "hooknostic", "dispatch", "--target", "opencode"],
    input="".join(json.dumps(e) + "\n" for e in events),
    capture_output=True, text=True, check=True,
)
results = [json.loads(line) for line in run.stdout.splitlines()]
```
