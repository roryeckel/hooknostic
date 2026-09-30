# OpenCode turn fields

Question: at `session.idle`, what can an OpenCode 1.x plugin learn about the turn
that just ended, namely the final assistant text and the id of the prompt it
answered? `session.idle` carries only `{ sessionID }`, so the portable
`turn.stop.lastMessage` and `turn.stop.correlation.turnId` have to come from
somewhere else (ADR-0027).

## Method

No model spend. `drive.mjs` runs the installed `opencode` against the loopback
playback model (`packages/cli/test/harness-playback.ts`), which makes one shell
call and then answers `hooknostic-final-answer`. The probe plugin tees
`chat.message` and every bus event, and at `session.idle` calls
`client.session.messages({ path: { id } })`, recording the response.

Every state directory (`HOME`, `USERPROFILE`, all four XDG homes) is redirected
into a fresh OS-temp root, so an OpenCode 2 install beside this one cannot share
its state. `captured/` in that root holds the records.

```bash
node --experimental-strip-types .capture/opencode-turn-fields/drive.mjs
```

The model's replies are constructed; the plugin callbacks, bus events and the
client's answer are the harness's own.

## Observations (Windows, opencode 1.18.32, 2026-09-28)

- `client.session.messages` answers `{ data, request, response }`. `data` is the
  session's messages in order, each `{ info, parts }`.
- The turn produced **two assistant messages**, one per model step: the tool
  step (`finish: "tool-calls"`, parts `step-start`, `tool`, `step-finish`,
  `patch`) and the answer step (`finish: "stop"`, parts `step-start`, `text`,
  `step-finish`). Both carry `parentID` equal to the user message's id. This is
  the shape Claude Code's `last_assistant_message` describes: the last message,
  not the whole turn.
- `chat.message`'s `input` was `{ sessionID, model }`: **no `messageID`**. The
  published typings declare it optional, and the source passes the caller's
  own `messageID` through, which `opencode run` does not supply.
  `output.message.id` is the user message's id, and it is the `parentID` both
  assistant messages name.
- `session.idle` fired once, after the last `message.updated`.

## Consequences

- The shim reads the session at `session.idle` when a `turn.stop` hook declares
  `lastMessage` or `correlation.turnId`, and hands the answer's `data` to the
  decoder beside the callback envelope, so the decoder stays pure and
  `event.raw` stays what the callback received. `lastMessage` is the text of
  the latest assistant message of the turn that has any; `turnId` is the last
  assistant message's `parentID`. Both are rated `emulated`.
- `prompt.before.correlation.turnId` is `output.message.id`, rated `exact`, so a
  prompt and its turn's stop carry the same id.
- Reading, not buffering `message.*` bus events: in a captured aborted turn a
  `message.updated` arrived after `session.idle` (`../opencode-client`).

Promoted to `fixtures/opencode/1.18` as `session-idle-with-messages` (its read in
`session-idle-with-messages.enrichment.json`) and `chat-message-without-message-id`,
with the account name redacted.
