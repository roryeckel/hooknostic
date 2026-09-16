# OpenCode model-visible context channel

## Question

`packages/adapter-opencode/src/profile.ts` rates `session.start.context.add`,
`prompt.before.context.add` and `tool.*.context.add` unsupported, with the
comment "No model-visible context channel at session start". Only
`context.compact.before.context.add` is `exact`. Is that still true — and is
there any callback on 1.18.x through which a plugin can put text in front of
the model outside compaction?

Two candidates were tested against each other in one run:

1. `chat.params` → `output.options.systemPrompt`. This is what
   a widely copied plugin approach does, and it logs
   "Injected Zep context into systemPrompt" on success, so it is widely
   believed to work. Treated here as the **negative control**.
2. `experimental.chat.system.transform` → push into `output.system`.

## Method

`probe-plugin.js` is a vanilla plugin module with no repo imports. It
registers both callbacks plus `chat.message`, pushes a distinct marker string
through each channel, and tees every invocation envelope to
`captured/<hook>.jsonl`. `loopback-server.mjs` is a recording
OpenAI-compatible provider that appends every request body it receives to
`captured/requests.jsonl` and answers with a minimal streamed completion.

To run: start `loopback-server.mjs`, substitute its port into
`opencode.template.json`, place the probe at `.opencode/plugin/probe.js` in a
scratch project, and `opencode run "<any prompt>"` with `PWD` set to agree
with the process cwd (opencode trusts an inherited `PWD` over the real cwd).

The decisive artifact is the recorded **request body**, not a log line or the
absence of a harness error — the channel is only real if the marker reaches
the wire in a position the model reads.

## Observation (opencode 1.18.30, Windows, 2026-09-15)

One user turn produced **two** model requests (`agent: "title"` and
`agent: "build"`). Both callbacks fired once per request.

1. **`experimental.chat.system.transform` is a real system-prompt channel.**
   The pushed string arrived as its own `role: "system"` message, second in
   the array, in both requests:

   ```
   msg[0] role=system len=2096    (base prompt)
   msg[1] role=system len=37      <-- pushed marker
   msg[2] role=user
   ```

2. **`chat.params` → `options.systemPrompt` does NOT reach the model.** The
   options bag is spread into the request body as **top-level JSON keys**, so
   the marker landed beside `model` and `max_tokens`:

   ```
   top-level keys: model, max_tokens, systemPrompt, messages, stream, stream_options
   systemPrompt: "HOOKNOSTIC_PROBE_CHAT_PARAMS"
   ```

   It is not a system message and no OpenAI-compatible API assigns meaning to
   a top-level `systemPrompt` field. The text is transmitted and ignored; a
   strict provider would reject the request instead. **That injection approach is
   therefore inert**, and its success log is non-evidence.

   The ordering in the binary explains why. From `LLMRequestPrep.prepare`
   (read from `opencode.exe` at offset ~100853200):

   ```js
   let l = [ /* base system prompt */ ];
   yield* e.plugin.trigger("experimental.chat.system.transform", {...}, { system: l });
   ...
   let f = o || e.isWorkflow ? e.messages
         : [...l.map((W) => ({ role: "system", content: W })), ...e.messages];
   let u = yield* e.plugin.trigger("chat.params", {...}, { temperature, topP, topK, options: d });
   ```

   The message array `f` is built from `l` **before** `chat.params` fires, and
   `d` is the provider-options bag. The only `systemPrompt` write in the
   binary is `m.systemPrompt = a.system.join("\n")` on the workflow path,
   sourced from `prepare`'s own `system` array — never from `options`.

3. **Cadence is per model request, not per session.** Two invocations for one
   user turn, including the title-generation request. Any capability backed by
   this callback runs its handler on the latency path of every request.

4. **`input.sessionID` was present** and stable across calls
   (`ses_f5a8869a2ffe2c…`) at 1.18.30. It is **declared optional** in the published
   typings, so the decoder tolerates its absence rather than relying on it.

