# OpenCode v2 remaining-capability audit

Windows, `@opencode/cli` 2.0.17, 2026-09-26. Each drive uses fresh scratch
state and a private server. Model responses and OAuth services are constructed
loopback fixtures. Hook payloads and recorded HTTP requests come from the real
harness. No paid model or real credential is involved.

After `pnpm run bundle`, run from the repository root:

```sh
node --experimental-strip-types .capture/opencode-v2/drive.mjs results
node --experimental-strip-types .capture/opencode-v2/drive.mjs notifications
node --experimental-strip-types .capture/opencode-v2/drive.mjs provider-anthropic
node --experimental-strip-types .capture/opencode-v2/drive.mjs provider-responses
node --experimental-strip-types .capture/opencode-v2/drive.mjs subagent
node --experimental-strip-types .capture/opencode-v2/drive.mjs subagent-late
node --experimental-strip-types .capture/opencode-v2/drive.mjs subagent-fail
node --experimental-strip-types .capture/opencode-v2/drive.mjs subagent-followup
node --experimental-strip-types .capture/opencode-v2/drive.mjs subagent-opt-in
node --experimental-strip-types .capture/opencode-v2/drive.mjs project-oauth
node --experimental-strip-types .capture/opencode-v2/drive.mjs package-oauth
```

Use `HKN_OPENCODE_BINARY` for a native executable override. Each command prints
its scratch root. Notifications require `node-pty`; the drive creates a private
terminal, sends Ctrl+C to exit, and kills the child in `finally` if necessary.

## Observations and limits

| Probe | Evidence |
| --- | --- |
| Tool error | Missing-file `read` yields `execute.after`, `status: error`, `_tag: Tool.Error` and a message. Generated hooks dispatch `tool.error` with input and call ID. A plain custom `Error` reaches the model but bypasses this callback; shell nonzero exit remains a completed result. Observation is approximate. |
| Rich output | Text and object replacements reach the next model request; objects become JSON text. Original content, structured `output` and metadata survive in the captured raw event. Structured output/metadata are not replaced, so support stays approximate. |
| Notifications | A companion `./tui` entry receives a server RPC event, renders its sentinel in terminal output and records cleanup on normal exit. Attention returns `attention_disabled` under scratch defaults. A generated user-only notification, OS delivery, remote-client routing and disconnected delivery remain unverified; portable `notify` is emulated with `session.synthetic` (`../opencode-v2`). |
| Providers | Anthropic Messages and OpenAI Responses HTTP each exercise ordinary, title, generation and successful compaction with injected context. Shell markers establish execution. WebSocket, other providers and provider OAuth remain unverified. |
| Subagent | A foreground `general` child returns its sentinel to the parent's recorded request. Session IDs differ. Deeper nesting is unverified. From 2.3.0 the child always runs in the background: see [Background subagents](#background-subagents-windows-230-2026-11-16). |
| MCP OAuth | Project and packed relocated package reach `needs_auth`, discover metadata, dynamically register and complete S256 PKCE. The issuer checks the verifier, rejects the expired token and observes a refresh grant. The tool executes with the refreshed bearer. Custom options, real issuers, cancellation and restart persistence remain unverified. |

## Probe corrections

The initial Responses fixture omitted streamed text. Generation returned text,
but compaction failed with `Compaction produced no summary`. Adding the complete
text event sequence made successful compaction observable; playback now requires
the ended event and rejects failed compaction.

The initial OAuth fixture accepted the expired token. That did not establish
refresh. The committed fixture enforces expiry, and playback requires a refresh
grant and refreshed bearer on `tools/call`.

The first RPC probe could not resolve `@opencode/plugin/rpc` from a bare local
package. Inspection of the matching SDK showed `Rpc.define` returns its argument
after checking reserved names. The final probe uses that structural contract and
the harness-resolved TUI import, with no dependency installation. Explicit RPC
method input/output schemas were needed on the tested route.

## Evidence and regressions

`promote-results.mjs <results-root>` preserves reviewed hook payloads.
`promote-audits.mjs` takes six roots: Anthropic, Responses, subagent, project
OAuth, package OAuth, notifications. Redacted records land in
`fixtures/opencode/2.0/audits`, plus the subagent completion fixture.
Provider summaries are constructed from captured requests; OAuth HTTP rows
and notification callbacks are captured. OAuth tokens, codes and verifiers
belong only to the disposable local issuer.

