# OpenCode v2 capture

Question: which portable hook channels survive the v2 plugin API change?

Run `node --experimental-strip-types .capture/opencode-v2/drive.mjs <effect>`
from the repository root. Set `HKN_OPENCODE_BINARY` to the native executable
on Windows. Each run creates a fresh OS-temp directory printed to stdout,
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
`subagent`, `project-oauth` and `package-oauth` drives are described in
`../opencode-v2-audit`. They extend the initial coverage above without changing
the earlier captures. They establish typed tool errors, richer replacement
delivery, native server-to-TUI toast delivery, two additional HTTP provider
paths, foreground subagent execution, and default MCP OAuth with refresh.
A generated user-only notification, WebSocket/provider OAuth, search execution
and SSE remain outside verified support.

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

`promote-stops.mjs <stop-root>` promotes the child `session.created`, the
user-interrupt completion and `stop-audit/outcomes.json`. The `stop-*` mutants
in `verify-mutations.mjs` remove the success gate, the child gate, the notice's
`resume: false`, notice ordering, per-post fail-open and the per-session event
queue; each fails its unit or playback test.

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
