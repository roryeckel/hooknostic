# OpenCode v2 capture

Question: which portable hook channels survive the v2 plugin API change?

Run `node --experimental-strip-types .capture/opencode-v2/drive.mjs <effect>`
from the repository root. On Windows the driver runs the native executable
behind the file `runProcess("opencode")` launches, found by cross-spawn's PATH
lookup (`resolveNativeExecutable` in `packages/cli/test/harness-playback.ts`): a
native `.exe` runs directly, and an npm (`%dp0%`) or pnpm (`%~dp0`) `.cmd` shim
runs the one `.exe` it names. Any other first match, such as a `.bat` or a
Node-script shim, fails rather than being skipped. Only when PATH has no
`opencode` does it fall back to the npm global root; `HKN_OPENCODE_BINARY`
overrides all of this. Under
`HOOKNOSTIC_PLAYBACK=opencode-v2` the driver fails with "opencode-v2 playback
binary mismatch" unless that binary reports the expected build
(`HOOKNOSTIC_PLAYBACK_VERSION` or `referenceVersion`): a global 2.2.5 once
shadowed an isolated 2.0.17 on PATH and surfaced only as an unexpected
custom-tool error (issue #151). `verify-mutations.mjs` treats that failure as
an unexercised mutant, never a killed one. Each run creates a fresh OS-temp directory printed to stdout,
containing `result.json`, `captured/events.jsonl`, and the scratch project.
The driver strips model credentials, redirects all four XDG homes, and uses
`run --standalone` with the loopback model server. It does not use the user's
background service. The model replies are constructed; hook payloads are live.

## Observations (Windows, 2.0.17, 2026-09-26)

| Probe | Observable result |
| --- | --- |
| observe | Three model requests, original marker written, callbacks captured |
| rewrite | Replacement marker contains `rewritten`; original marker absent |
| block | Original marker absent; tool failure delivered to model |
| output | Replacement content appears in next recorded model request |
| context | Injected system text in all three requests, including title |
| permission | Changing evaluation effect to deny prevents command execution |
| block-prompt | Exit 1, zero model requests, no tool execution |
| fail | Shell exit 17 is a completed tool result, not an error callback |

An initial rewrite using `echo text>file` printed the redirection literally
on this Windows shell path. The marker probe therefore uses a Node file-write
command. Only the latter run establishes filesystem-effect delivery.

The installed `@opencode/plugin` 2.0.17 implementation makes `Plugin.define`
an identity function. The probe uses its structural definition (`id`, `setup`)
without bundling the SDK; successful loading verifies this entrypoint live.
Permission evaluation also runs for already-allowed actions, so its occurrence
alone is not evidence of a portable permission request. The later ask-only
audit in `../opencode-v2-session` establishes the supported subset.
Ordinary run teardown did not produce a cleanup
record, so automatic host cleanup is not claimed from these captures.

The follow-up session audit establishes generation, compaction and failed/
interrupted completion. Persistent-session stop prevention and notification
are established by the `stop` drive below. Captures establish the
OpenAI-compatible provider path only; no paid smoke was run.

## Component and packed-output probes

`components` observed an injected skill and native `.agents/skills` entry,
and a local MCP server reaching connected status. `package` builds the
combined example with its server body replaced by the repository's
dependency-free MCP fixture, packs the generated output using pnpm, installs
the local tarball offline with npm in a different directory, and loads its
installed package by absolute path. The combined and components-only packages
carry the scoped coordinate `@hooknostic-probe/v2`.
The package's skill is listed under `combined-example/greet`, its MCP server
connects, and its generated hook rewrites the shell marker. The dependency
substitution is constructed probe infrastructure; it is not evidence that
OpenCode installs an author's missing dependencies. `package-components`
exercises the same route without a hook artifact.

Windows still discovers compatibility skills under the actual user home even
with redirected HOME/USERPROFILE and XDG paths. Probes never call those skills;
all model replies are scripted. Only scratch state is written.

## Host-disabled projected servers (2.0.17 and 2.2.0, 2026-11-03)

`project-components-host-disabled` projects two stdio servers (`greeter` and
`other`), then launches OpenCode with an `OPENCODE_CONFIG_CONTENT` layer that
declares `greeter` as a remote server with `enabled: false`. `greeter`'s startup
witness is never written, `other`'s is, the copied `greet` skill is listed and
the generated hook still rewrites the marker. `project-components-host-enabled`
is the control: the same layer declares `greeter` enabled at its own URL, and
the projection still replaces it, so `startup.json` is written.

What the v2 MCP editor reports for such a host entry — and what the v1 config
hook receives — is recorded in
[`../opencode-disabled-mcp`](../opencode-disabled-mcp/README.md). The guard's
mutants are `host-disabled-guard`, `host-disabled-inverted`,
`host-disabled-presence` and `host-disabled-playback` in
`verify-mutations.mjs`.

## Timeout diagnostics

The driver prints its scratch root before setup and records each setup/native
phase in `phases.jsonl` and `current-phase.json`. Package-manager phases include
the command, arguments and working directory. Their stdout/stderr and the native
run's output are written as they arrive, so a parent test timeout cannot discard
the last output. Loopback model, remote MCP and registry observations are also
snapshotted once per second while the harness runs.

Set `HKN_PLAYBACK_ARTIFACT_DIR` to collect each drive's fresh scratch directory
under one parent. CI does this for playback and uploads phase logs, subprocess
output, generated package inputs and capture observations when either OpenCode
v2 lane fails. Dependency trees and isolated user homes are excluded. An
unfinished `started` phase identifies where an externally killed driver stopped;
an ordinary exception records `failure.json` with that phase and its stack.


`project-components` exercises generated project integration, including the
native wrapper, skill copy and MCP launcher. The stdio command is the portable
ambient `node`; an initial absolute Node path was rejected by the portable
loader and established no MCP behavior. Loader warnings now fail the probe.
`package-hooks` separately exercises a packed hooks-only artifact.

`lifecycle` starts a private loopback `serve --stdio` process with a throwaway
password, sends prompts in two distinct sessions around `/api/location/reload`,
and terminates the process in a finally block. The capture records two setups,
one cleanup, and exactly one prompt callback per session. Generated portable
hooks also record two prompts. The first server-created session precedes lazy
plugin setup, so its `session.created` event is missed; later sessions are
observed. Session-start support is therefore approximate.

The lifecycle probe separately calls the generation and compaction APIs and
records their callbacks and requests in `lifecycle.json`, with separate context
markers and successful-summary assertions documented in the session audit.
Normal abrupt process termination is still not evidence of host cleanup.


Regression verification: `node .capture/opencode-v2/verify-mutations.mjs`
(with the native binary override on Windows) removes family selection, raw
payload preservation, disposal, effect application, MCP registration, reload,
lane separation and unknown-tool drift handling in turn. Each relevant test
failed; originals were restored byte-for-byte after every mutant. The named
output regression also fails when the old global duplicate-project guard is
restored. Run `pnpm run bundle` first.


The generated project/packed server writes a startup record. Playback asserts
its marker environment variable, expanded plugin root, and working directory
(project source root, or relocated package `src`). This checks the actual
child process rather than only the emitted MCP configuration.
The initial generation and compaction probes exposed missing generated context
and a rejected compaction summary. The completed audit now verifies each route
and summary success: see `../opencode-v2-session`. Remote transport captures
and generated delivery checks are in `../opencode-v2-remote`.

## Broader tools and npm coordinates (Windows, same version/date)

`tools` uses the constructed `tool-model.mjs` loopback responses to drive
write, read, edit, glob, grep, shell with an explicit working directory,
webfetch from loopback, native and injected skills, and the local MCP fixture.
File contents, recorded model requests, tool results and the generated hook
trace establish execution and classification. Search and subagent attempts
are captured and deliberately blocked before execution: only their names and
input envelopes are established. The initial exploratory run had its blocking
guard in the wrong callback; the corrected run supplies the committed fixtures.

The shell reports the explicitly selected directory containing a space.
Native skills load by their directory ID (`native`), distinct from their
authored name (`hooknostic-native`). Both native/injected instructions and the
MCP sentinel reach recorded model requests. The MCP call uses Code Mode's
`execute`; hooks observe both the outer tool and an inner
`hooknostic_hooknostic_echo` invocation. The initial inspection missed the
inner pair; comparison against the complete capture exposed it. Both pairs
are now fixtures and playback assertions. The envelopes contain no MCP
discriminator; both remain `kind: other`, and arbitrary underscore/dot names
are not inferred to be MCP. File tools, webfetch, websearch and subagent use
existing SDK kinds. Reliable MCP identity normalization remains follow-up work.

`package-registry` serves an actual `pnpm pack` tarball through `registry.mjs`,
a read-only loopback npm protocol fixture. The generated config names the
scoped npm coordinate, not a filesystem path. OpenCode fetches the manifest
and tarball and loads the installed package from its isolated cache. Generated
hooks rewrite the shell marker; the skill is registered; the MCP startup
record confirms the relocated root, environment and cwd. All registry requests
are GETs. There is no publication, and this probe does not establish installing
an author's dependency closure. Local-path relocation probes remain separate.

New regression mutants: `tool-kinds`, `shell-cwd`, `outer-boundary`,
`tool-playback`, `registry-loading`. Pass these names to `verify-mutations.mjs`
to run only this increment's checks after bundling.

## Remaining-capability audit

The later `results`, `notifications`, `provider-anthropic`, `provider-responses`,
`subagent`, `subagent-late`, `subagent-fail`, `subagent-followup`,
`subagent-opt-in`, `project-oauth` and `package-oauth` drives are
described in `../opencode-v2-audit`. They extend the initial coverage above
without changing the earlier captures. They establish typed tool errors, richer
replacement delivery, native server-to-TUI toast delivery, two additional HTTP
provider paths, foreground subagent execution (background from 2.3.0, where
`subagent-late` makes the child finish after its parent), and default MCP OAuth
with refresh.
A generated user-only notification, WebSocket/provider OAuth, search execution
and SSE remain outside verified support.

The user-only notification question was answered for session start on
2026-10-30 (2.0.17 and 2.2.0, `../opencode-notice`). A **server-only** plugin
has no `ctx.ui` or `ctx.attention` at runtime. Its RPC event reaches the event
stream, but no built-in TUI renders it, whether local or attached to `serve`.
`session.synthetic` with `resume:false` at `session.created` was not rendered
and reached the model with the next prompt. Only the companion `./tui` route
renders a notice: `notifications` re-ran green on 2.2.0.

## Stop prevention and notification

`stop` drives a private `serve --stdio` server, because a posted continuation
needs a session that outlives the stop. The generated playback hook prevents
each session's first `turn.stop` and notifies on later ones. Four sessions run
in turn: a shell turn, a user interrupt of a pending request, a model HTTP 400,
and a parent that delegates one task to a `general` subagent child.

After the first succeeded execution, `session.synthetic` with `resume` started
exactly one more execution, and its request carried the stop reason as a
user-role message. The later notice (`resume: false`) started no execution and
appeared in no request until the next user prompt, whose request then carried
it as a user-role message. The interrupt (`reason: "user"`), the failure and
the child each completed exactly once. The child's `session.created` carries
the parent's ID as `parentID`. Six real prompts produced six `prompt.before`
dispatches: `session.synthetic` does not run the prompt hook. No `session.idle`
event was published at any point. Every completion still dispatched
`turn.stop`: eight in total.

The same scenarios were repeated against `deepseek-v4.1-flash` on Ollama Cloud
(a paid model, run once at the owner's request, not a committed drive) with the
same execution counts; the model quoted the notice once the next prompt ran. In
the real TUI (`--standalone`), the notice was enqueued in the session inbox as
a synthetic item, started no execution, and was not rendered during two idle
minutes: a notice is deferred to the session's next run.

A detached `session.synthetic` call also succeeded, so no receiver requirement
is claimed.

**From 2.3.0 the child runs in the background** (Windows, 2026-11-16,
`../opencode-v2-audit`). Its result reaches the parent as a user-role
`<subagent>` message instead of the tool result. If the result arrives after
the prevention continuation has ended, it starts a third parent execution,
which no prompt hook started: it dispatches `turn.stop` without a turn id, and
the earlier notice reaches the model in its request. Prevention does not wait
for the child. So one prompt can end in several top-level stops. The stage now
waits for the child's own success and then for an idle parent, rather than for
two parent completions, and records the launch status and the requests that
carry the `<subagent>` message. Playback accepts the one extra parent execution
and stop on 2.3.0 and later only. To check the stage against a late child, set
`HKN_CHILD_DELAY_MS` (constructed timing; 6000 was used) before
`drive.mjs stop`. 2.2.7 kept the child in the foreground with the same delay.

`promote-stops.mjs <stop-root>` promotes the child `session.created`, the
user-interrupt completion and `stop-audit/outcomes.json`. The `stop-*` mutants
in `verify-mutations.mjs` remove the success gate, the child gate, the notice's
`resume: false`, notice ordering, per-post fail-open and the per-session event
queue; each fails its unit or playback test.

The stage's child also dispatches one `agent.stop`, under the parent, after
its own `turn.stop` (#231). The playback hook prevents once per event and
session, so that `agent.stop` does not use up the parent's own `turn.stop`
prevention: keyed by session alone, the parent's first stop was never
prevented and the drive timed out. The shim posts nothing for `agent.stop`,
so every count above is unchanged.

## Subagent completion as agent.stop (#231)

Question: when did OpenCode v2 first expose what `agent.stop` needs, and what
does a plugin see when a subagent child finishes?

Every signal predates the adapter. The first supported build, 2.0.17, was
published on 2026-09-25 and the adapter added on 2026-09-26; dates are the
npm registry's publish times.

| Signal | First seen | Evidence |
| --- | --- | --- |
| The child's own `session.execution.started`, `session.text.ended` and `session.execution.succeeded` or `failed`, on the plugin's event subscription | 2.0.0 (2026-09-11) | Loopback drives on 2.0.0 and 2.1.4 with the opt-in `background` argument (out of range, so not profile records, ADR-0008); `fixtures/opencode/2.0/subagent-stop` on 2.0.17 and 2.3.0 |
| The parent/child link: `session.created` `parentID` and `agent`, and the subagent tool result's `sessionID` | 2.0.0 | The same drives; `session-created-child` on 2.0.17 |
| The parent's `session.inbox.enqueued` item, `metadata { source: "subagent", childID, agent, state }` | 2.0.0 for an opt-in background child; every child from 2.3.0 | The same drives; `subagent-background/inbox-subagent-completed.json` on 2.3.0. 2.3.0 dropped the event's `location` |
| The child's last text, from its `session.text.ended` | 2.0.0 | The same drives |

Two later changes matter. From 2.3.0 every subagent runs in the background
(above and `../opencode-v2-audit`). And `opencode run --standalone` waits for
a background child on 2.2.6, where it did not on 2.0.17 (below). Release
notes date that change to 2.2.6. The builds between were not probed.

The shim therefore remembers each child's `parentID` and `agent` from its
`session.created`, in the plugin's own location. When that child's own
execution succeeds or fails, it queues the child's `turn.stop` as before and
then `agent.stop` in the same per-session queue. `session.id` and
`correlation.parentAgentId` are the parent, `agent.id` and
`correlation.agentId` the child, and `agent.type` its agent. `lastMessage` is
the child's buffered text, and is buffered only when a hook declares it. The
inbox item is not used: it exists only for background children. Nothing is
posted for `agent.stop`. The child's result has already gone back to the
parent, or been queued for it, and a post under the parent's id would steer
the parent.

What was probed, each on Windows with isolated state and the loopback model
(constructed replies, no paid model):

- `subagent` on 2.0.17 (foreground) and 2.3.0 (background): the child's
  `turn.stop`, then one `agent.stop` with every field. Promoted with
  `promote-audits.mjs subagent-stop <2.0.17-root> <2.3.0-root>`.
- `subagent-late` on 2.3.0: the same order when the child outlives the
  parent's first execution.
- `subagent-fail`: the child's model request answers HTTP 400, so it fails
  within seconds (a 500 is retried for about 90 s). One `agent.stop`, with no
  `lastMessage`, on 2.0.17 and 2.3.0.
- `subagent-followup`: a second `subagent` call sends a follow-up to the same
  child by its `sessionID`. Two `agent.stop`s, same `agent.id`, each with its
  own execution's text, on 2.0.17 and 2.3.0.
- `subagent-opt-in`: the opt-in `background: true` argument on 2.0.17 and
  2.2.6. On 2.0.17, a child that finished while `run` was still going
  dispatched `agent.stop`, and its result started a second parent execution
  without a turn id. With `HKN_CHILD_DELAY_MS=3000` (constructed timing,
  unset by default), `run --standalone` exited first: the child only started,
  and neither its `turn.stop` nor `agent.stop` dispatched. 2.2.6 waited for the
  same late child, and its result started a second parent execution.
- `stop` on 2.0.17, 2.2.6 and 2.3.0, and with `HKN_CHILD_DELAY_MS=6000` on
  2.3.0: one `agent.stop`, and every other count as before.

Not probed, and not claimed: a child created before plugin setup or in another
location (recognizing one would need a `session.get` lookup), an interrupted
child, a 2.3.0 inbox item whose `state` is not `completed`, the opt-in
`background` argument on builds other than 2.0.17 and 2.2.6, and deeper
nesting. A child created before plugin setup or elsewhere dispatches no
`agent.stop`, and an interrupted child dispatches only its own `turn.stop`.
`agent.start`, agent ids on the child's own `turn.stop`, and the `session.get`
recovery are #232, below.

## Subagent start, agent ids and recovery (#232)

Three additions on top of #231, all from signals the subscription and the
plugin context already carry.

**`agent.start`.** The child's `session.created` (with `parentID`), seen in
the plugin's own location, is also the subagent's start. The shim queues
`agent.start` under the parent, then the child's own `session.start`, in the
child's queue, so the agent's lifecycle encloses the child session's. Every
field comes from that one event, so `agent.id`, `correlation.agentId`,
`agent.type` and `correlation.parentAgentId` are rated `exact`. The event is
`approximate` because it is asynchronous: in every drive the child's own
prompt hook ran before its `session.created` reached the subscription, so the
child's `prompt.before` precedes `agent.start`. The dispatch is not ordered
with the parent's `tool.after`: a background child's launch notice can come
first or second. No vocabulary change: the subagent tool's `description` is
`raw.event.data.title`, and its prompt is the child's own `prompt.before`.

**Agent ids on the child's own `turn.stop`.** The child's completion now
carries `correlation.agentId` (the child, `exact`: the completion's own
`sessionID`) and `correlation.parentAgentId` (the parent, `emulated`:
remembered or looked up). This is the shape of Copilot's captured
`turn-stop-subagent`. The runtime does not strip undeclared fields
(ADR-0027 rates them), so every `turn.stop` hook sees them; a top-level
`turn.stop` has neither.

**Recovery (`session.get`).** Any session whose `session.created` this
instance never saw is looked up when its prompt reaches this instance's
prompt hook, and only there. That is not only a child: a top-level `serve`
session created before lazy setup, and every existing session's first prompt
after a reload, are looked up too. The lookup is not awaited by the prompt.
Only that session's own completion waits for it, in its own queue, at most
2 s (about 0.5 ms measured), so a top-level session's `turn.stop` can wait as
well. Cleanup's abort settles a pending lookup at once, so disposal never
waits on it. A lookup that throws, times out, or returns no `parentID` or
another location leaves the session as before, silently. A recovered child is
stored as a known child, so it also takes no stop prevention or notices.

The procedure is `../opencode-v2-audit/session-get` (`probe.mjs` runs `serve`
with only a probe plugin, which calls `ctx.session.get` from the prompt hook
and from the subscription and records each instance's view). Windows,
isolated state, loopback model, 2026-11-16:

| Scenario | 2.0.17 | 2.2.6 | 2.3.0 |
| --- | --- | --- | --- |
| `reload-followup`: idle reload (old instance disposed), then a follow-up to the same child | The new instance sees the child's prompt and completion, never its `session.created`; the lookup at the prompt returns the parent | same | same |
| `api-child-presetup`: `POST /session {parentID}` before any prompt, so before lazy setup, then a prompt to the child | The API dropped `parentID`: not a child | Missed `session.created`; the lookup returns the parent | same as 2.2.6 |
| `reload-mid-child`: reload while a child runs (its reply 4 s late) | The old instance is never disposed (8 s after everything ended) and handles the child; the new one also receives every later event | The old instance handles the child's completion, then is disposed | The old instance is disposed before the child completes; the new one sees only the completion, with no prompt: a miss |
| `reload-mid-child-then-followup` | After the follow-up both instances dispatch the parent's and the child's stops | old instance disposed; no duplicates | old instance disposed; no duplicates |
| `otherloc-both`: API child with `parentID` and another `location` | Location kept, `parentID` dropped | Put in the parent's location | Put in the parent's location |

`ctx.session.get` was a function on all three builds and returned the
stored record itself (not `{ data }`), with `parentID`, `agent`, `location`
and `title` for a child. An unknown id rejected with
`Session.NotFoundError` in under 1 ms. Over every lookup in those runs, from
the prompt hook and from the subscription, none hung:

| Build | Lookups | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| 2.0.17 | 48 | 0.5 ms | 1.8 ms | 7 ms |
| 2.2.6 | 42 | 0.5 ms | 2.4 ms | 2.8 ms |
| 2.3.0 | 55 | 0.5 ms | 7 ms | 7.3 ms |

Through the shim, with the generated playback hooks (`drive.mjs`
`subagent-reload`, `subagent-api-child`, `subagent-reload-stop`; playback
tests "after a plugin reload", "created through the API", "takes no stop
prevention"):

- `subagent-reload` on 2.0.17, 2.2.6 and 2.3.0: after the capture plugin's
  `cleanup` record confirms the old instance is gone, the follow-up child's
  `turn.stop` carries both agent ids, and exactly one more `agent.stop`
  follows, with `agent.type` from the lookup. No second `agent.start`. Since
  #236 the old instance hands the child over when it is disposed, so this
  drive no longer needs the lookup; `subagent-reload-restart` and
  `subagent-reload-restart-stop` restart `serve` with the same state instead,
  where only the lookup can recognize the child, and pin the same outcomes on
  every build.
- `subagent-api-child`: the child's `turn.stop` carries both ids and one
  `agent.stop` follows on 2.2.6 and 2.3.0, where the API kept `parentID`. On
  2.0.17 it is an ordinary session. The test branches on the API's response,
  not on the version.
- `subagent-reload-stop` (prevention and notices on every stop), then a
  prompt straight to the child: the child ran exactly three executions and
  none of its requests carried the stop reason or the notice. With the child
  not stored (mutant `recovery-not-stored-playback`) the recovered child's
  stop was prevented and it ran a third execution before the direct prompt.

Not recovered, and not claimed:

- **A child in another location.** Not reproduced: subagent children took
  the parent's location in every capture, and 2.2.6 and 2.3.0 put an API
  child for another location in the parent's. If one occurs, the lookup in
  its own location's instance would cover it.
- An interrupted child (its `turn.stop` carries the ids; no `agent.stop`),
  and agent ids on the child's other events (`tool.*`, `session.start`,
  `prompt.before`).

A background child still running across a reload, and the 2.0.17 reload
leak's duplicates, were listed here as not recovered; #236 covers both
(below).

## Reloaded plugin instances (#236)

A reload while an execution runs leaves two plugin instances in one `serve`
process. The host side, from `.capture/opencode-v2-audit/session-get`
(`probe.mjs` with the probe plugin only, then `instances.mjs`; Windows,
isolated state, loopback model, 2026-11-16):

| Build | Idle reload | Reload while a child runs |
| --- | --- | --- |
| 2.0.17 | the old instance is disposed before the new one is set up | the old instance is **never** disposed |
| 2.2.6 | the same | the old instance is disposed when the execution ends, about 3.9 s after the new one's setup; it hears the child's completion first |
| 2.3.0 | the same | the old instance is disposed **before** the child's completion reaches the new one, and never hears it (8 of 8 runs, 12 to 27 ms) |

Over 17 runs and 187 watched events: every event had an `id`; the 34 ids
both instances heard were heard by the old one first (23) or in the same
millisecond (11), never by the new one first; the new instance never heard an
event published before its setup; and no event the old one heard after that
setup was missing from the new one. On 2.0.17 a new child created after the
reload is seen created by both instances.

Through the shim, with the generated playback hooks (`drive.mjs`
`subagent-reload-running` and `subagent-reload-running-stop`, through
`reload-audit.mjs`). The parent delegates a child that answers 4 s late; the
location reloads while it runs, and the drive waits for the capture plugin's
second `setup`. A fresh top-level session is prompted while both instances
live (`overlap`, asserted). Then the parent follows up the same child, and
delegates a new one. The drive counts completions by distinct event id: on
2.0.17 the leaked old capture instance records every event a second time.

| Playback test | 2.0.17 | 2.2.6 | 2.3.0 |
| --- | --- | --- | --- |
| A session started during the overlap reports once | before: `session.start` twice | before: twice | before: twice |
| Every completion once (parent, the child across the reload, the new child), `agent.start` once per child | before: duplicate stops and `agent.stop`s; the new child's `agent.start` twice | before: the parent's stop after the reload missed | before: the child's `turn.stop` and `agent.stop`, and the parent's follow-on stop, missed |
| Prevention once, never into a child | before: the fresh session's model saw the stop reason twice | before: twice | before: twice |
| A prompt steered into an execution the old instance still runs (`subagent-reload-running-steer`) | before: the child's `turn.stop` without its text or turn id, and the parent's continuation carried the steered prompt's id (2 of 2) | before: the child's `turn.stop` without its text or turn id | before: a later parent stop carried the steered prompt's id (3 of 3) |

The steer drive (review round) prompts the parent and the running child after
the reload, with prevention on; on 2.3.0 the parent's prevention continuation
answers 1.5 s late, so the steered parent execution ends while the old
instance lives (constructed timing). Whether a prompt was steered or started
its own execution is read from the captured events: the session's next
execution event after the prompt is a start or a completion.

With the shim all four pass on each build: 10 runs of the four tests per
build, no re-drive needed (and 10 runs of the first three per build before
the review round). The test drives once more if the
old instance was gone before the fresh session completed (once among the
captured 2.3.0 runs), or if the drive timed out on its transport before the
reload; never for a failed assertion.

Not claimed, or claimed with a limit (see `docs/opencode-families.md`):

- **The order of disposal on 2.3.0** is observed in every capture, not
  promised. Worst case, a build that delivers the child's completion first:
  if the old instance still receives it, it reports it, once; it is missed
  only if the host stops delivering events to the old instance before
  calling its cleanup, and then the new one skips it because it does not
  know the session yet.
- **A second reload** while the newer instance still has work running,
  queued or pending can drop an event the older one would have reported (a
  stop, or a `session.start`, `agent.start` or `context.compact.after`)
  (accepted and documented; #238 records the reasoning; pinned by unit
  tests L1 and L2).
- **Compaction during an overlap,** a prompt the new instance took after
  the handover but before reading the session's events (unit test Q3), and
  a segment both instances buffered around a steered prompt (Q5), a reload
  that adds hooks reading the turn's fields (Q7), and three instances where
  the newest other one's execution must be copied (Q8), are covered by unit
  tests only: no drive reproduces them. The playback hooks are generated once
  per drive with every field they can read, so a drive cannot reload into
  hooks that declare different fields without building a second artifact.
- **A reload that adds the first subscribing hook:** the old instance had no
  subscription, tracked no execution, and a steered prompt's id can still
  reach a later execution, as before #236.
- A server restart, or a reload across two Hooknostic releases: each
  instance reports as before.

## Nested checkouts

`nested` builds generated project wiring into an outer checkout and into
`.claude/worktrees/nested` inside it, each tracing under its own label, then
prompts one session in each location on a single `serve --stdio` server. V2
loaded both checkouts' `.opencode/plugins` for the nested location. With the
shared generated id the outer copy stayed active and the nested copy failed
with `Duplicate plugin ID`, so the nested session ran the outer checkout's
hooks. The plugin instance for the nested location also received the outer
session's `session.created` and execution events and dispatched `session.start`
and `turn.stop` for it; `prompt` and tool callbacks stayed location-scoped.
With per-checkout ids, nearest-integration serving and location filtering, both
copies are active and every dispatch in each location carries that location's
label. The `nested-*` and `location-*` mutants in `verify-mutations.mjs` remove
the serving guard, the id suffix, the components guard and each filter branch.

The distribution example now bundles its MCP server. The package capture driver still substitutes its dependency-free fixture and redirects the MCP argument to that fixture; marketplace registration files are excluded from the source inventory.

## Turn fields

Question: does a v2 plugin see the text of an execution's last assistant message
and the prompt that started it? `session.execution.succeeded` carries only
`{ sessionID }`, and `ctx.session` has no message-list API.

`drive.mjs observe` against 2.0.18 (Windows, 2026-09-28; the driver isolates
HOME, USERPROFILE and all four XDG homes, so a side-by-side OpenCode 1 install
shares no state). The capture plugin's `ctx.event.subscribe` loop recorded, for
the one session: `session.inbox.enqueued` (its `inboxID` equal to the prompt
hook's `messageID`), `session.execution.started`, per model step
`session.step.started` with a fresh `assistantMessageID`, then
`session.text.started`, `session.text.delta` and
`session.text.ended { assistantMessageID, ordinal, text }` for the answer step,
`session.step.ended`, and finally `session.execution.succeeded`. So plugins do
receive `session.text.*`, in order, before completion.

The shim therefore buffers `session.text.ended` per running execution, keyed by
session and reset at `session.execution.started`, and reports the last
assistant message's segments as `turn.stop.lastMessage`. The prompt hook's
`messageID` waits for the execution it starts and becomes
`turn.stop.correlation.turnId`; a synthetic continuation, which runs no prompt
hook, has none, and a prompt admitted while an execution runs is handed to no
later execution. What the shim gathered reaches the decoder beside the
completion envelope, never inside `event.raw`. Both are rated `emulated`, and both are skipped unless a
`turn.stop` hook declares them. Promoted as `fixtures/opencode/2.0/turn-fields`
and `execution-succeeded-with-turn`.
