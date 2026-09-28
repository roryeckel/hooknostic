# Decision 0027 — Hooks declare the optional event fields they read

**Status:** Accepted — 2026-09-28 · Referenced from code and docs as **ADR-0027**
**Builds on:** ADR-0001 (capabilities are separate from events), ADR-0022 (shortfall
policy), ADR-0023 (dispatching portable events).

**In short:** an optional event field such as `turn.stop`'s `lastMessage` or
`correlation.turnId` is rated per target, like a capability. A hook lists the ones it
reads in `fields`. A target that cannot produce a listed field exactly reports
`HN108`, which fails the build when the field is never produced, unless the author
accepts it by id. `hooknostic dispatch` refuses a field the target's decoder never
produces.

## Context

The canonical event marks a field optional when some harness may not supply it
(`events.ts`: "adapters must not invent IDs"). Nothing said *which* harness. Claude
Code and Codex fill `turn.stop.lastMessage` from `last_assistant_message` and
`correlation.turnId` from `prompt_id` / `turn_id`. Both OpenCode decoders set
neither, on any event: OpenCode 1.x decoded `session.idle` into a bare `turn.stop`,
and OpenCode 2.x did the same with `session.execution.succeeded`. The omission was
accidental. No profile note, TODO or ADR recorded it.

So a hook that summarized each turn's last message compiled, checked and built
clean for OpenCode, and received `undefined` there on every turn. Capability
analysis could not see it: capabilities are behaviours (can the hook block, add
context, prevent a stop), and reading a field is none of them. No diagnostic code
covered fields. `hooknostic dispatch` accepted the same optional fields on every
target, so a consumer's test dispatched a `turn.stop` with a `lastMessage` to its
OpenCode target and passed, although no OpenCode decoder could ever produce one.
That contradicts ADR-0023's rule that a test cannot hand a hook an event its
harness never would.

Fixing OpenCode's decoders fixes this instance. The class survives it: the next
field one decoder omits would pass the same tests.

## Decision

1. **A registry of optional event fields.** Each event's optional payload fields
   (`session.start.how`, `session.end.reason`, `tool.error.error.message`,
   `context.compact.before.trigger`, `agent.start.agent.id` and `.agent.type`,
   `agent.stop.agent.id`, `.agent.type` and `.lastMessage`, `turn.stop.lastMessage`)
   and its correlation ids (`<event>.correlation.turnId`, `.agentId`,
   `.parentAgentId`, and `.toolCallId` on tool-scoped events) have stable ids,
   `ALL_EVENT_FIELD_IDS` in the SDK. Ids are event-scoped for the same reason
   capability ids are: Claude Code sends `prompt_id` on every event except
   `SessionStart`. Required fields (`prompt`, `tool`, `session.cwd`) and
   `session.id` are not in it.
2. **Profiles rate fields.** A capability profile carries a `fields` matrix beside
   `matrix`, with the same `{ level, rationale }` entries. `exact`: the native event
   carries the value. `emulated` or `approximate`: the adapter derives it by other
   means, with a rationale saying how it can differ. Absent: the decoder never sets
   it. Several profiles resolve to the least capable level, as capabilities do. The
   contract suite holds the matrix to the fixtures: every registered field a
   canonical fixture carries must be rated, and every rated field must be carried by
   some fixture.
3. **Hooks list the fields they read.** `hook("turn.stop", { fields: ["lastMessage",
   "correlation.turnId"], … })`. Keys are event-relative or full ids, canonicalized
   by `hook()` as capability keys are. It is a list, not a map of requirement levels:
   every registered field is already optional in the event's type, so the handler
   already copes with its absence. What differs is the target, and ADR-0022's
   acceptance by id already speaks per target.
