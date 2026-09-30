# ADR-0029: A hook can be scoped to the agent it runs in

**Status:** Proposed — 2026-09-29. It builds on
[ADR-0028](0028-portable-agents.md) and, like it, is implemented on the branch
that proposes it, for review; it merges only once both are accepted.

**In short:** Hooknostic should normalize the name of the agent an event ran in, as
`correlation.agentType`, wherever the harness reports it. A hook can then declare
`agents: { include, exclude }` and run only for events inside those agents. Whether
a target can tell is a capability, `<event>.agent.identity`, which is analysed and
reported like any other.

## Context

ADR-0028 makes agents something an author defines and ships, as subagents or as
the agent a session runs as. A hook still cannot tell whose tool call it is
looking at. That rules out uses a defined agent invites:

- **Guarding one subagent.** For example, a reviewer that must not write. Codex
  honours no per-agent tool list or sandbox (`.capture/agents`), so a hook is the
  only route there. This is the route ADR-0028's open question 4 names for a
  portable read-only posture.
- **Auditing or adding context per agent.**
- **Keeping a guard meant for the main agent off a trusted subagent.**

### Evidence

The fixtures promoted from `.capture/agents` show what each harness says inside a
delegated subagent:

| | Claude 2.1.238, 2.1.283 | Codex 0.156.1 | Codex 0.148.0 | OpenCode 2.0.17 | OpenCode 1.18.31 |
| --- | --- | --- | --- | --- | --- |
| Child's tool events | `agent_id`, `agent_type` | `agent_id`, `agent_type` | no hook fired in the child | `agent` names the subagent | only `tool`, `sessionID`, `callID` |
| Parent's tool events | neither field | neither field | neither field | `agent` names the primary agent (`build`) | same as the child's |
| Subagent lifecycle | `SubagentStart`/`SubagentStop` carry `agent_type`; no `SubagentStop` when `maxTurns` ends the child | both fire and carry `agent_type` | neither fired | no such events | no such events |
| A packaged agent reports | `<plugin>:<name>` | — | — | its registered id, `<plugin>-<name>` | its config key, `<plugin>-<name>` |

The Codex 0.148.0 runs relied on `--dangerously-bypass-hook-trust`, with session
overrides and with an isolated `CODEX_HOME` alike. Whether persisted hook trust
changes the result is not established.

A session can also run as a defined agent (ADR-0028, decision 9). The same drive
started one that way:

| | Claude 2.1.238, 2.1.283 | OpenCode 2.0.17 | OpenCode 1.18.31, 1.18.18 |
| --- | --- | --- | --- |
| The session's own events | `agent_type` names the agent on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`, with no `agent_id` | tool events' `agent` names it | tool events name no agent |
| A packaged agent reports | `<plugin>:<name>` | its registered id | — |

Codex has no agent a session runs as.

Today `correlation.agentId` normalizes `agent_id`, and `agent.start`/`agent.stop`
carry `agent.type`. On a tool event, the agent's name survives only in `raw`.
Hooks already have one precedent for scoping: `targets`, a runtime filter that
needs no state (design §7.6, ADR-0002).

## Decision (proposed)

1. **Normalize the agent's name as `correlation.agentType`.** The field is
   additive and optional. It holds the name of the agent the event ran in,
   exactly as the harness reports it.
   - **Claude and Codex.** From `agent_type`, on every event that carries it.
     Claude also sends it on every event of a session started as an agent.
   - **OpenCode v2.** From `agent` on tool events. That includes the primary
     agent's name, because v2 reports it: `build`, or a defined agent the session
     runs as.
   - **Absent means not reported.** On Claude that is a session not started as
     an agent, and on Codex the main agent -- including a session running on
     the project's default agent, which Codex only emulates through its
     configuration (ADR-0028, decision 10). On OpenCode v1 it is every tool
     event.
   - **Never inferred.** It is not derived from session parentage or from an
     instance id, since that would need cross-invocation state (ADR-0002).
   - **Additive.** `raw` and `correlation.agentId` do not change.

2. **A hook declares `agents: { include?, exclude? }`.** It is allowed on
   `tool.before`, `tool.after`, `tool.error`, `permission.request`, `agent.start`
   and `agent.stop`, and has the same shape as `targets`.
   - **`include`.** The hook runs only when `agentType` is reported and listed.
   - **`exclude`.** The hook is skipped when `agentType` is reported and listed,
     and runs otherwise.
   - **Names compare exactly, as reported.** A packaged agent reports its
     qualified name: `<plugin>:<name>` on Claude, `<plugin>-<name>` on OpenCode.
   - **Where it runs.** It is a filter at dispatch, like `targets`, and keeps no
     state.

