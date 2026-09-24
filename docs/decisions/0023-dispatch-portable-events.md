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
runtime policy, the adapter's shell codec, and `ctx.plugin.root` derived the way
the build derives it (ADR-0020).

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
- `tool.shell` is always derived from `tool.input` by the target's codec, and an
  event that supplies one is rejected. A test cannot hand a hook a normalized
  view its harness never would.
- Tool-scoped events require `tool`; the rest refuse it.

**Module lifetime.** A command target gets a fresh module instance for every
event, because its harness starts a process per dispatch. A module target keeps
one instance for the whole run, as its harness does for its lifetime.

**The process.** Hooks run inside the CLI. It claims stdout as a command shim
does, so hook output goes to stderr and the result lines stay parseable, and it
falls back to a forced exit once the results are written, so a handle a hook
leaks cannot hold it open.

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
