# Optional event fields are rated per target

Not every harness sends every optional event field. Until now nothing said which:
OpenCode never set `turn.stop.lastMessage` or `correlation.turnId`, and a hook that
read them built clean there and received `undefined`. 0.3.0 rates optional fields
per target the way capabilities are rated, and OpenCode now produces the turn's
fields ([ADR-0027](decisions/0027-event-field-fidelity.md)).

- Declare the optional fields a hook reads:
  `hook("turn.stop", { fields: ["lastMessage", "correlation.turnId"], … })`.
  Keys are event-relative or full ids (`turn.stop.lastMessage`), typed per event.
- A declared field a target never produces fails the build with **HN108**. A derived
  one (`emulated`, `approximate`) follows `compatibility.minimum` and
  `onBelowMinimum`. Accept a shortfall you handle with
  `compatibility.accept: ["<adapter>:<field id>"]`, globally or per target; an
  accepted HN108 is still reported, as information, and the build report lists every
  instance under the target's `fields`.
- `hooknostic inspect <target> --field turn.stop.lastMessage` shows a rating and its
  rationale, and the generated support table lists every target's fields.
- OpenCode 1.x reads the session's messages at `session.idle` for `lastMessage` and
  `turnId`; OpenCode 2.x assembles them from its event subscription. Both are
  `emulated`, both are done only when a hook declares the field, and neither puts
  what it gathered into `event.raw`. `prompt.before.correlation.turnId` is now set on
  both families, from the user message's id.

## Migrating

- A hook that declares no `fields` builds and behaves as before. On OpenCode it
  still receives no turn fields: declare them to get them.
- `hooknostic dispatch` now refuses an optional field the target's decoder never
  produces, and `correlation.toolCallId` on an event without a tool. A test that
  passed such an event was testing something the harness never sends; drop the
  field from that target's event.
- Adapter authors rate the fields their decoder sets in the profile's `fields`
  matrix; the contract suite holds the ratings to the fixtures.

## Limits

- Claude Code and Codex rate only what their captured fixtures carry. `agentId`
  inside a subagent's tool events and `parentAgentId` anywhere are not claimed.
- OpenCode 1.x: the session read is bounded at 10 seconds and fails open; an aborted
  turn still dispatches `turn.stop` twice, each with the text stored at that moment.
- OpenCode 2.x: an execution no prompt hook started (a stop-prevention continuation)
  and one started by a prompt admitted while another ran report no `turnId`.

Start with the [README](../README.md); [OpenCode families](opencode-families.md) covers
choosing v1 or v2, and [harness support](harness-support.md) lists each target's field
ratings.
