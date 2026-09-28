# Decision 0025 — A handler may return an ordered list of effects

**Status:** Accepted — 2026-09-27 · Referenced from code and docs as **ADR-0025**
**Amends:** ADR-0005's consequence that "a handler returns a single effect, so one hook
cannot both notify and prevent a stop". ADR-0003's composition rules and ADR-0005's
terminal set are unchanged.

**In short:** `run` may return `[notify("…"), preventStop("…")]`. A list means exactly
what the same effects would mean if consecutive hooks had returned them one by one,
with one extra rule: a terminal effect must come last.

## Context

ADR-0005 introduced `notify` for the stop events and recorded a cost: a handler returned
one effect, so a hook that wanted to tell the user something *and* keep the agent
working had to be split into two hooks. The notifying hook had to be declared first, or
the terminal `preventStop` cut it off. The split carries no meaning of its own. It
exists because of how return values are shaped, and it moves an ordering rule out of
the code the author reads and into declaration order.

The SDK had not been published when this was decided, so the return type could still be
widened without a migration.

## Decision

1. **A list is sugar for consecutive handlers.** `run` may return an effect, a list of
   effects, or nothing. List elements are applied in order, each validated on its own
   by the existing HN401 ladder (shape, event, declaration, target availability, and
   the `updateShell` lowering). Effects keep their order in `HookResult.effects`,
   attributed to the one hook id. The context and notification budgets are
   per-dispatch already, and list elements draw on them like any other effect.
2. **Element failures follow the hook-error policy, element by element.** A failing
   element is recorded and handled by `onHookError`. Under `continue` (the default),
   the elements after it still apply, as a later hook would have run. Under `block`,
   the synthesized block ends the dispatch and the remaining elements do not apply.
3. **A terminal effect must be last.** A list whose terminal effect is followed by any
   further element is rejected as a whole (HN401) before any element applies. Applying
   the prefix and silently dropping the tail would hide the mistake. Applying the tail
   after a terminal would break the invariant every adapter relies on, that the
   terminal effect is the last entry. The check runs on the returned list, so it fails
   the same way on every target and shows up in any test that dispatches the hook.
4. **`undefined` elements are skipped** so conditional composition reads naturally
   (`[cond ? notify(msg) : undefined, preventStop(reason)]`), and an empty list means
   no effect. Every other non-effect value, `null` included, stays an HN401.
5. **The type is not a tuple.** Terminal-last is enforced at runtime, not in the type,
   so a list built in a loop still type-checks. The per-element capability check stays
   at compile time: every element must be licensed by the hook's declaration.

## Consequences

- One hook can notify and prevent a stop, or add context and block, without depending
  on declaration order.
- `HookResult` and every adapter `apply()` are unchanged. Two entries under one hook id
  have existed since `updateShell` lowering (ADR-0007), and adapters never key on hook
  id.
- Returning a list from a hook adds nothing a harness could observe differently from
  the equivalent consecutive hooks. The only new failure mode is the terminal-last
  rejection.
