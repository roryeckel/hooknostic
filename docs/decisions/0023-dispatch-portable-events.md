# ADR-0023: Consumers test hooks by dispatching portable events

## Status

Accepted, 2026-09-24.

## Context

A consumer needs to test what its hooks decide on each target. The only entry
points were the built artifacts: a native payload on stdin for command targets,
the plugin module for OpenCode. So a consumer's suite hand-wrote each harness's
native payloads, decoded each native reply, and built a client double to observe
OpenCode's session posts. That restates wire formats Hooknostic's own fixtures
and contract tests already own, and every codec or encoder change upstream
becomes a consumer test change. It also invites the double that hides a defect:
the pilot consumer's object-literal stand-in for OpenCode's client did not care
about `this`, which is how a detached-method call passed its tests.

`@hooknostic/testkit` does not serve here. It is private, written for adapter
authors, and assumes the monorepo's fixture layout.

Replaying the committed artifact would need a portable-to-native encoder per
adapter and per event. Each payload would be synthesized, which is the shape
guessing this project declines, or templated from captured fixtures the
published package does not ship.

## Decision

`hooknostic dispatch --target <id>`, and `dispatchEvents()` in the programmatic
API, run portable events through the configured hooks in process.

**What runs.** The entry is bundled and evaluated exactly as `check` and `build`
evaluate it. Dispatch refuses a target the capability analysis fails, so a test
cannot pass against hooks that cannot ship there.

**As which target.** The runtime receives what a built shim hands it: capability
levels resolved from the target's version range, the compatibility floor, the
runtime policy, the adapter's shell codec and optional effect validator, and `ctx.plugin.root` derived the way
the build derives it (ADR-0020).

Adapter effect validation runs after portable validation and shell lowering,
before canonical mutation. Rejections use HN401 and the same `onHookError`
policy in both paths. Checks that require a live native object, such as whether
Pi's input object can be mutated, remain in the shim.

**What comes back.** One result per event: the `HookResult`, plus `native`, the
adapter's own `apply()` output, which is what that target's shim sends its
harness. On OpenCode that is the application plan (throw message, mutations,
session prompts and their reply flag), so no client double is needed.

**Completing an event.**

- Missing envelope fields get defaults: `schemaVersion`, an empty `correlation`,
  `raw: null`, and `session.cwd` from the CLI's working directory.
- `harness.id` is the target's adapter. `harness.nativeEvent` defaults to
  `hooknostic.dispatch`, which marks the event as synthetic. The decoders have
  no inverse, and naming a native event would be a guess.
- A test gives a tool only its `nativeName` and `input`. The rest of the view —
  `kind`, `mcp` and `shell` — comes from the adapter's `classifyTool`, the
  decoder's own classification, which the contract suite holds to every
  tool-bearing fixture. An event that supplies any of them is rejected, so a
  test cannot hand a hook a normalized view its harness never would. Two
  exceptions are facts a harness states rather than derives: a shell dialect
  (ADR-0029), and an MCP server and tool on the events whose payload states
  them (ADR-0032). The classifier must still apply them.
- Tool-scoped events require `tool`; the rest refuse it.
- Each event's own fields must be as its SDK type declares them: a required
  one such as `prompt` or `agent` must be present, and a field the type does not
  declare is rejected. The decoders' fallbacks for a field a harness omitted
  are not copied, because they differ between adapters; a test states the value.

**Module lifetime.** A command target gets a fresh module instance for every
event, because its harness starts a process per dispatch. A module target keeps
one instance for the whole run, as its harness does for its lifetime.

**The process.** Hooks run inside the CLI. It claims stdout as a command shim
does, so hook output goes to stderr and the result lines stay parseable, and it
falls back to a forced exit once the results are written, so a handle a hook
leaks cannot hold it open. (The 2026-11-15 amendment adds the command-shim
guard and exit code 1.)

## Consequences

- Consumer tests assert portable effects and, where they care, the native reply,
  without restating a wire format.
- Dispatch tests the source, not the committed artifact bytes. The two agree
  when `hooknostic verify` passes (project delivery) or a fresh `build` leaves
  the committed output unchanged (ADR-0006), so a consumer runs one of those
  beside its tests.
