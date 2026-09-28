# Decision 0005 — Which effects end a dispatch, stated once

**Status:** Accepted — 2026-08-29 · Referenced from code and docs as **ADR-0005**
**Supersedes:** ADR-0003 composition rules 4–6, and amends rule 3 (context additions
and notifications now accumulate under *separate* caps). Rules 1, 2, 7 and 8 stand.
**Amended by:** ADR-0025 — a handler may return an ordered list of effects, so the
two-hook notify-then-prevent pattern below is no longer required.

**In short:** some effects stop the remaining hooks from running and some don't, and
until now that list lived in three places that disagreed with each other. Here it is,
once, with the rule that decides membership — plus a new effect, `notify`, that
reaches the user without stopping anything.

## Context

ADR-0003 introduced terminal effects one at a time, in prose, as each was added:
rule 4 named `block`, rule 5 `requestApproval`, rule 6 `blockContinuation`. When
`preventStop` shipped it was terminal in `isTerminalEffect` and was never added to
that list. `docs/concepts.md` and `docs/glossary.md` inherited the omission and told
readers three effects were terminal while the code enforced four.

The implementation had no way to catch that. `isTerminalEffect` was a chain of
`||` comparisons, so a new effect kind simply defaulted to non-terminal with no
error anywhere.

Separately, `turn.stop` offered only `observe` and `prevent`. A hook could keep the
agent working or say nothing; there was no way to emit a message that must *not*
drive another turn. A real consumer needed exactly that for three cases — idle
verification could not run, a proof budget expired, and a failure survived every
automated repair attempt — and compiling its hook would have dropped all three
silently.

## Decision

The terminal-effect set is a **closed, enumerated list**, declared once as a total
map over `EffectKind`, so that adding an effect kind cannot compile until "does
this end the dispatch?" has been answered.

> **Terminal:** `block`, `requestApproval`, `preventStop`, `blockContinuation`.
> **Non-terminal:** `replaceInput`, `replaceOutput`, `addContext`, `notify`.

An effect is terminal **iff applying it makes every later handler's decision
unsound** — because the action those handlers would inspect is no longer going to
happen (`block`, `blockContinuation`), because control has left the agent
(`requestApproval`), or because the dispatch's outcome is already fixed
(`preventStop`). Effects that only *add* to the result — replacing a payload later
handlers can still see and replace again, or appending text — are non-terminal.

`notify(message)` is added under that rule. It surfaces a message to the user,
changes no control flow, and is scoped to `turn.stop` and `agent.stop`, the two
events where no other channel exists. It is deliberately not `addContext`:
`addContext` is model-facing, `notify` is not, and on the harnesses that support
both they are separate native channels. Notifications accumulate in declaration
order under a configurable size cap; the runtime keeps them attributed and
separate, and each adapter joins them for its own native channel.

This replaces ADR-0003 composition rules 4, 5 and 6, and amends rule 3: context
additions and notifications each accumulate under their own cap, rather than sharing
one. Rules 1, 2, 7 and 8 stand unchanged.

## Consequences

- `preventStop` is documented as terminal for the first time. The code was right
  and the docs were wrong; `docs/concepts.md` and `docs/glossary.md` are corrected.
- Adding an effect kind is now a three-way forced decision, each enforced by the
  compiler: its capability suffix (`EFFECT_CAPABILITY_SUFFIX` is a total record),
  its schema membership (a missing `effectSchema` member makes every return of the
  effect an HN401), and its terminal-set membership.
- A terminal effect is still always the last entry in `HookResult.effects`, so
  adapters may keep reading the last effect as the terminal one. Adding
  non-terminal kinds never invalidates that.
- **Hook order is part of the notification contract.** A handler returns a single
  effect, so one hook cannot both notify and prevent a stop; that needs two hooks,
  and the notifying one must be declared first or the terminal effect cuts it off.
- Adapters must carry accumulated notifications through their terminal encoding
  paths rather than returning early. On Claude this forced `preventStop` off exit 2
  and onto an exit-0 JSON body, because exit 2 cannot carry one.
- `notify` is unsupported until an adapter publishes a matrix cell for it.
  Declaring it `required` fails those targets by design (ADR-0001); `optional`
  requires runtime feature detection. It ships `exact` on Claude, **unsupported**
  on Codex — which accepts `systemMessage` on the wire and renders it nowhere — and
  `approximate` on OpenCode, where the only channel also puts the text in front of
  the model on the next turn.