4. **One shortfall, `HN108`.** For each declared field on each target where the
   hook's event is observable, a level below `exact` is reported:
   - never produced (absent): **error**;
   - `emulated` or `approximate` below `compatibility.minimum`: the severity of
     `compatibility.onBelowMinimum`;
   - otherwise: **info**.

   An accepted instance is reported as info whatever its level. The build report
   records every instance under the target's `fields`, with its qualified id, its
   level and whether it was accepted. A hook whose event is unavailable on a target
   gets HN202 and no field diagnostics.
5. **Acceptance by id.** `compatibility.accept` lists qualified ids,
   `<adapter>:<event>.<field>`, such as `"opencode:turn.stop.correlation.turnId"`. The
   global and per-target lists add up. An id that names no configured target's
   adapter, or a field no profile of that adapter rates below `exact`, is an HN501
   error, so a typo cannot silently accept nothing. Every profile of every version
   family counts, at either scope, as ADR-0022 has it for components: an accepted
   id may belong to a range the target does not cover yet. The option lives in
   `compatibility` rather than `components.accept` because a hooks-only build has
   no `components`, and because it extends the hook-fidelity policy that
   `minimum` and `onBelowMinimum` already set.
6. **Dispatch refuses what the decoder never produces.** A dispatched event that
   carries a registered field its target leaves absent is rejected, naming the
   field. `emulated` and `approximate` fields are accepted: the decoder can
   produce them.
7. **A declaration is also a request.** An in-process adapter may do per-event work
   to produce a field, such as a request to the host or a buffer of streamed
   events. It may skip that work when no hook applying to the target declares the
   field, so on such a target an undeclared read can be absent where the profile
   rates the field. What it gathers reaches the decoder beside the native
   envelope, never inside it: `event.raw` stays what the harness sent, so a hook
   that declared nothing is not handed a session's history. Command targets
   decode the whole payload either way.
8. **Undeclared means unchecked.** A hook without `fields` gets no field diagnostics
   and no warning. Nothing can see which fields a handler reads, and most hooks
   read none, so a warning on every hook that declares nothing would be noise.

The first ratings: Claude Code and Codex rate what their captured fixtures carry.
OpenCode 1.x reads the session's messages through the plugin client at
`session.idle` to produce `turn.stop.lastMessage` and `turn.stop.correlation.turnId`
(`emulated`), and takes `prompt.before.correlation.turnId` from the created user
message (`exact`). OpenCode 2.x buffers the `session.text.ended` events of each
execution from its event subscription for `lastMessage`, and remembers the prompt
hook's `messageID` for `turnId` (`emulated`). Each rests on a live capture recorded
in the profile.

## Consequences

- A hook that reads an optional field states it, and a target that cannot supply it
  fails the build or says how it differs. The consumer case above now reports
  `HN108` on any target that leaves `lastMessage` absent.
- Adding a field to the registry is a vocabulary change: it needs every profile's
  rating, from captured evidence, and a fixture per rated cell.
- A consumer test that dispatched a field its target never produces now fails, as
  ADR-0023 intended. The fix is to drop the field from that target's test event.
- Declaring nothing keeps today's behaviour, including silent absence.
- `hooknostic inspect` and the generated harness support page list each target's
  field ratings, so the answer to "does this harness send X" has one home.

## Alternatives considered

- **Fields as capability ids** (`turn.stop.lastMessage.read`). Capabilities license
  effects and carry requirement levels. A read licenses nothing, and folding fields
  in would multiply the capability registry by events and fields.
- **Requirement levels per field.** Declaring a field optional would switch the check
  off on every target at once. Acceptance names one target and one field.
- **Narrowing the handler's event type to the declared fields**, so an undeclared
  read fails to compile, as an undeclared effect does. That is the strongest form,
  but it breaks every existing read of an optional field, including the tutorial's
  `event.reason`, and still cannot see reads through `raw`. It can follow later with
  a migration path.
- **Tracking reads at runtime** with a proxy over the event. It costs every dispatch
  in production, and a proxy changes what handlers observe (identity, cloning).
- **Only fixing the OpenCode decoders.** It fixes this field, not the class.