Playback enforces effects; fixtures enforce decoding. Drift comparison separates
typed failures from successful results for the same tool. The named audit
mutants in `verify-mutations.mjs` exercise those assertions. SSE remains
unsupported.

Final check exit codes, test counts and mutation outcomes are in
`validation.json`. Both offline families passed on Windows. Hosted Linux
execution and paid smoke were not run here.

## Playback recapture (Windows, 2026-10-17)

The results drive on 2.0.32 still reports the missing-file read and now also
reports the custom tool's plain JavaScript exception as execute.after with
status: error and _tag: Tool.Error. The captured full envelope is
fixtures/opencode/2.0/tool-custom-error.input.json. The initial omission on the
reference build remains historical; the approximate capability rating is
unchanged because coverage differs across the validated builds.

The project/package remote drives at the same version/date sent /http without
the reference capture's codemode=false query. Selected actual tools/call HTTP
requests are in fixtures/opencode/2.0/remote/playback-recapture.json. The
expanded project header and literal package header, one call, and model-visible
result still hold. Playback accepts those two observed query forms and validates
any custom error's message and call ID; unknown errors and query parameters
still fail.

### OAuth catalog readiness

A later full 2.0.32 run at the same date reached connected status and a refreshed
tools/list response before creating the session, but its first scripted MCP call
returned an unknown-tool result. The next model request included a native catalog
update advertising tools.http.hooknostic_echo. Complete selected tool-result and
catalog-update messages are preserved in oauth-catalog-readiness.json; they are
captured model messages, not hook payloads. The test's labels are constructed.

The loopback model now retries that same OAuth MCP action after the captured
unknown-tool result and a native catalog update, assigning a fresh call ID each
time. It permits at most two retries; exhausted retries record an error so a
missing server cannot pass. The protected tools/call, PKCE verifier, refresh
grant and refreshed-bearer checks remain required. The deterministic regression
failed with the original one-shot script; a second test failed against a mutant
that allowed a third retry. Both passed after restoration.

The custom-error fixture also failed when error decoding was disabled. The
project and package remote checks each failed against their existing mutants
that remove configuration or headers, respectively; source bytes were restored
after every mutant.

## PR review follow-up (2026-10-17)

Playback now requires one custom error at the recaptured build and on newer
builds, and zero on the reference build. The recapture version is read from the
profile validation record pointing directly to tool-custom-error.input.json,
so the test adds no second harness-version fact. Intermediate builds retain the
variant check because the exact transition between captures was not established.

A mutant suppressed only the portable probe_failure tool.error dispatch while
leaving the missing-file error intact. The previous optional assertion passed
(exit 0), reproducing the review's false negative. The corrected assertion failed
(exit 1: expected [] to have length 1). The shim was restored byte for byte
before the passing validation runs.

Final follow-up validation on Windows: lint, formatting, build, dependency
ownership and version-literal checks each exited 0. The full suite on Node
22.22.2, including the packed-consumer check, exited 0 with 2,045 passed and
92 skipped. Both complete OpenCode v2 playback lanes (reference 2.0.17 and
recaptured 2.0.32) exited 0 with 31 passed each. Root example regeneration
exited 0 and changed no committed artifact bytes; the support page was
regenerated from metadata. All active public Node prerequisites now match the
engine range; dated compatibility-trial records retain their observed versions.

## Background subagents (Windows, 2.3.0, 2026-11-16)

Question: scheduled playback on 2.3.0 failed the subagent check (issue #219).
What does a v2 plugin see of a subagent there, and what happens to turn stops?

Method: the `subagent`, `subagent-late` and `stop` drives against the native
executables of 2.3.0 and 2.2.7, in private prefixes, with isolated state and
the loopback model. No paid model or real credential was used. `subagent-late`
is the `subagent` drive with the child's reply held back 3 s (constructed
timing). For the stop drive, `HKN_CHILD_DELAY_MS` holds the child's reply back
the same way (6 s was used); it is unset by default. The 2.3.0 `subagent` root
was promoted with `promote-audits.mjs subagent-background <subagent-root>`,
which writes only the two background fixtures and leaves the reference-build
audit files alone.

Observations on 2.3.0:

- The `subagent` tool always runs the child in the background; its schema no
  longer has a `background` argument. Its
  `execute.after` fires as the child starts, before the child's first model
  request: `status: completed`, `result.output.status: running`, and a launch
  notice as `result.content`. So `tool.after` reports the notice, never the
  child's result (`fixtures/opencode/2.0/tool-subagent-background-after`).
