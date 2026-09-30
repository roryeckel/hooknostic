# Glossary

The terms of art used across these docs, defined once. Within each section, terms are
ordered so that later entries build on earlier ones.

## The domain

**Harness** — a coding-agent application that can load hooks: Claude Code, OpenAI Codex
CLI, OpenCode. Called a harness because it's the machinery your hook code runs inside.

**Hook** — a function you register to run at a lifecycle moment ("a tool is about to
run", "the session started"). In Hooknostic, one declaration of *when* (an event),
*what it needs* (capabilities), and *what to do* (a `run` function).

**Lifecycle event** (or just **event**) — a named moment in a harness's operation.
Hooknostic defines a normalized vocabulary (`tool.before`, `session.start`, …) that
adapters map to native event names (`PreToolUse`, `session.created`, …).

**Effect** — the action a hook returns to request something of the harness: `block`,
`replaceInput`, `addContext`, and friends. Returning nothing means "continue
unchanged"; returning a list applies each effect in order, with any terminal effect
last. ([Decision 0025](decisions/0025-effect-lists.md))

**Capability** — a named, event-scoped permission slot such as `tool.before.block`:
"at this event, on this harness, can hook code do this?" The core currency of
Hooknostic's portability checking.

**Support level** — an adapter's grade for one capability: `exact` (native mechanism
matches the contract), `emulated` (different mechanism, same observable behavior),
`approximate` (useful but materially different), `unsupported`.

**Capability matrix** (or **capability table/profile**) — an adapter's versioned table
of support levels for every capability, with a rationale for every non-exact cell.
Rendered by `hooknostic inspect`.

**Compatibility policy** — your config's answer to "how much degradation is
acceptable?": a minimum support level and what to do below it, settable globally and
per target. It applies to hook capabilities and to Agent Plugin components alike.
Default: minimum `emulated`, below-minimum is an error. A capability below it is an
HN201; a component below it is an HN206 and is still emitted when that is a warning.

## The machinery

**Adapter** — the per-harness package that owns everything harness-specific: the
capability matrix, decoding native events, applying effects natively, and generating
that harness's output files.

**Target** — one configured build destination: a harness plus a validated version
range, an delivery scope, and an output directory.

**Dispatcher** — the small Hooknostic runtime that receives a decoded event and runs
all matching hooks in declaration order, applying the composition rules (immediate
mutations, terminal effects). One native entry point per lifecycle moment
([Decision 0003](decisions/0003-one-dispatcher-composition.md)).

**Shim** — the thin generated layer between a harness's native process model and the
dispatcher: a stdin/stdout subprocess entry for Claude and Codex, an in-process module
for OpenCode.

**Terminal effect** — an effect that ends a dispatch immediately; hooks declared after
it don't run for that event. `block`, `requestApproval`, `preventStop`, and
`blockContinuation` are terminal; input/output replacement, context addition, and
notification are not. ([Decision 0005](decisions/0005-terminal-effects.md))

**Plugin IR** (intermediate representation) — the normalized internal model the
compiler builds from your config and hook source before analyzing and emitting
anything. You'll meet the term in the design doc and `@hooknostic/core`.

**Artifact** — a generated output file. Each target's artifacts form one
self-contained, independently distributable directory under your configured output
path.

**Build report** (`hooknostic-build.json`) — the machine-readable record every build
writes: adapter versions, requested ranges, how every capability resolved per target,
and all diagnostics.

**Diagnostic** — a compiler-style message with a stable `HN…` code, severity, the hook
and target involved, and a remediation hint. Families: HN1xx degradation info, HN2xx
incompatibilities, HN3xx generation failures, HN4xx runtime contract violations, HN5xx
configuration errors.

## The verification story

**Fixture** — a captured, verbatim example of a harness's real behavior (an actual
stdin payload, an expected output), stored by harness version under `fixtures/` with
provenance. Adapters are tested against fixtures, not against vendor docs alone —
because docs drift ([the baseline](baseline-2026-08-20.md) records several cases where
they had).