- Decoders are never exercised, because no native payload exists. They stay
  covered where they are owned: captured fixtures and the adapter contract suite.
- What depends on the host process is out of reach. That covers which executable
  runs the hook (`process.execPath` is Bun on OpenCode), stdio a child process
  inherits, and environment a harness sets. It also covers state shared across
  one run's events in the same process (`process.env`, `globalThis`,
  listeners), and concurrency: events are dispatched one at a time.
- `hooknostic.dispatch` is a reserved `nativeEvent` value a hook can observe.
- Capability analysis is the only build step dispatch repeats. Packaging and
  projection problems still surface in `check`.

## Alternatives considered

- **Replaying the artifact** with per-adapter encoders, rejected above.
- **Publishing `@hooknostic/testkit`**: its helpers take runtime internals, and a
  CLI also serves consumers whose tests are not written in JavaScript.

## Amendments — 2026-11-15

**The process** now also runs the hook source under the command-shim guard
(#186, #189). The command shims ship this guard; without it, dispatch exited
with the hook source's own exit code and usually printed no results. Now a hook
source's `process.exit`, rejections, uncaught exceptions, `process.exitCode` and
`exit` listeners no longer choose the run's exit code, and it usually cannot end
the run early. The guard's documented limits remain (design §10.3): among them,
an `exit` listener that throws while the run leaves from inside the hook
source's own `uncaughtException` listener ends it with Node's 7.

- **Exit codes.** `0` and `2` keep their meanings. A new `1` means the hook
  source failed outside a handler: a rejection nothing handled, a throw from a
  timer, or a `process.exit` the guard intercepted where the shipped shim would
  not. The reports are on stderr as `hooknostic internal [event N]: ...`.
  Usually every event still has its result. Where the guard cannot unwind, as
  with the hook source's own `uncaughtException` listener that exits or an exit
  repeated within one event, the run ends early with `1` and some or all result
  lines missing: until the run finishes, leaving counts as `1`. So does a
  top-level `await` that never settles, whose only stderr is Node's own warning. `2` takes
  precedence over `1`, and handler errors stay in `errors` with exit `0`.
- **Per target.** On a command target, `process.exit` in a handler is that
  handler's error, as in its shim. On a module target the error is the same,
  and a stderr note says the target's shim runs in the harness's process and
  does not intercept the exit, because what the harness then does has not been
  captured. The run exits `1`.
- **Attribution is best effort.** Each event waits one zero-delay timer before
  the next. A later tail may be labelled with a later event or with none. A tail
  later than the forced exit's grace after the last result is not reported, as
  in the shims.
- **Scope.** Only the `hooknostic` command is guarded. `dispatchEvents()` and
  the exported `runCli`, with or without an injected `io`, run in the caller's
  process and install nothing (see the second amendment). `--unguarded` keeps
  the earlier behaviour for a developer who wants the raw crash; other commands
  reject it.

## Amendments — 2026-11-15 (second)

**The other commands** that evaluate the config or the hook source in the CLI's
process (`check`, `build`, `sync`, `verify`, `recover`, `doctor`, and
`inspect --config`) now run that evaluation under the same guard (#193). A
failure while a module loads is that load's HN501, and the command exits `2`.
One after every load is reported as `hooknostic internal: ...` and makes the
exit code at least `2`, but it does not undo what `build` or `sync` already
wrote. A leaked handle no longer holds the command open. They have no
`--unguarded`. The limits are in design §10.3.

**Only the `hooknostic` command owns its process** (#193). It alone installs
either guard, claims stdout for `dispatch`, removes staged modules from an
`exit` listener, and forces an exit after its results. The exported `runCli`
never does, with or without an injected `io`: before this, a call without one
did all of that for `dispatch` (claiming stdout and forcing the exit since this
ADR's first version), which could end or take over a host program. A
programmatic `runCli` call now leaves the process to its caller, as
`dispatchEvents()` always has. One consequence for `dispatch` without an
`io`: what the hook source writes to stdout now shares it with the result
lines, where the claimed stdout used to move it to stderr. Pass an `io` to
keep the two apart.
