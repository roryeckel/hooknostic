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
need a `tool` holding only `nativeName` and `input`. Other events refuse one.
These are the harness's own tool name and arguments: Claude's `Bash` takes
`command`, while Codex's `exec_command` takes `cmd`. Dispatch classifies the
call the way that target's decoder does and fills in `kind`, `mcp` and `shell`
itself. An event that supplies any of the three is rejected. So Claude's
`Write` is a file write however its input looks, and an input the classifier
does not recognize leaves `tool.shell` absent, exactly as in a real session.

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
| `2` | Nothing was dispatched: an unreadable or invalid event, an unknown target, a configuration without an `entry`, or hooks the target could not be built for. The reasons go to stderr, numbered by event. |

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
