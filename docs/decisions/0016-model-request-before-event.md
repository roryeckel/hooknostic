# Decision 0016 — A portable `model.request.before` event

**Status:** Accepted — 2026-09-15 · Referenced from code and docs as **ADR-0016**

**In short:** OpenCode is the only harness with a hook between system-prompt assembly
and the model request. Rather than overload `session.start`, whose once-per-session
contract that hook does not meet, the moment gets its own portable event — accepting a
narrow exception to design §6.1's two-harness rule.

## Context

A memory plugin wants to put recalled context in front of the model. On Claude and Codex
that is `session.start.context.add`, rated `exact`. On OpenCode there was no
model-visible context channel at all outside compaction, so the capability was absent
and such a plugin simply did nothing there.

A widely copied plugin approach appeared to solve this by writing
`output.options.systemPrompt` in the `chat.params` hook. A live probe
(`.capture/opencode-context-channel`, opencode 1.18.30) established that this **does not
work**: `chat.params` fires *after* `prepare()` has already built the request's message
array, and its `output.options` is the provider-options bag, which is spread into the
request body as top-level JSON keys. The marker arrived on the wire as a `systemPrompt`
field beside `model` and `max_tokens` — a field no OpenAI-compatible API reads. The
approach logs success either way, which is why it went unnoticed.

The same probe found a channel that does work: `experimental.chat.system.transform`,
whose `output.system: string[]` entries each become a `role: "system"` message.

## Decision

**Add `model.request.before` to the portable event vocabulary**, with
`model.request.before.observe` and `model.request.before.context.add`. OpenCode rates
both `exact`; Claude and Codex omit the cells entirely, so a hook on the event is
rejected by capability analysis (HN202) rather than silently doing nothing.

### Why not map it onto `session.start`

The channel fires **once per model request** — every assistant step, plus title
generation and summarization. A single user turn produced two invocations in the probe.
Three ways to reconcile that with `session.start` were considered and rejected:

- **Dispatch `session.start` from both callbacks.** Every existing `session.start`
  handler would then run N× per session, forcing `session.start.observe` down to
  `approximate` — a semantics break for an event whose name promises once.
- **Partition handlers across the two callbacks by declared capability.** Protects
  `session.start.observe`, but makes a hook silently change lane based on a capability
  it declares, which weakens ADR-0003's "one dispatcher, one order" story. It also does
  not help the motivating plugin, whose hook does both once-per-session bootstrap *and*
  injection.
- **Buffer across `chat.message` and drain at `system.transform`.** Cleanest semantics,
  but requires per-session state in the shim, head-on with ADR-0002, and leaks when a
  prompt never reaches a request.

Naming the moment honestly costs one event and keeps every existing contract intact. It
also lets OpenCode rate the cells `exact` instead of `approximate` — and `approximate`
is below the default `compatibility.minimum`, so the alternative would have forced every
consumer into an explicit opt-in.

### The exception to §6.1

design.md §6.1 says not to add a normalized event because one vendor exposes it. This is
an exception, admitted on a narrow ground: **the event is named for a moment every
harness has** — assembling a request to the model — not for a vendor feature. Claude and
Codex both perform it; they merely expose no hook at it. If either ever does, the event
is already there and correctly named.

The rule still holds for genuinely vendor-shaped concepts (worktree, task, notification,
file-watcher). The test is whether the *moment* is universal, not whether the *hook* is.

## Consequences

- A handler on this event runs on the latency path of **every** model request. Authors
  doing network I/O there must cache; the per-dispatch `timeoutMs` applies each time.
- The channel is `experimental.`-prefixed upstream, the same exposure the compaction
  cells already accept — but on the hot path of every request rather than at compaction.
- Portable plugins wanting injection everywhere carry two hooks: `session.start` for
  Claude and Codex, `model.request.before` for OpenCode, typically sharing one body.
  That duplication is the honest cost of the harnesses differing.
- **Push rather than reassign.** `prepare()` passes the same array it builds the request
  messages from, so in-place mutation is established to work. Whether a replacement array
  would also be honoured was not tested, so the shim pushes and does not rely on the
  answer; `shim.test.ts` pins the in-place behaviour with a mutation-verified test.
- `chat.params` is now documented as *not* a context channel, in the OpenCode profile
  rationale, so the next person does not rediscover it the expensive way.
