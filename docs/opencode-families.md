# OpenCode version families

The `opencode` target selects its implementation from your configured version
range. New configurations recommend v2. An existing explicit v1 target keeps
the v1 implementation even if your installed CLI is v2.

Use `hooknostic inspect opencode --version <range>` to inspect a specific
family. Supported ranges and exact capture baselines are generated in
[Harness support](harness-support.md). V2's npm package is `@opencode/cli`;
v1's is `opencode-ai`.

One output targets one family. To produce both, configure two named targets
with `adapter: "opencode"`, each using that family's supported range and a
distinct output directory. A range spanning both families is rejected with
HN203. Live `project.root` integration permits one family per repository,
because both activate the same native paths. After changing an existing project target, run `hooknostic sync` and
restart the affected OpenCode session so it loads the new artifact.

Both families report `tool.shell.dialect` from the shell OpenCode itself states
before a call, not from the tool name or the platform: OpenCode runs whatever
its `shell` setting, `SHELL` or `PATH` selects. It is `posix` for bash and zsh,
`powershell` for either PowerShell, `cmd` for cmd, and absent for any other
shell and until the harness has stated one
([Decision 0029](decisions/0029-shell-dialect.md)).

V2 currently verifies prompt observation/blocking, shell observation/blocking
and rewriting, model-visible tool output replacement, ordinary/title/generation/
compaction context injection, compaction lifecycle, ask-only permission denial,
successful/failed/interrupted execution completion, skills, local stdio MCP
and remote Streamable HTTP. Context
coverage and output conversion are explicitly approximate; inspect shows the
details. The first server-created session can precede plugin setup; session-start
observation is approximate for this reason. Permission evaluation lacks tool
identity/input: use `raw` for its action/resources, or `tool.before` for tool
guards. Only pending ask decisions are intercepted. Stop prevention and
notification are approximate: both are admitted with `session.synthetic` after a
succeeded execution of a top-level session, prevention with `resume` and a
notice without it, and both become user-role messages the model reads. A notice
starts no execution, and nothing shows it until the session next runs. Failed
and interrupted executions and subagent children post nothing, and there is no
`stop_hook_active` flag, so a hook that always prevents loops. Up to OpenCode
2.2.7 a subagent runs in the foreground by default; from 2.3.0 it always runs
in the background. With a background child one prompt can end in several
top-level stops: the parent can finish before its child, and the child's
result then starts another parent execution. That execution reports
`turn.stop` without `correlation.turnId`, receives any pending notice, and is
subject to prevention like any other. Prevention does not wait for a running
child. All of this was observed on 2.3.0. Before 2.3.0, a child given the
tool's opt-in `background` argument was probed on 2.0.17 and 2.2.6 for
`agent.stop` and the `run` cut-off: when it finished after its parent, its
result also started another parent execution, reporting `turn.stop` without
`correlation.turnId`. Notice and
prevention timing with such a child were not probed there.
[Capture](../.capture/opencode-v2-audit/README.md).

V2 reports a subagent's start as `agent.start` and its finish as `agent.stop`
(validated on 2.0.17, 2.2.6 and 2.3.0). Both are reported under the parent:
their `session.id` and `correlation.parentAgentId` are the parent, `agent.id`
and `correlation.agentId` the child, and `agent.type` the agent the child was
created with.

`agent.start` comes from the child's `session.created`, seen in the plugin's
own location, and is dispatched just before the child's own `session.start`.
It is observe-only and asynchronous. By then the child exists and its own
`prompt.before` has already run, and the dispatch is not ordered with the
parent's `tool.after`, which for a background child carries the launch
notice. To stop a subagent from starting, block `tool.before` for
`kind: "agent"`. A follow-up to an existing child (the subagent tool's
`sessionID`) creates no session and starts nothing.

When a recognized child succeeds or fails, its own `turn.stop` fires first,
under the child's session id, and `agent.stop` follows under the parent's,
with `lastMessage`, when a hook declares it, holding the child's last text. A
`turn.stop` hook therefore also runs for each child. The child's `turn.stop`
carries `correlation.agentId` (the child) and `correlation.parentAgentId` (the
parent), as on Copilot; a top-level `turn.stop` carries neither. On Claude, by
its hook documentation, a subagent's stop is a `SubagentStop` and not a
`Stop`. `agent.stop` is observe-only: the child's result has already gone
back to the parent, or been queued for it, so prevention and notices are
unsupported and nothing is posted. Each completion dispatches, so a follow-up
to the same child reports again with the same `agent.id`. An interrupted
child is not reported as `agent.stop`.

