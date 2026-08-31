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

Ground truth notes (1.18.x):

- Local plugins load from `.opencode/plugin/` or `.opencode/plugins/`
  (any `*.ts`/`*.js`; default or named `Plugin`-typed export).
- `permission.ask(input: Permission, output: { status: "ask"|"deny"|"allow" })`
  gives hooks a real deny channel.
- `tool.execute.before` blocks by **throwing**; rewrites via `output.args`.
- `tool.execute.after` replaces output via `output.output` (string).
- `experimental.session.compacting` exposes `output.context: string[]` and
  `output.prompt` (full prompt replacement).
- Session lifecycle arrives via the generic `event` bus callback
  (`session.created` / `session.deleted` / `session.idle` /
  `session.compacted`); there are no subagent or tool-failure callbacks.