**Baseline** — the dated primary-source snapshot of each harness's verified native
surface ([baseline-2026-08-20.md](baseline-2026-08-20.md)) that the v0.1 adapters were
built against.

**Smoke test** — an opt-in test (`HOOKNOSTIC_SMOKE=1 pnpm test`) that loads generated
output into a *really installed* harness and confirms the effects work end-to-end.

**Golden round-trip** — the core adapter test shape: native fixture → decode → run real
handlers → apply → compare against the expected native result.

## The ecosystem

**Agent Plugins** — a vendor-neutral packaging standard for portable agent extensions
(skills, MCP config, `plugin.json` manifest). Hooknostic integrates with it as a peer
([Decision 0011](decisions/0011-agent-plugin-native-projection.md)); the integration is
optional and the source package is immutable.

**Projector** — an adapter-owned, versioned translation from a validated Agent Plugin
package model to a harness-native plugin file plan. Projection is independent of hook
compilation, so a package may be hookless.

**Component support** — the exact/emulated/approximate/unsupported classification for an
Agent Plugin component such as skills or an MCP transport. It is separate from hook
capability support and can be inspected with `hooknostic inspect --component`.

**Deviation** — a known, captured way a harness treats some instances of a component
differently from Agent Plugins 1.0, which Hooknostic reports rather than corrects. It is
not a support level: a level describes every instance, while a deviation applies only to
packages containing the triggering text. Each one is declared on the adapter's profile
under a qualified id such as `claude:mcp-environment-expansion`. It is reported as HN106,
and it fails the build under `components.onDeviation: "error"` (ADR-0019).

**Degradation** — a known way a projection falls short of its component's level for some
items it still emits, such as an OpenCode skill it cannot name for its plugin. Declared on
the adapter's profile under a qualified id such as `opencode:skill-name-unqualified`,
reported as HN101, and fatal by default under `components.onDegraded` (ADR-0022).

**Event field** — an optional part of a normalized event, such as `turn.stop`'s
`lastMessage` or `correlation.turnId`, named by an event-scoped id like
`turn.stop.lastMessage`. Each adapter rates each field per version range, like a
capability; a hook lists the fields it reads in `fields`, and one a target cannot
produce exactly is reported as HN108. Accepted by a qualified id such as
`opencode:turn.stop.correlation.turnId` in `compatibility.accept` (ADR-0027).

**Root checkout** — the main working tree of a git repository, as opposed to a linked
worktree made by `git worktree add`. Codex reads project hooks from the root checkout
even for a session in a linked worktree, so project wiring synchronized into a
worktree is reported as HN107 (ADR-0015).

**Skill** — an Agent Plugins portable component (`skills/<name>/SKILL.md`): reusable
instructions a harness can invoke. Not something Hooknostic generates or modifies.

**MCP** (Model Context Protocol) — the existing portable standard for connecting
agents to external tools and data. Already portable, hence explicitly out of
Hooknostic's scope.

**Agent definition** — one Markdown file describing an agent a harness runs: as a
subagent the main agent hands a task to (Claude Code's subagents, Codex's custom
agents, OpenCode's agents with `mode: subagent`), as the agent a session runs as
(`mode: primary`, which Codex does not support), or both (`mode: all`). No standard
covers them, so Hooknostic defines a provisional
[format](spec/agents/0.1.md) and compiles it into each harness's own
([ADR-0028](decisions/0028-portable-agents.md), proposed). Not to be confused with
the `agent.*` hook events, which report on whatever agent is running.

**Agent scope** — a hook's `agents: { include, exclude }`, which runs it only for events
the harness attributes to the named agents, by the name in `correlation.agentType`
([ADR-0029](decisions/0029-agent-scoped-hooks.md), proposed). It needs the event's
`agent.identity` capability, so a target that cannot tell fails the build.

**Decision record** — a short document capturing one significant design choice with
its context and consequences ([docs/decisions/](decisions/)). Known in the wider world
as an *architecture decision record* (ADR) — the `ADR-000N` ids in code comments refer
to these.