3. **A target's ability to tell is the capability `<event>.agent.identity`.** It
   exists for the same six events. It means that events inside a subagent are
   dispatched, and that each dispatched event names the agent it ran in. Where
   the harness has agents a session runs as, that includes a session running as
   one: the evidence above holds for both on Claude and OpenCode v2, and for
   neither on OpenCode v1, so no level differs between them.
   - **Implied by `agents`.** A hook with `agents` requires it, as a hook
     requires its event's `observe`. Declaring it `optional` beside `agents` is
     an error.
   - **Declarable on its own.** A hook that reads `agentType` itself can declare
     it `optional` and probe it with `ctx.capabilities.has("agent.identity")`.
   - **Why a capability.** Without one, a scoped hook on a target that cannot tell
     would silently never run (`include`) or never skip (`exclude`). The
     compatibility analysis is how a build refuses to promise that.

4. **Initial levels, from the evidence above:**

   | Adapter | `tool.before`, `tool.after` | `agent.start`, `agent.stop` |
   | --- | --- | --- |
   | Claude `>=2.0 <3` | `exact` | `exact` |
   | Codex `>=0.156.1 <1` | `exact` | `exact` |
   | Codex `>=0.140 <0.156.1` | unsupported | unsupported |
   | OpenCode v2 | `exact` | no such events |
   | OpenCode v1 | unsupported | no such events |

   - **`tool.error` and `permission.request`.** These events have not been
     captured inside a subagent on any harness, so no adapter rates their cells
     and they resolve to unsupported.
   - **The Codex split.** Codex's capability data splits into two profiles at
     0.156.1. A target range spanning both resolves to the older profile's level,
     as for every capability.
   - **Keeping a declared cell's rationale.** Resolving a range across profiles
     now keeps a cell a profile declares `unsupported`, so `inspect` can still
     explain it, as it could when one profile resolved.

5. **Out of scope:**
   - Naming a packaged agent by its portable name. The compiler knows each
     target's qualification, so a later form of `agents` could resolve portable
     names.
   - A portable `readOnly` posture (ADR-0028 open question 4). It can build on
     this, for example as a generated agent-scoped `tool.before` guard on Codex.
   - Scoping `session.start`, `prompt.submit` or `turn.stop` to the agent a
     session runs as. Claude names it on each of them, but OpenCode v2 was
     captured naming it on tool events only, so no second harness supports it
     yet.

## Consequences

- **Verification.** The `.capture/agents` `scoped` case builds hooks scoped to
  its probe subagent for the build it finds installed, then delegates to the
  subagent. The registry's `agent-scope` scenario runs it in every playback lane.
  - **Where supported.** The scoped guard blocked the subagent's guarded call and
    let its next one through. Its hooks never touched the parent's delegation
    call. A guard scoped to another agent never acted. Scoped `tool.after`,
    `agent.start` and `agent.stop` hooks saw the subagent's events and no
    others. This held on Claude 2.1.283 and 2.1.238, Codex 0.156.1 and OpenCode
    2.0.17. On Codex the guarded write never landed, which is the route to a
    read-only subagent there.
  - **Where not.** On OpenCode 1.18.31 and 1.18.18, and Codex 0.148.0, the
    build refused the scope with HN201, and the child's tool events still
    named no agent.
  - **Mutation checks.** A generated runtime that ignored the scope failed the
    scenario: the stray guard blocked the parent's delegation. So did a decoder
    that dropped the field.
  - **A session running as the agent.** The `scoped-primary` case builds the
    same hooks and a `primary` definition, and starts the session as the agent.
    On Claude and OpenCode v2 the scoped guard blocked the session's own guarded
    call; on OpenCode v1 the build refused the scope, as for a subagent.
- **Adapters.** Each adapter normalizes one more field, and canonical fixtures
  that carry the native field gain `agentType`. Every OpenCode v2 tool fixture
  does, because v2 always names the running agent.
- **Codex capability data.** It splits by version, and the scheduled-playback
  record moves to the newer profile.
- **Related findings, not decided here:**
  - Claude dispatches no `SubagentStop` when `maxTurns` ends a subagent. So
    `agent.stop.observe` misses that stop, and `exact` overstates it.
    Downgrading it to `approximate` would fail existing builds at the default
    minimum, so that is the owner's call.
  - Codex 0.148.0 dispatched no hook inside a subagent under the bypass flag.
    There, any guard may not cover what a subagent does. That is a question for
    `tool.before.observe`, beyond agent scoping.

## Rejected alternatives

- **An agent field inside `match`.** `match` exists only on tool events, while
  agent scoping also serves `agent.start` and `agent.stop`. It is scoping, like
  `targets`, not tool matching.
- **Scoping by `agentId`.** Instance ids are opaque and unknown when the hook is
  written.
- **A build warning instead of a capability.** A warning has no minimum, no
  `inspect` entry and no report row, and cannot fail a build that needs the
  guarantee.
