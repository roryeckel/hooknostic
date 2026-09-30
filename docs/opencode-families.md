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
`stop_hook_active` flag, so a hook that always prevents loops. Legacy SSE
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

Tool classification covers captured file read/write/edit/glob/grep, webfetch,
websearch and subagent names; shell normalization includes `workdir`. Websearch
coverage is limited to admission. A foreground subagent now completes
with a separate session and returns its result to the parent. Code Mode MCP
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
