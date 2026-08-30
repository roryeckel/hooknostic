# Tutorial 2 — Rewriting tool input

**Example:** [`examples/rewrite-shell`](../../examples/rewrite-shell/) ·
**You'll learn:** the `replaceInput` effect, `required` vs `optional` capabilities, and
runtime feature detection — the pattern that lets one hook degrade gracefully across
targets.

This example ships one hook that does two jobs of different importance:

1. **Must-have:** block `rm -rf /` outright.
2. **Nice-to-have:** rewrite `npm ...` commands to `pnpm ...` before they run.

If a harness couldn't block, the hook would be broken there — so blocking is
`required`. But a harness that can't rewrite input still benefits from the guard — so
rewriting is `optional`, and the hook checks at runtime whether it's available.

## The code

[`src/hooks.ts`](../../examples/rewrite-shell/src/hooks.ts):

```ts
hook("tool.before", {
  id: "protect-and-normalize-shell",
  match: { kind: "shell" },
  capabilities: {
    "tool.before.block": "required",
    "tool.before.input.replace": "optional",
  },
  async run(event, ctx) {
    const input = event.tool.input as { command?: string };
    const command = input.command ?? "";

    if (command.includes("rm -rf /")) {
      return block("Refusing destructive root deletion");
    }

    if (ctx.capabilities.has("tool.before.input.replace") && command.startsWith("npm ")) {
      return replaceInput({ ...input, command: command.replace(/^npm /, "pnpm ") });
    }
  },
}),
```

## How required and optional differ

| | `required` | `optional` |
| --- | --- | --- |
| At build time | Target must support it (to your configured minimum) or the target **fails with a diagnostic** | Never fails a build; an unavailable optional is recorded as info in the report |
| At runtime | Always available — you may return the effect unconditionally | Ask first: `ctx.capabilities.has(...)` |

The second half of the contract matters as much as the first: an optional capability
being unavailable does **not** mean returning the effect is quietly ignored. Returning
`replaceInput` on a target where you didn't confirm availability is a runtime contract
violation (diagnostic HN401, handled per your configured error policy). The
`ctx.capabilities.has()` check isn't decoration — it's how the hook keeps its promises.

Notice also the rewrite spreads the original input (`{ ...input, command }`).
`replaceInput` replaces the *whole* input object, so preserve the fields you aren't
changing.

## See the degradation ledger

Build it:

```bash
cd examples/rewrite-shell && node ../../packages/cli/bin/hooknostic.mjs build
```

Then open `hooknostic-build.json`. For this plugin all three targets support both
capabilities (`tool.before.input.replace` is `exact` everywhere: `updatedInput` on
Claude, `allow` + `updatedInput` on Codex, in-place args mutation on OpenCode). But the
mechanism generalizes: every optional capability that *didn't* resolve gets recorded
here too, so "which targets are actually rewriting npm to pnpm?" is a question the
report answers — you never have to guess what degraded where.

`inspect` answers the same question before you even write the hook:

```bash
node ../../packages/cli/bin/hooknostic.mjs inspect opencode
```

renders the OpenCode adapter's capability table with a support level and rationale per
row.

## The design idea underneath

This tutorial is [Decision 0001](../decisions/0001-semantic-capability-model.md) in
action: the event (`tool.before`) and the things you can do with it (block, rewrite)
are modeled separately, each with its own portability answer per target. That's what
lets one hook be simultaneously strict about its core job and flexible about its
enhancement.

## Next

[Tutorial 3 — Injecting context](03-injecting-context.md): what happens when a target
genuinely *can't* do what a hook requires, and the two honest ways to respond.