- When the child finishes, the parent receives `session.inbox.enqueued` with a
  `synthetic` item (`metadata.source: subagent`, the child's `childID`,
  `state: completed`). It reaches the parent's next model request as a
  user-role `<subagent sessionID=... state="completed" ...>` message holding the
  child's result. No tool message carries it
  (`fixtures/opencode/2.0/subagent-background/inbox-subagent-completed.json`).
  The item's `delivery` was `steer` in both subagent drives, both when it
  joined a running parent execution and when it started a new one.
- With the child late (`subagent-late`), the parent's first execution succeeded
  before the child's. The inbox item then started a second parent execution,
  which no prompt hook started, and `run --standalone` waited for it before it
  exited. Three `turn.stop` dispatches: the parent's and the child's, each with
  its prompt's id, then the second parent execution's, with none.
- On the `serve` stop drive, the parent's first stop is prevented. With an
  immediate child, its result joined the prevention continuation: two parent
  executions, as before. With the child 6 s late, prevention did not wait for
  it. The continuation ran and stopped, its notice was posted, and the child's
  result then started a third parent execution. The notice reached the model
  in that execution's request, beside the `<subagent>` message, with no further
  user prompt. Nine `turn.stop` dispatches, three without a turn id.

Up to 2.2.7 the tool's schema offers an opt-in `background` argument and says
the foreground is the default (also in the 2.0.17 capture). No drive passes it.
2.2.7 ran the same children in the foreground in the `subagent`,
`subagent-late` and delayed stop drives: `result.output.status: completed`
with the child's result, the result in the tool message, no inbox item, and
two parent executions on the stop drive. So up to 2.2.7 a subagent runs in the
foreground by default, and from 2.3.0 it always runs in the background. A
subagent called with `background: true` before 2.3.0 was not probed here;
nothing here says how it behaves. It was probed later on 2.0.17 and 2.2.6, for
#231 (below).

Consequences, with no adapter behaviour change:

- `tool.after` for a `kind: "agent"` tool reports the tool's actual result. From
  2.3.0 that is the launch notice, with `raw.event.result.output.status` set to
  `running`. Hooknostic has no portable field for a subagent's result.
- `tool.after.observe` stays exact. `tool.after.output.replace` still replaces
  the model-visible content on 2.3.0 (the playback `output` effect, a shell
  call); on a subagent call that content is the launch notice. No subagent
  replacement was run.
- A child posts no stop prevention or notice, as before. The execution its
  result starts in the parent is a top-level execution: it dispatches
  `turn.stop` without `correlation.turnId`, and prevention and notices apply to it.
