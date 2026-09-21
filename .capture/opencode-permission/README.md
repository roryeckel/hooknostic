# OpenCode permission capture

## Question

Does the documented `permission.ask` plugin hook actually fire, and can a
hook deny a bash permission request on opencode 1.18.x? The capability
profile rated `permission.request.observe`/`block` `exact` against that
callback, but the rating rested on the published `Hooks` type definitions —
the smoke capture project never drove a permission ask.

## Method

`.capture/opencode-permission/` is a self-assembling capture project:
`run-capture.mjs observe|deny [waitMs]` copies the template config and probe
plugin into a TEMP scratch, starts the loopback playback model (streaming SSE
openai-chat — a plain-JSON server spins opencode's agent loop forever), runs
`opencode serve` pinned to a Basic credential, and posts one prompt whose
scripted tool call (`mkdir hooknostic-perm-probe`) trips
`permission: { bash: "ask" }`. The probe plugin records to `captured/*.jsonl`
inside the scratch dir:

- `permission-hook-calls.jsonl` — invocations of the `permission.ask`
  callback (negative evidence when absent),
- `permission-bus.jsonl` — every `permission.*` bus event verbatim,
- `permission-answered.jsonl` — the deny-mode reply API call and result.

Modes: observe leaves the ask pending (the POST message endpoint then never
returns — itself evidence the ask is a real unanswered prompt); deny answers
it via `client.postSessionIdPermissionsPermissionId`.

## Observation (opencode 1.18.25, Windows, 2026-09-01)

1. **`permission.ask` never fires.** With `permission: { bash: "ask" }` in
   the project config and a registered `permission.ask` callback, the server
   logs `evaluated permission=bash … action=ask` and `asking id=per_…` — and
   the callback file is never created. Matches upstream
   anomalyco/opencode #9229 / #7006: the active Permission module publishes
   `Bus.publish(Event.Asked, info)` and never calls
   `Plugin.trigger("permission.ask", …)`.
2. **The ask arrives on the generic `event` callback** as
   `permission.asked` with properties `{ id, sessionID, permission,
   patterns, metadata: {command}, always, tool: {messageID, callID} }`
   (fixtures/opencode/1.18/permission-asked.input.json).
3. **Deny via the client reply API works.** In deny mode the probe called
   `client.postSessionIdPermissionsPermissionId({ path: { id: sessionID,
   permissionID }, body: { response: "reject" } })` ~45 ms after the ask:
   the API answered `{ data: true }`, the marker directory was never created
   (the command did not run), and the turn halted (no second agent request —
   `RejectedError` halts; the scripted model would have answered any
   re-prompt).
4. The SDK client exposes the method as
   `postSessionIdPermissionsPermissionId` (prototype method; `this`-bound,
   same caveat as `session.promptAsync`).

## Consequences

- `permission.request.observe` is re-rated **emulated** (bus event via the
  generic `event` callback), `permission.request.block` **approximate**
  (client reply API round-trip, no-op without a client). Both were `exact`.
- The `permission-ask` fixture is demoted to **type-derived** provenance
  (callback envelope from the published 1.18.19 Hooks type definitions);
  its README row says so. `permission-asked` is **captured**.
- The adapter's shim registers `permission.request` on the generic `event`
  callback and denies via the reply API. The unreachable `permission.ask`
  callback surface is not represented in `permission-deny.output.json`.
- If a future opencode version starts triggering `permission.ask`, this
  capture record and the profile rationales must be revisited.

## Re-measurement (opencode 1.18.31, Windows, 2026-09-21)

The reply-API deny still works, six patch releases on. Driven this time by the
playback suite rather than `run-capture.mjs`: `HOOKNOSTIC_PLAYBACK=opencode`
with `HOOKNOSTIC_PLAYBACK_VERSION=1.18.31`, the `permission-request` scenario
on its `opencode-serve` lane, against the generated production artifact. The
ask surfaced on the generic `event` callback, the adapter answered it through
`postSessionIdPermissionsPermissionId`, the turn completed, and the denied
command's marker file was never written (103.9 s).

**What this does not re-measure:** whether `permission.ask` still fails to
fire. The playback drive asserts the deny, not the callback's absence, so the
negative evidence in Observation 1 remains as of 1.18.25 and the bullet above
still stands as written. Re-running `run-capture.mjs observe` is what would
answer it.

**Why it had to be driven by hand.** The scenario's skip predicate in
`packages/cli/test/harness-playback.test.ts` read
`adapter?.id !== "claude" || !ptyApprovable() || …`, so every non-Claude
harness skipped — including the OpenCode branch the drive body opens with, and
including the pty requirement that the serve lane does not use. The drive had
therefore never executed, in CI or locally, since `driverByHarness` gave
OpenCode its own lane. The predicate now splits by driver, so this evidence is
regenerated by the suite rather than by hand.
