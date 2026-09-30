# OpenCode system-transform persistence

## Question

Text pushed into `output.system` from `experimental.chat.system.transform` on
one model request: is it still in front of the model on later requests of the
same session if the plugin does not push it again? (Decides whether an
emulated `session.start.context.add` may inject once, or must replay on every
request. Follow-up to `../opencode-context-channel`.)

## Method

`probe-plugin.js` pushes `HOOKNOSTIC_PROBE_ONCE_ONLY` on the first transform
call per session id only (seen-set persisted to `captured/seen.txt`, so separate
`opencode run` processes share it). Two turns in one session against the
recording loopback; every request body is checked for the marker.

## Observation (opencode 1.18.33, Windows, 2026-09-30)

Two `opencode run` processes, one session, three model requests:

| # | Request | Marker in body | Roles |
| --- | --- | --- | --- |
| 0 | turn 1, title agent | **yes** | system,system,user,user |
| 1 | turn 1, build agent | no | system,system,user |
| 2 | turn 2, build agent | no | system,system,user,assistant,user |

1. **Pushed system text is not persisted.** Turn 2's body, which replays the
   turn-1 user and assistant messages, carries no trace of the marker. It is
   rebuilt from the plugin's output on every request.
2. **The first transform call in a session is the title request**, not the
   main-agent request. An inject-once-per-session hook therefore spends its one
   injection on the title-generation call and the build agent never sees it.
3. `input.sessionID` was present on all three calls and stable.

## Consequences

- An emulated `session.start.context.add` cannot inject once. It must run the
  handler once per session, cache the result, and replay it on every request.
- The replay should be skipped for non-primary requests only if a way to tell
  them apart is captured (not established here; `input` carried no agent name).

## Not established

- Whether the title request can be distinguished from the build request in the
  transform input.
- Same-process behaviour (the seen-set was file-backed across two processes).
- Compaction requests, child sessions, other versions and platforms.

## Follow-up: can the transform input tell title from build? (1.18.33, 2026-09-30)

`probe-input.js` dumps the whole callback envelope. One `opencode run` turn, two
calls (title request, then build request).

- `input` has exactly two keys, `sessionID` and `model`, on both calls. The
  values are **identical** between the two requests (same session, same model
  object): no agent name, no small-model flag, no message id.
- The only difference visible to the callback is `output.system[0]`, the base
  prompt: `You are a title generator. ...` versus `You are opencode, an
  interactive CLI tool ...`. Matching on prompt prose is not a stable contract.
- The request bodies agree: the title request carries an extra leading user
  message (`Generate a title for this conversation:`).

### Consequences

- A replaying emulation cannot target the primary agent from the callback's
  typed input. It either replays into title-generation requests too (harmless
  but wasteful, and it changes the title request's context) or sniffs the base
  prompt (fragile). The profile rationale would have to say which.
- This also weakens the `model.request.before` claim that one portable event
  fires per model request with nothing to tell the requests apart.

### Not established

- Whether a later `@opencode-ai/plugin` version adds an agent field.
- Other auxiliary requests (compaction, summary) and their base prompts.
