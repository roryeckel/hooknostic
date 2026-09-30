# Core concepts

Everything in Hooknostic builds on five ideas. This page explains them in plain
language; the [design document](design.md) has the precise contracts behind each one.

## Packages and repository integration

Agent Plugins 1.0 supplies the portable manifest, skills, MCP, and client-extension
contract. Hooknostic validates it and translates components through adapter profiles.
Hooks use the TypeScript SDK and can accompany a package or stand alone. Direct skills
and MCP sources can also be synchronized into a repository without a manifest.

Choose package or project delivery per target. `build` writes native output; `sync`
maintains project discovery files and ownership state, and `verify` detects drift.
Component support has the same four levels as hook capabilities, with explicit
[shortfall policies](configuration.md#compatibility-and-component-policies).

## 1. Harnesses: the tools your hooks run inside

A **harness** is a coding-agent application — Claude Code, OpenAI Codex CLI, OpenCode.
Each one lets you attach code to moments in its lifecycle ("a tool is about to run",
"a session just started"), but each invented its own way of doing it:

- **Claude Code** and **Codex CLI** run each hook as a separate subprocess: they send a
  JSON event on stdin and read a JSON answer on stdout.
- **OpenCode** loads your hook code as a JavaScript module inside its own long-running
  process and calls functions on it.

Different event names, different payloads, different rules. Hooknostic's job is to be
the translation layer — with the crucial property that it *refuses to translate
untranslatable things silently*.

## 2. Events: the moments you can hook into

Hooknostic defines one normalized vocabulary of lifecycle events:

```
session.start   session.end     prompt.before
model.request.before
tool.before     tool.after      tool.error
permission.request
context.compact.before          context.compact.after
agent.start     agent.stop      turn.stop
```

Your hooks subscribe to these names; adapters map them to whatever each harness calls
them natively (`tool.before` is `PreToolUse` on Claude and Codex, and the
`tool.execute.before` callback on OpenCode).

Every event your hook receives carries a normalized envelope — which harness fired it,
the session's working directory, correlation ids where the harness provides them — plus
the **complete raw native payload** in `event.raw`. Normalization never hides data: if
you need something harness-specific, it's right there, along with the native event and
tool names.

Tool events additionally classify the tool being invoked into a portable `kind`
(`shell`, `file.read`, `file.write`, `file.edit`, `web.fetch`, `web.search`, `agent`,
`mcp`, `other`) so a hook can say "match every shell command" without knowing that
Claude calls it `Bash`. The native name stays available as `nativeName`.

The *arguments* are not portable, so where a tool's shape has been captured the event
also carries a normalized view of them: `tool.shell` (the command, whatever key the
harness uses) and `tool.file` (every path a file tool targets, including the files a
Codex patch touches). A view is absent when the shape is uncaptured; the raw
`tool.input` is always there, and the hook decides whether to fail open or closed.
([Decision 0007](decisions/0007-portable-shell-write-back.md),
[Decision 0026](decisions/0026-normalized-file-view.md))

Optional fields such as `turn.stop`'s `lastMessage` or `correlation.turnId` are rated
per target like capabilities, because not every harness sends them: OpenCode's stop
signal carries only a session id, so the adapter derives both. A hook lists the ones it
reads, `fields: ["lastMessage", "correlation.turnId"]`, and a target that never produces
one fails the build with HN108 unless you accept it. On an in-process target the
declaration is also what asks the adapter to do that work.
([Decision 0027](decisions/0027-event-field-fidelity.md))

Deliberately, the vocabulary is small. A harness-specific event (worktree lifecycle,
notifications, file watchers, …) only gets a normalized name once at least two
harnesses share its meaning; until then it stays reachable through the raw payload.

## 3. Effects: the things a hook can ask for

A hook responds to an event by returning an **effect** — a request for the harness to
do something:

| Helper | Asks the harness to… |
| --- | --- |
| `block(reason)` | Stop the pending action (tool call, prompt, compaction…) |
| `requestApproval(reason)` | Escalate to the user for approval |
| `replaceInput(input)` | Rewrite the pending tool call's input |
| `updateShell({ command })` | Rewrite the shell command portably (needs `event.tool.shell`) |
| `addContext(text)` | Add text the model will see |
| `replaceOutput(output)` | Replace or redact a tool's output |
| `preventStop(reason)` | Keep the agent/turn going when it wants to stop |
| `blockContinuation(reason)` | After a tool ran, stop the agent from continuing |
| `notify(message)` | Show the user a message, changing nothing about what happens next |

Returning nothing means "continue unchanged" — there is deliberately no `allow()`
helper, because "explicitly allow" means subtly different (and sometimes
permission-bypassing) things across harnesses. A hook can also return a list —
`[notify("lint failed"), preventStop("fix it")]` — which applies in order, exactly as
if consecutive hooks had returned each effect; an effect that ends the dispatch must
come last. ([Decision 0025](decisions/0025-effect-lists.md))

## 4. Capabilities: the honest map between the two

Here is the central design rule: **being told about an event and being allowed to act
on it are two different things.** Every harness with a `tool.before` event will tell
you a tool is about to run — but whether your code may *block* it, *rewrite* its input,
or *add context* varies by harness and version.

So each effect, at each event, is a named **capability**:

```
tool.before.block          tool.after.output.replace     session.start.context.add
tool.before.input.replace  tool.after.blockContinuation  turn.stop.prevent
tool.before.requestApproval  ...                          turn.stop.notify
```

(Using an event at all implies its `<event>.observe` capability.)

Every adapter ships a versioned **capability table** grading its harness's support for
each capability:

| Level | Meaning |
| --- | --- |
| `exact` | The native mechanism matches the contract exactly |
| `emulated` | Different mechanism, same observable behavior |
| `approximate` | Something useful exists, but the semantics genuinely differ |
| `unsupported` | The adapter can't deliver it |

Your hook declares which capabilities it relies on, and how much:

```ts
capabilities: {
  block: "required",          // tool.before.block: no block support → this target fails the build
  "input.replace": "optional", // tool.before.input.replace: nice to have → feature-detect at runtime
}
```

Keys are relative to the hook's event; the full ids (`tool.before.block`) are accepted
too, and they are what reports and diagnostics print. At runtime,
`ctx.capabilities.has("input.replace")` tells you whether an optional capability is
live on the executing target. (Returning an effect you didn't declare — or that the
target can't support — is a runtime contract violation, HN401, not a silent no-op.)

Finally, your config sets the **policy** for how much degradation is acceptable —
project-wide and per target:

```ts
compatibility: { minimum: "emulated", onBelowMinimum: "error" }   // the default
```

The result: when behavior differs across harnesses, you found out at build time, in a
diagnostic that names the hook, the capability, the target, and what to do about it.
Nothing is ever silently dropped.

## 5. The build pipeline: check first, emit last

```
config + hooks and/or components
        │
        ▼
  normalized plugin model
        │
        ▼
  capability analysis  ──▶  diagnostics (HN101, HN201, …) + build report
        │  (only if every selected target passes)
        ▼
  bundle your hook code once
        │
        ├── Claude adapter   ──▶  dist/claude/    (a complete Claude Code plugin)
        ├── Codex adapter    ──▶  dist/codex/     (a native package or project tree)
        └── OpenCode adapter ──▶  dist/opencode/  (a native package or project plugin)
```

Key properties:

- **`check` compiles without writing target artifacts.** Trusted materializers may use network or persistent caches. Both run the same pipeline — analysis,
  bundling, Agent Plugin projection, artifact validation — and `check` stops just before
  staging. Whatever `build` rejects before touching the filesystem, `check` rejects — an
  existing output of the wrong kind (a file where a directory goes) included, since that
  is inspected read-only; it is what you put in CI. The one class it cannot see is a
  write the target filesystem itself refuses (a path over its length limit, a reserved
  name), which surfaces as HN301 at `build`.
- **Builds are atomic.** Output is staged to a temporary directory and only committed
  when every selected target passes — you never end up with half a build.
- **Builds are reproducible.** They compile against the harness *version ranges in your
  config*, never against whatever version is installed on the machine running the
  build. (`hooknostic doctor` is the command that looks at your installed versions.)
- **Every build writes `hooknostic-build.json`**, a machine-readable report recording
  which support level every capability resolved to on every target — the first thing to
  read when a hook behaves differently across harnesses.
- **Diagnostics are compiler-grade.** Stable codes (HN1xx compatibility info, HN2xx
  incompatibilities, HN3xx generation failures, HN4xx runtime contract violations,
  HN5xx config errors), source locations, and a remediation hint on each.

## Two rules your hook code lives by

**Hooks are stateless between calls.** Claude and Codex start a fresh process per hook
invocation; OpenCode keeps your module in memory. Anything you kept in a module-level
variable would work on one and vanish on the other — so the portable contract is that
every invocation starts from scratch, and everything you need arrives in the event and
context. ([Decision 0002](decisions/0002-invocation-stateless-contract.md))

**Your hooks run in declaration order, everywhere.** Hooknostic registers one native
hook per lifecycle point and dispatches your handlers itself: sequentially, in the
order you declared them; input/output replacements take effect immediately so later
handlers see them; context additions and notifications accumulate; `block`,
`requestApproval`, `preventStop`, and `blockContinuation` end the dispatch. A list
returned by one hook applies in order under the same rules. Same rules on every
harness.
([Decision 0003](decisions/0003-one-dispatcher-composition.md),
[Decision 0005](decisions/0005-terminal-effects.md),
[Decision 0025](decisions/0025-effect-lists.md))

## What Hooknostic is *not*

- **Not a sandbox or security boundary.** Hooks are code running in your development
  environment, and some harness tool paths bypass hooks entirely. Generated
  integrations preserve each harness's own trust prompts; Hooknostic never bypasses or
  auto-accepts them.
- **Not a plugin marketplace or packaging standard.** Agent Plugins already defines
  portable packaging; Hooknostic validates and projects it as a peer without changing
  its schema ([Decision 0011](decisions/0011-agent-plugin-native-projection.md)).
- **Not a policy engine.** It's an interoperability layer; what your hooks enforce is
  up to you.

Ready to build one? Head to [Getting started](getting-started.md).