5. **`output` carries exactly one key, `system`.** `systemLenBefore: 1` →
   `systemLenAfter: 2` on both calls, and the two strings stayed two separate
   system messages — the `l.length > 2` collapse in `prepare` needs three or
   more and did not trigger with a single push.

## The OpenAI-OAuth path (live-probe, 1.18.30, 2026-09-15)

`prepare()` branches on `o = provider.id === "openai" && auth?.type === "oauth"`:

```js
if (o) d.instructions = l.join("\n");
let f = o || e.isWorkflow ? e.messages
      : [...l.map((W) => ({ role: "system", content: W })), ...e.messages];
```

So on that path the pushed strings are joined into the provider-options
`instructions` field and **no system messages are sent at all**. The observation
above therefore does not describe it.

**It could not be captured on the wire.** The OAuth path ignores a `baseURL`
override and reaches OpenAI directly: pointing a provider named `openai` at the
loopback with a synthetic oauth credential produced
`Unauthorized: Could not parse your authentication token` from the real endpoint
and zero loopback requests. Intercepting it needs real credentials plus a MITM
proxy.

**So it was captured effect-level instead**, which is stronger evidence anyway —
it shows the model *acted on* the text rather than that a field was on the wire.
With real OAuth credentials, model `gpt-5.6-luna`, one turn each:

| Run | Prompt | Reply |
| --- | --- | --- |
| control, no plugin | "What is 2+2? Answer with just the number." | `4` |
| same prompt, plugin injecting a directive to answer with a fixed token | same | the token |

The injected text reached the model. **The channel is provider-path independent;
its delivered shape is not** — a hook asserting on the shape (as the playback
drive does, requiring a `role: "system"` message) is asserting about the
openai-compatible path only.

## Version coverage (type-derived, 2026-09-15)

The live probe establishes 1.18.30 only. The adapter profile spans `>=1.10 <2`, so the
callback was checked against the published typings across that range:

| `@opencode-ai/plugin` | `experimental.chat.system.transform` | signature |
| --- | --- | --- |
| 1.14.17 | present | `(input { sessionID?, model }, output { system: string[] })` |
| 1.16.0 | present | identical |
| 1.18.18 | present | identical |

`opencode-ai` publishes **no 1.10.x-1.13.x release** (checked against the registry
version list), so 1.14.17 is the range floor in practice and the callback is declared
across all of it. Note the typings declare `sessionID` **optional**, even though it was
present on every probed invocation -- the decoder must tolerate its absence.

What this does *not* establish: that the delivery behaviour observed at 1.18.30 is
identical on 1.14-1.17. Only the declaration is type-derived.

## Consequences

- `session.start.context.add` can be backed by
  `experimental.chat.system.transform`, but **not at `emulated`**: the channel
  fires per request where the portable event means once per session, which is
  the same mismatch that rates `turn.stop.observe` `approximate`
  (`profile.ts:146-150`).
- The dispatch question is open: `session.start` currently decodes from the
  `session.created` bus event, a different callback.
- Push, never reassign. The harness holds a reference to `l`; this probe only
  established that `push` works, not that reassignment fails.

- **The probe tees a summary, not the envelope.** `probe-plugin.js` records the
  callback name, call index, session id, `Object.keys(output)` and the
  `output.system` length before and after — enough to answer the questions above,
  but not a verbatim invocation record. So `fixtures/opencode/1.18/system-transform.*`
  is *constructed* from these observations plus the published typings, not promoted
  from a capture; that fixture's README says which fields are which. A future probe
  wanting promotable fixtures should clone the whole `{hook, directory, input, output}`
  envelope with the `safeStringify` discipline `.capture/opencode-capture` uses.

## Not established

- Whether reassigning `output.system` (rather than pushing) is ignored.
- The `l.length > 2` collapse behaviour with two or more pushed strings.
- The OAuth path’s wire shape. Its delivery is established effect-level (above), but
  no recording of the `instructions` field itself exists — that needs a MITM proxy.
- Whether a strict provider 400s on the stray top-level `systemPrompt`.
- macOS and Linux. Windows only.
- Versions other than 1.18.30.