- Reporting a background child's completion as `agent.stop` is follow-up work
  (#231, done below).

Playback derives the 2.3.0 boundary from the `captured` validation record that
names `tool-subagent-background-after.input.json`. The subagent test checks the
launch status, the user-role `<subagent>` message and the inbox item. A new
`subagent-late` test checks the extra parent execution and its missing turn id.
The stop drive's subagent stage now waits for the child's own success, then for
an idle parent, and records the launch status and the `<subagent>` requests.
The stop test accepts one extra parent execution, and the matching extra stop,
on 2.3.0 and later only.

Mutants, each run against the named build, killed, and restored byte for byte:

| Mutant | Change | Killed by |
| --- | --- | --- |
| `subagent-background-boundary` | The boundary record's version moved to 2.0.17. Anchored on the record's artifact line, since a second 2.3.0 `captured` record now exists | The subagent test on 2.0.17; the late and stop tests too |
| `audit-subagent` (existing) | `subagent` classified `other` | The subagent test on 2.3.0 |
| `subagent-late-turn-id` | The shim keeps a pending prompt id past the execution it starts | The late test on 2.3.0, and the stop test on every build, whose prevention continuation no prompt starts either. The late test alone let it survive before 2.3.0 |
| (manual) | The decoder reads `result.output` instead of `result.content` | The `tool-subagent-background-after` decode case |
| (manual) | The stop drive no longer waits for the child's success | The stop test on 2.3.0 with `HKN_CHILD_DELAY_MS=6000` |

Not probed, and not claimed: a subagent called with `background: true` before
2.3.0, a child that fails or is interrupted, a `subagent` call that sends a
follow-up to a running child by `sessionID`, and deeper nesting. The first
three were partly probed later for #231, below.

## Subagent completion as agent.stop (Windows, 2.0.17, 2.2.6 and 2.3.0, 2026-11-16)

Question: can a v2 plugin report a finished subagent as `agent.stop` (#231),
and on which builds? The signal history, the design and the gaps are in
`../opencode-v2/README.md` (Subagent completion as agent.stop).

Method: the `subagent`, `subagent-late`, `subagent-fail`, `subagent-followup`,
`subagent-opt-in` and `stop` drives against the native executables of 2.0.17,
2.2.6 and 2.3.0, each in a private prefix, with isolated state and the
loopback model. No paid model or real credential was used. Replies, failures
and delays are constructed:

- `subagent-fail` answers the child's model request with HTTP 400.
- `subagent-followup` makes a second `subagent` call with the first child's
  `sessionID`, read from the tool result, and answers the follow-up with
  different text.
- `subagent-opt-in` passes `background: true`, which the tool offers up to
  2.2.7. `HKN_CHILD_DELAY_MS` holds that child's reply back (unset by
  default).

The 2.0.17 and 2.3.0 `subagent` roots were promoted with
`promote-audits.mjs subagent-stop <2.0.17-root> <2.3.0-root>`.

Observations:

- In every drive, on every build, a child that succeeded or failed dispatched
  its own `turn.stop` under its session id. One `agent.stop` followed at once,
  under the parent's session id. It had the child as `agent.id` and
  `correlation.agentId`, the parent as `correlation.parentAgentId`,
  `agent.type: general`, the child's text, if any, as `lastMessage`, and no
  turn id.
- A child failed by HTTP 400 dispatched `agent.stop` with no `lastMessage`. On
  2.0.17 the parent's `subagent` call then ended as `tool.error`. On 2.3.0 the
  parent had already received the launch notice.
- A follow-up to the same child ran a second child execution: a second
  `agent.stop`, same `agent.id`, with the follow-up's text. On 2.3.0 the
  parent's last execution started from the child's result, without a turn id.
- With `background: true` on 2.0.17 and 2.2.6, `execute.after` reported the
  launch (`result.output.status: running`), and the child's result reached the
  parent as a `steer` inbox item and a user-role `<subagent>` message. On
  2.0.17 a prompt child dispatched `agent.stop` while `run` was still going,
  and its result started a second parent execution, whose `turn.stop` had no
  turn id. With the child 3 s late, `run --standalone` exited after the
  parent's first execution. The child only started: no completion, no
  `turn.stop`, no `agent.stop`. 2.2.6 waited for the same late child:
  `agent.stop` dispatched, and its result started a second parent execution
  with no turn id. A prompt child on 2.2.6 joined the running parent
  execution instead. Repeated on both builds, with the same results, before
  the profile rationales were narrowed to this. No stop or notice drive was
  run with an opt-in child, so their timing there is not claimed.
- The `stop` drive's child added one `agent.stop` and changed no other count.
  It had to prevent once per event and session (above), not per session.

Mutants, each killed on 2.0.17 and restored byte for byte. Unit tests replay
both captured sequences, so each unit mutant fails in both:

| Mutant | Change | Killed by |
| --- | --- | --- |
| `agent-stop-decode` | The decoder ignores the child | The `subagent-stop` decode case (U1) |
| `agent-stop-session` | The child's id as `session.id` | The `subagent-stop` decode case (U1) |
| `agent-stop-subscription` | An `agent.stop` hook alone does not subscribe | U2 |
| `agent-stop-parent-link` | The child's `parentID` is not remembered | U2 |
| `agent-stop-completion-filter` | Every child event is queued a second time | U2 (a second `session.start`) |
| `agent-stop-text` | Text is buffered only for a `turn.stop` declaration | U3 |
| `agent-stop-post-guard` | `post` no longer refuses `agent.stop` | U4 |
| `agent-stop-child-turn-stop` | The child's own `turn.stop` is skipped | U5 |
| `agent-stop-succeeded-only` | Only a succeeded child is reported | U6 |
| `agent-stop-parent-link-playback` | As `agent-stop-parent-link` | P1, the subagent drive |
| `agent-stop-order` | `agent.stop` queued before the child's `turn.stop` | P2, the late-child test |
| `agent-stop-succeeded-only-playback` | As `agent-stop-succeeded-only` | P3, `subagent-fail` |
| `agent-stop-once-per-child` | A child is forgotten as its first `agent.stop` is queued, so that one still fires | P4, `subagent-followup`: one `agent.stop` instead of two. P1 still passes, so the mutant tests the follow-up claim alone |
| `agent-stop-prevent-key` | Playback prevents once per session, not per event | P5, the stop test: the lifecycle probe times out |
| `agent-stop-post-guard-playback` | `post` no longer refuses `agent.stop`, and `agent.stop.prevent` is rated | P5: the parent's last request carries the stop reason twice. The post joined its running execution, so no execution count changed |

`apply.ts` plans stop messages for both stop events, so the guard in `post` is
the one gate that keeps them off the parent.

## Subagent start, agent ids and `session.get` recovery (Windows, 2.0.17, 2.2.6 and 2.3.0, 2026-11-16)

Question: can a v2 plugin report a subagent's start as `agent.start`, name a
child's agent ids on its own `turn.stop`, and recognize a child whose
`session.created` it never saw (#232)? The design, the scenario table, the
`session.get` latency and the gaps are in `../opencode-v2/README.md`
(Subagent start, agent ids and recovery).

Method, each against the native executables of 2.0.17, 2.2.6 and 2.3.0 in
private prefixes, with isolated state and the loopback model. No paid model
or real credential was used, and the host's `OPENCODE*` and `OPENCHAMBER*`
variables were cleared.

- `session-get/probe.mjs <opencode-executable> <scenario> <root>`, for
  `baseline`, `reload-followup`, `api-child-presetup`, `reload-mid-child`,
  `reload-mid-child-then-followup` and `otherloc-both`; the `reload-mid-child`
  scenarios with `HKN_CHILD_DELAY_MS=4000` and `HKN_TAIL_MS=8000`
  (constructed timing). It runs `serve` with only `session-get/probe-plugin.js`
  and records each plugin instance's setup, prompts, tool hooks, watched
  events, `cleanup`, and every `session.get` from the prompt hook and from the
  subscription. `session-get/summarize.mjs <outcome.json>...` prints one
  timeline per run and the lookup latency.
- `drive.mjs subagent` (promoted, below), and the `subagent-reload`,
  `subagent-api-child` and `subagent-reload-stop` drives through the generated
  playback hooks. The model's replies are chosen by a marker in the prompt,
  not in order, so executions no prompt started cannot use up a scripted call.

The 2.0.17 `subagent` root promoted for #231 was promoted again with
`promote-audits.mjs subagent-stop <2.0.17-root> <2.3.0-root>`, which now also
writes `subagent-start` and `turn-stop-subagent` from the same 2.0.17 drive.
The existing `subagent-stop` files came out byte for byte unchanged.

Observations:

- Every `subagent` drive dispatched one `agent.start` under the parent, after
  the parent's `tool.before` for the subagent call and before the child's own
  `session.start` and stops, with every field. The child's own `turn.stop`
  carried `correlation.agentId` and `correlation.parentAgentId`; the parent's
  carried neither. A follow-up dispatched no second `agent.start`.
- The probe results (`../opencode-v2/README.md`): the child's prompt hook ran
  before its `session.created` reached the subscription on every build; the
  lookup returned the parent wherever the child kept its `parentID`; 2.0.17's
  API dropped a new session's `parentID`; on 2.3.0 a reload during a running
  background child disposed the old instance first, so the child was missed;
  on 2.0.17 the old instance was never disposed, and both instances received
  every later event with the same event `id`.
- Through the shim, the 2.0.17 leak doubled the follow-up's child `turn.stop`,
  its `agent.stop` and the parent's `turn.stop` (a scratch run of
  `reload-mid-child-then-followup` with the playback hooks beside the probe
  plugin).

Mutants, each killed on 2.0.17 and restored byte for byte. Unit tests replay
both captured sequences, so each unit mutant fails in both:

| Mutant | Change | Killed by |
| --- | --- | --- |
| `agent-start-decode` | The decoder ignores the child's `session.created` | The `subagent-start` decode case (U1), U7 |
| `agent-start-session` | The child's id as `session.id` | The `subagent-start` decode case (U1) |
| `turn-stop-agent-ids-decode` | The decoder drops the child's ids from its `turn.stop` | The `turn-stop-subagent` decode case (U1) |
| `agent-start-subscription` | An `agent.start` hook alone does not subscribe | U7 |
| `agent-start-order` | `agent.start` queued after the child's `session.start` | U7 |
| `agent-start-every-event` | Every event of a known child runs the child's decode | U7 (a second `agent.stop`) |
| `turn-stop-agent-ids` | The child's `turn.stop` gets no ids | U2 |
| `turn-stop-agent-ids-everyone` | Every `turn.stop` gets ids | U2 (the parent's) |
| `recovery-disabled` | The prompt hook starts no lookup | U8, U11 |
| `recovery-every-prompt` | A lookup on every prompt, not only a session's first | U8 (the parent looked up twice) |
| `recovery-no-timeout` | The lookup's bound raised to 2,000 s | U9: the child's stop never comes |
| `recovery-global-await` | The subscription itself awaits a pending lookup | U9: the parent's stop waits 2 s |
| `recovery-throws` | A rejected lookup is not caught | U9: a lookup rejecting while the completion waits |
| `recovery-sync-throw` | A `get` that throws synchronously escapes the prompt hook | U9 |
| `recovery-no-location-check` | A record in another location is accepted | U10 |
| `recovery-not-stored` | A found child is returned but not stored | U11: the recovered child takes posts |
| `recovery-event-path` | Unknown sessions are looked up from the subscription | U12 |
| `recovery-cleanup-guard` | A completion waiting on its lookup still dispatches once cleanup has begun | U13 |
| `recovery-cleanup-recheck` | A recovered child's `agent.stop` starts even though cleanup began while its `turn.stop` hook ran | U15 |
| `recovery-cleanup-unraced` | The pending lookup is not settled by cleanup's abort, so disposal waits for its 2 s bound | U14: cleanup took about 1.9 s |
| `agent-start-playback` | No `agent.start` is queued | P6, the subagent drive |
| `agent-start-every-event-playback` | As `agent-start-every-event` | P6, `subagent-followup`; P8 |
| `turn-stop-agent-ids-playback` | As `turn-stop-agent-ids` | P6; P7, the late-child test |
| `recovery-disabled-playback` | As `recovery-disabled` | P8, `subagent-reload`; P10 (P9 too where the API keeps `parentID`) |
| `recovery-not-stored-playback` | As `recovery-not-stored` | P10, `subagent-reload-stop`: the recovered child's stop was prevented, so it ran an extra execution |

Three #231 mutants were re-anchored because the line they edit now passes the
child: `stop-event-queue`, `agent-stop-child-turn-stop` and `agent-stop-order`.

## Reloaded plugin instances (Windows, 2.0.17, 2.2.6 and 2.3.0, 2026-11-16)

Question: after a plugin reload, can each event be reported once across the
old and new plugin instances, and can a disposed instance hand the sessions it
knew to the new one (#236)? The design, the tables and what is not claimed are
in `../opencode-v2/README.md` (Reloaded plugin instances).

Method, each against the native executables of 2.0.17, 2.2.6 and 2.3.0 in
private prefixes, with isolated state and the loopback model. No paid model
or real credential was used, and the host's `OPENCODE*` and `OPENCHAMBER*`
variables were cleared.

- `session-get/probe.mjs` with the two scenarios added for this,
  `overlap-new-session` and `reload-mid-child-then-new-child`, and with
  `reload-mid-child-then-followup` and `reload-followup`: one run of each per
  build, and five more of `reload-mid-child` on 2.3.0, with
  `HKN_CHILD_DELAY_MS=4000` and `HKN_TAIL_MS=4000` (constructed timing). Only
  the probe plugin is loaded, so these record the host, not the shim.
  `session-get/instances.mjs <outcome.json>...` reports, per run, each
  instance's setup and disposal, the event ids both heard and which heard
  each first, replays, subscribe lag, and how long after the old instance's
  cleanup a running child's completion reached the new one.
- `drive.mjs subagent-reload-running`, `subagent-reload-running-stop`,
  `subagent-reload-restart` and `subagent-reload-restart-stop`, through the
  generated playback hooks (`reload-audit.mjs`); the restart drives restart
  `serve` with the same state instead of reloading the location.
- During planning, 68 earlier runs of the same probe (with an experimental
  shim beside it) were analysed the same way; their totals are quoted where
  this section says so.

Observations (`instances.mjs` over this session's 17 runs):

- 187 watched events, every one with an `id`. The 34 ids both instances heard
  were heard by the old instance first (23) or in the same millisecond (11),
  never by the new one first. The new instance never heard an event published
  before its setup, and no event the old one heard after that setup was
  missing from the new one.
- 2.0.17 never disposed the old instance after a reload during an execution;
  on an idle reload every build disposed it before setting up the new one.
  2.2.6 and 2.3.0 disposed it about 3.9 s after the new one's setup, when the
  execution ended.
- 2.2.6: the old instance heard the child's completion 5 ms before its
  cleanup. 2.3.0: in 8 of 8 runs the child's completion reached the new
  instance 12 to 27 ms after the old instance's cleanup, and the old one never
  heard it (35 of 35 during planning, 12 to 172 ms).
- 2.0.17: a new child created after the reload reached both instances as
  `session.created`; on 2.2.6 and 2.3.0, only the new one.

Through the shim, the three running-reload playback tests fail on `f6cc7de8`
(#232's merge, the shim before this change) on every build, and pass with it,
10 runs of the three per build, 30 of 30, with no re-drive. The
server-restart tests pass on every build and fail with the lookup disabled
or not stored.

Mutants (`../opencode-v2/verify-mutations.mjs`; the full run on 2.0.17
killed 133 of 133, and every file was restored byte for byte):

| Mutant | Defect | Killed by |
| --- | --- | --- |
| `reload-no-deposit` | Disposal hands nothing over | R1, R7, R9, R10, R9b, Q3, Q4, R15, R16 |
| `reload-no-superseded` | Only the claim decides: the first to read wins | R2, R5, R6, R11, L1 |
| `reload-no-dedupe` | Every instance dispatches | R2, R5, R6, R8, R9, R11, L1, L2 |
| `reload-claim-when-alone` | Claims are written with one instance alive | R3, and #232's U2, U3, U6, U7 |
| `reload-key-without-plugin`, `-location` | Another plugin, or another location, shares the group | R4 |
| `reload-no-child-elsewhere` | The prompt hook ignores other instances and the handover | R2 |
| `reload-prompt-known-not-stored` | The child found there is not linked | R2 |
| `reload-prompt-lookup-ignores-handover` | The prompt hook looks up a child the handover knows | R2, R7 |
| `reload-no-inherited-execution` | The running execution is not taken over | R1, R7, Q3 |
| `reload-inherited-child-not-stored` | The child link is not taken over | R1, R10, Q4, R15, R16 |
| `reload-newest-loses` | The older instance wins | R2, R5, R6, R11, L1 |
| `reload-gate-after-agent-start` | `agent.start` is queued before the gate | R5 |
| `reload-gate-without-compaction` | Compaction is not de-duplicated | R6, R9 |
| `reload-alone-skips-claims` | A lone instance ignores an earlier claim | R8 |
| `reload-claims-unbounded`, `reload-running-not-preferred` | No bound; running executions not kept first | R9 |
| `reload-bound-oldest-first` | Eviction ignores running executions across handovers | R9b |
| `reload-forget-when-none-live` | The handover is dropped when no instance is live | R10, R9b, R16 |
| `reload-no-id-dropped` | An event without an id is dropped | R11 |
| `reload-no-unlinked` | A handover without the child link turns off #232's lookup | R13 |
| `reload-subscription-end-keeps-live` | An instance whose subscription ended still silences older ones | R12 (both variants) |
| `reload-adopt-not-newest` | An older instance consumes the handover | Q4 |
| `reload-adopt-keeps-entry` | Adopting leaves the entry behind | Q4 |
| `reload-adopt-only-unknown` | No merge into a session the new instance already knew | R7, Q3 |
| `reload-merge-keeps-pending` | The steered prompt's id survives the merge | Q3 |
| `reload-handover-after-abort` | The handover waits for the busy queue | R15 |
| `reload-no-abort-break` | An event yielded after the abort is read | R16 |
| `reload-no-dedupe-playback` | As `reload-no-dedupe` | the three running-reload tests (2.0.17); the overlap and prevention tests (2.2.6, 2.3.0) |
| `reload-newest-loses-playback` | As `reload-newest-loses` | the overlap test and every-completion test (2.0.17); the overlap test (2.2.6) |
| `reload-gate-after-agent-start-playback` | As `reload-gate-after-agent-start` | the every-completion test, the new child (2.0.17) |
| `recovery-disabled-playback` | As `recovery-disabled` | the server-restart test, on every build |
| `recovery-not-stored-playback` | As `recovery-not-stored` | the server-restart prevention test, on every build |

Run separately, outside `verify-mutations.mjs`, because the reference
build never disposes the old instance: `no-deposit` (the every-completion
test on 2.2.6 and 2.3.0), `no-inherited-execution` and
`inherited-child-not-stored` (2.3.0; the latter also the prevention test).
`live-add-after-task` (the instance joins `live` only after its subscription
task starts) survives everything: that task's first step runs synchronously,
so the order cannot be observed. It is a comment in the code.

Re-anchored, because the lines they edit changed: `location-filter`,
`location-filter-playback`, `recovery-disabled`, `recovery-every-prompt` and
`recovery-event-path`. `recovery-disabled-playback` and
`recovery-not-stored-playback` now run the server-restart tests: since #236
the reload drives' child is handed over, not looked up, so they no longer
need the lookup.
### Review round (2026-11-17)

The two implementation reviews found one regression and three gaps.

- **A prompt steered into an execution the old instance still ran** reached
  the new instance, which then reported the session's stop (the old one
  yielded) without the execution's text or turn id, and kept the steered
  prompt's id for a later execution, which is wrong, not missing. The new
  instance now takes a copy of that execution (text, and the id of the prompt
  that started it) at the steered prompt, and a text segment both instances
  buffer is kept once. The dispatch rule is unchanged, so this cannot
  dispatch twice. The `subagent-reload-running-steer` drive prompts the parent
  and the running child after the reload, with prevention on. Before the fix
  it failed on 2.0.17 and 2.2.6 (the child's stop without text or turn id)
  and, once the parent's prevention continuation answered 1.5 s late, on
  2.3.0 in 3 of 3 runs (a later parent stop carried the steered prompt's id);
  with the fix it passes on all three.
- **A disposed newer instance leaving the group,** and **the plugin root in
  the group's key,** had no test; **a handover merging, never overwriting,**
  had none either.

| Mutant | Defect | Killed by |
| --- | --- | --- |
| `reload-steer-no-takeover` | The steered prompt takes nothing over | Q5 |
| `reload-text-not-deduplicated` | A segment both instances buffered is kept twice | Q5 |
| `reload-cleanup-keeps-live` | A disposed instance stays in the group | R17 |
| `reload-key-without-root` | Two package copies with different roots share a group | R4 |
| `reload-adopt-overwrites-execution`, `-child` | The handover replaces what the new instance had | Q6 |
| `reload-steer-no-takeover-playback` | As `reload-steer-no-takeover` | the steer test, on all three builds |

Q3 now pins the handover merge for a prompt taken after the old instance's
cleanup but before the new one read any of the session's events (a prompt
while the old instance still runs is Q5's shape). `adopt-execution-unread`
(the handover's execution taken by an instance that reads neither text nor
turn id) survives every test: such an entry changes only what a later
handover counts as running. It is guarded in the code. `unlinked` is cleared
at cleanup.

After this round the full `verify-mutations.mjs` run on 2.0.17 killed 140 of
140, every file restored byte for byte. The three running-reload tests and
the steer test passed 10 runs of 10 on each of 2.0.17, 2.2.6 and 2.3.0, with
no re-drive.
### Second review round (2026-11-17)

- **A reload that adds hooks reading the turn's fields** still gave a
  steered prompt's id to a later execution: the old instance, whose hooks
  read no fields, tracked no execution, so the new one found nothing to take
  over and kept the steered id. Both reviewers reproduced it, in a unit test
  and live on 2.0.17, 2.2.6 and 2.3.0. Every instance now tracks the start
  and end of each execution it sees, whatever its hooks; text and prompt ids
  are still kept only where a hook reads them. A copy without a prompt id
  then drops the steered id: missing, never wrong. The `adopt()` guard on
  reading hooks is gone with it, as is the `adopt-execution-unread` mutant it
  needed. Q7 pins it; it fails on `105f6347` with the continuation's stop
  carrying `msg_steered`. No drive covers it: the playback hooks are built
  once per drive with every field they can read.
- **The copy comes from the newest other instance** that runs the
  execution, not the oldest (Q8, three instances).

| Mutant | Defect | Killed by |
| --- | --- | --- |
| `reload-tracking-only-when-read` | Executions are tracked only where a hook reads text or turn ids | Q7 |
| `reload-steer-copies-oldest` | The oldest instance's execution is copied | Q8 |

`subagent-late-turn-id`'s anchor moved by one indentation level and was
re-anchored. The residual is a reload that adds the first subscribing hook:
the old instance has no subscription and tracks nothing, as before #236.