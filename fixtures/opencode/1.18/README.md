# OpenCode 1.18 fixtures

OpenCode plugins receive native **callback invocations** in-process, not JSON
on stdin. Fixtures therefore use the adapter's invocation envelope:

```json
{ "hook": "<callback name>", "directory": "<project dir>", "input": { … }, "output": { … } }
```

`input`/`output` shapes are taken verbatim from the published
`@opencode-ai/plugin@1.18.19` `Hooks` type definitions (dist/index.d.ts,
inspected 2026-08-20) and validated against opencode 1.18.18 by the live smoke
test. `*.canonical.json` omits `raw` (tests splice `raw: input-envelope` back
in). `*.output.json` files hold the expected `planOpenCodeApplication` result
(throw/mutation plan), since native application is object mutation rather than
a serialized response.

**One redaction.** The capturing machine's Windows account name is replaced with
`user` throughout — in the envelope's `directory` and in the `cwd` derived from
it. Nothing else was altered: these stay Windows paths with their real drive
letter, backslash escaping, and structure, because that shape is itself evidence
about what the harness sends.

**`system-transform.*` is constructed, not captured.** The paragraph above does not
describe it, so state the difference plainly. Its probe
(`.capture/opencode-context-channel`, opencode 1.18.30) tees a *summary* of each
invocation — callback name, call index, session id, `Object.keys(output)`, and
`output.system` length before and after — rather than the whole envelope, so no
verbatim record of this callback exists to promote into a fixture.

| Field | Provenance |
| --- | --- |
| `hook` | observed (live-probe, 1.18.30) |
| `input.sessionID` | observed present; **declared optional** in the typings |
| `output` having exactly the one key `system` | observed (`Object.keys(output)`) |
| `output.system` being a non-empty `string[]` the harness owns | observed (length 1 before the push, 2 after) |
| `directory` | **constructed** — the conventional fixture path, not a redacted real one |
| `input.model` | **constructed** — type-derived from the `Model` parameter; its contents were never recorded |
| `output.system[0]` text | **constructed** stand-in for the real base prompt, which was never recorded |
| `model-request-before-context.output.json` | **constructed** — an expected `planOpenCodeApplication` result, as every `*.output.json` here is |

So this fixture pins the decode and apply contract, which is what it is for. It is not
evidence about the harness: the live-probe record in
`packages/adapter-opencode/src/profile.ts` and the capture README carry that.

Ground truth notes (1.18.x):

- Local plugins load from `.opencode/plugin/` or `.opencode/plugins/`
  (any `*.ts`/`*.js`; default or named `Plugin`-typed export).
- `permission.ask(input: Permission, output: { status: "ask"|"deny"|"allow" })`
  is typed in the SDK but **never fires** on 1.18.x: the active Permission
  module publishes a `permission.asked` bus event instead of triggering the
  plugin hook (captured live on 1.18.25, `.capture/opencode-permission`;
  upstream anomalyco/opencode #9229). The `permission-ask.type-derived.json`
   fixture is
  therefore **type-derived** (callback envelope from the published Hooks type
  definitions), not captured; `permission-asked` is captured. Denial works
  via `client.postSessionIdPermissionsPermissionId { response: "reject" }`
  (captured live: API answers true, the command does not run, the turn
  halts) — the `permission-asked-deny.output.json` plan records it.
- `tool.execute.before` blocks by **throwing**; rewrites via `output.args`.
- `tool.execute.after` replaces output via `output.output` (string).
- `experimental.session.compacting` exposes `output.context: string[]` and
  `output.prompt` (full prompt replacement).
- Session lifecycle arrives via the generic `event` bus callback
  (`session.created` / `session.deleted` / `session.idle` /
  `session.compacted`); there are no subagent or tool-failure callbacks.

**`tool-{read,write,edit,apply-patch}-before.*` are captured.** Taken from a
real **opencode 1.18.31** session on Windows (2026-09-27) through the tee plugin
(`.capture/opencode-capture`) against the loopback playback model
(`.capture/file-tools`): the envelopes are the harness's own, the argument
*values* are scripted. They pin the file tools' path key (`filePath`), and that
a GPT-like model id (`gpt-5-playback`) swaps `edit`/`write` for `apply_patch`,
whose `patchText` holds a Codex-grammar patch. Before this capture the adapter
split `apply_patch` as an MCP tool named `patch` on server `apply`.

**`chat-message`, `session-created`, `session-idle`, `tool-before` and
`tool-after` are captured**, replacing the type-derived envelopes described at
the top of this file. Taken from a real **opencode 1.18.33** session on Linux
(2026-09-29) in the harness-watch drift lane
(https://github.com/roryeckel/hooknostic/actions/runs/36504071099, playback
transport) and promoted with `.capture/harness-drift/promote-opencode-v1.mjs`:
the envelopes are the harness's own, the prompt and the bash command are
scripted, and the paths are the container's `/drift/opencode-v1` (no account
name to redact). What the live shape established against the typings:
`chat.message` input carries `model` rather than `agent`/`messageID`; bus
events carry `event.id`; the bash tool's schema offers no `description` arg;
`tool.execute.after` metadata carries `output`/`exit`/`truncated`. The
behaviour fixtures derived from the old envelopes (`tool-before-block`,
`tool-before-rewrite`, `tool-after-replace`, `session-idle-notify*`,
`session-idle-prevent`) keep the type-derived shape: they pin the decode and
apply contract, not harness shape.