A child is recognized when the plugin saw its `session.created`. When it did
not, the child is still recognized once its next prompt reaches this plugin
instance: the prompt hook looks up its parent with `session.get`, without
holding the prompt. This covers a follow-up to a child after a plugin reload,
and a child created through the API before lazy plugin setup (2.2.6 and
later; 2.0.17's API dropped the `parentID`). Such a child reports `agent.stop`
and its agent ids, and takes no stop prevention or notices, but reports no
`agent.start`. Only that child's own completion waits for the lookup, at most
2 s. A lookup that fails, times out or finds no parent in this location leaves
the child as an ordinary session. Still not recognized:

- A background child still running when the plugin reloads. Its prompt went
  through the old instance, and on 2.3.0 that instance was disposed before
  the child completed, so neither its `turn.stop` nor its `agent.stop` was
  reported (observed). Looking it up from the event subscription instead
  would report it twice on builds whose old instance still handles it.
- A child in another location. This was not reproduced: subagent children
  took the parent's location in every capture, and on 2.2.6 and 2.3.0 an API
  child created for another location was put in the parent's.

On 2.0.17 a plugin reload while an execution runs leaves the old plugin
instance alive, and both instances then dispatch that session's later stops
(observed; a recovered child's `agent.stop` is duplicated too). De-duplication
across instances, and recovering a child still running across a reload, are
tracked in [#236](https://github.com/roryeckel/hooknostic/issues/236).

Before 2.3.0 a subagent runs in the foreground by default. With the tool's
opt-in `background` argument, a child still running when
`opencode run --standalone` exits is cut off and reports nothing: observed on
2.0.17, while 2.2.6 waited for the same child.
[Capture](../.capture/opencode-v2-audit/README.md). Legacy SSE
remains unsupported. SSE receives no fallback
GET after a failed POST in the captured baseline. Default MCP OAuth discovery,
PKCE and refresh are verified against a local issuer through project and packed
delivery. Provider OAuth and custom OAuth options remain unverified. Context
coverage includes OpenAI-compatible, Anthropic Messages and OpenAI Responses
over HTTP; WebSocket and other providers remain unverified. V1 retains its own
capability matrix.

V2 reads `.opencode/plugins` from every ancestor of the session directory and
keeps the outermost copy of a plugin id, so a checkout nested in another, such
as a linked worktree inside the main checkout, would otherwise run the outer
checkout's generated hooks and MCP servers. Project wiring therefore gives each
checkout's modules their own id and serves a session only from the copy that
owns the nearest `.hooknostic/integration.json`. The plugin event subscription
also delivers every location's sessions, so session-start, turn-stop and
compaction-after hooks dispatch only for sessions created in or prompted
through the plugin's own location.

A one-shot `opencode run` exits as soon as the session is idle, and neither
family's host waits for a turn-stop hook on its own. On v1 the generated plugin
returns `dispose`, which the captured build awaits before it exits. Whether
earlier supported v1 builds call and await it is unverified; they may still
cut off in-flight hooks at idle. When called, it waits for the hooks still
running, for up to their timeouts plus one 10 s host round trip, 15 s at most,
so `run` can take that much longer to return. On v2, hooks run in the
server process. Through the background service they finish there after `run`
returns. `run --standalone` terminates its private server without calling plugin
cleanup, so a hook still running then is cut off.
[Capture](../.capture/opencode-dispose/README.md).

Both families report a failed handler on `console.error` and let the call
through. On v2 that report was visible only under
`opencode run --standalone --print-logs` on the builds measured; the TUI and the
background service are unmeasured.
[Capture](../.capture/opencode-v2-plugin-stderr/README.md).

Both families also fail open on the shim's own internal errors, and report
each one on `console.error` as
`hooknostic internal [<native hook>]: <message>`. On v1 a throw is how a block
is delivered, so an internal error that escaped would deny the call; only
deliberate blocks are rethrown. The best-effort posts (prompts, toasts,
permission replies) stay silent no-ops when they fail. Whether the v1 TUI
shows the report is unmeasured.

On v2 the shim guards every callback, because the v2 host fails closed on any
error a plugin throws, in one of two ways. A throw from a
tool or permission callback denies the call, and the model sees the message
as the tool's error. A throw from a prompt, context, generate or compaction
callback fails the request instead: the run exits 1, the execution or
compaction fails, or the endpoint answers 500. So the shim catches every error
of its own, reports it, and lets the call proceed as if no hook had run. Like
the handler-error report, it was visible only under
`opencode run --standalone --print-logs`. A deny that cannot be applied leaves
the host's own permission evaluation in place. Only deliberate blocks still
throw. [Capture](../.capture/opencode-v2-plugin-throw/README.md).

Typed tool failures support approximate `tool.error` observation: a missing-file
read is captured, while a plain exception from a custom tool bypasses the native
after callback. Text and object output replacements reach the model, with objects
serialized as JSON text. A native companion TUI probe delivers a server RPC toast
and cleans up on exit; a generated user-only notification remains follow-up
work. [Audit procedure and limits](../.capture/opencode-v2-audit/README.md).

Package output includes a v2 default plugin definition. Hooks-only,
components-only and combined packages use the same family-specific loader
contract. Runtime dependencies must be bundled or explicitly materialized;
the adapter does not install them. Package relocation is tested using a
packed tarball and a dependency-free MCP fixture.

V2 also verifies loading a scoped npm coordinate from a read-only loopback
registry serving that tarball. This exercises OpenCode's own resolution and
cache installation, including generated hooks, skills and local MCP.

A host that launches OpenCode with its own configuration layer can switch a
server off by name. Hooknostic leaves such an entry alone rather than replacing
it, on both families: v2 reads the normalised entry's `disabled` flag from the
MCP editor, v1 reads `enabled` from the config hook. The disabled server never
starts, and the other projected servers, copied skills and generated hooks are
unaffected. A same-named entry the host left enabled is still replaced, which
is the ADR-0015 default. [Capture](../.capture/opencode-disabled-mcp/README.md).

Tool classification covers captured file read/write/edit/glob/grep, webfetch,
websearch and subagent names; shell normalization includes `workdir`. Websearch
coverage is limited to admission. A subagent runs in a separate session. Up to
2.2.7 it runs in the foreground by default, and `tool.after` carries its result.
From 2.3.0 it always runs in the background, as it did on 2.0.17 and 2.2.6
when given the tool's opt-in `background` argument: `tool.after` fires as the
child starts and carries a launch notice (`raw.event.result.output.status` is `running`), and the
child's result reaches the parent later as a user-role `<subagent>` message that
no tool hook reports. In both cases the child's completion is reported as
`agent.stop`, whose `lastMessage` carries the child's last text. Code Mode MCP
calls emit both the outer `execute` and an inner native tool hook. Both remain
`kind: "other"` because reliable MCP identity normalization is not implemented;
hooks matching `kind: "mcp"` do not cover those calls. Raw inputs and names
remain available. Native and injected skill calls and a local MCP call have
also delivered their content to recorded model requests.

### Guarding a known MCP tool

V2 registry metadata does not resolve the MCP identity gap: a custom tool can
share a connected server's namespace. Do not infer ownership by splitting its
name or joining namespace and server lists. For a native name established by
your hook capture, use the SDK's explicit matcher:

```ts
hook("tool.before", {
  id: "deny-known-native-tool",
  match: { nativeName: "hooknostic_hooknostic_echo" },
  capabilities: { block: "required" },
  run() {
    return block("This tool is disabled.");
  },
});
```

Import `hook` and `block` from `@hooknostic/sdk`. The name above belongs to the
capture fixture; replace it with the exact observed name in your installation.
It is harness-specific and deliberately does not claim MCP ownership.
Playback proves this matcher blocks the inner Code Mode call before the MCP
server receives `tools/call`, while an unrelated custom tool in the same
namespace still completes. [Probe and limitations](../.capture/opencode-v2-mcp/README.md).

## Validation

After bundling, run `packages/cli/test/harness-playback.test.ts` for v1 with
`HOOKNOSTIC_PLAYBACK=opencode-v1`, or
`packages/cli/test/opencode-v2-playback.test.ts` for v2 with
`HOOKNOSTIC_PLAYBACK=opencode-v2`. The installed binary must match the lane's
reference version unless an explicit playback-version override is supplied.
`HKN_OPENCODE_BINARY` can name a native v2 executable on Windows.

The scheduled watcher follows both npm coordinates and maintains separate
rolling records. The old automation selector `opencode` remains a v1 alias.
V2 drift capture supports the free playback transport; its paid transport
currently reports an explicit inconclusive outcome.
