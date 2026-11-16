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
subagent called with `background: true` before 2.3.0 was not probed; nothing
here says how it behaves.

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
  (#231).

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
| `subagent-background-boundary` | The boundary record's version moved to 2.0.17 | The subagent test on 2.0.17; the late and stop tests too |
| `audit-subagent` (existing) | `subagent` classified `other` | The subagent test on 2.3.0 |
| `subagent-late-turn-id` | The shim keeps a pending prompt id past the execution it starts | The late test on 2.3.0, and the stop test on every build, whose prevention continuation no prompt starts either. The late test alone let it survive before 2.3.0 |
| (manual) | The decoder reads `result.output` instead of `result.content` | The `tool-subagent-background-after` decode case |
| (manual) | The stop drive no longer waits for the child's success | The stop test on 2.3.0 with `HKN_CHILD_DELAY_MS=6000` |

Not probed, and not claimed: a subagent called with `background: true` before
2.3.0, a child that fails or is interrupted, a `subagent` call that sends a
follow-up to a running child by `sessionID`, and deeper nesting.
