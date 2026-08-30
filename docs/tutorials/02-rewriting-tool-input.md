# Tutorial 2 — Rewriting tool input

**Example:** [`examples/rewrite-shell`](../../examples/rewrite-shell/) ·
**You'll learn:** the `updateShell` effect, `required` vs `optional` capabilities,
runtime feature detection, and the two escape hatches beneath the portable path.

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
    const command = event.tool.shell?.command ?? "";

    if (command.includes("rm -rf /")) {
      return block("Refusing destructive root deletion");
    }

    if (
      ctx.capabilities.has("tool.before.input.replace") &&
      event.tool.shell !== undefined &&
      command.startsWith("npm ")
    ) {
      return updateShell({ command: command.replace(/^npm /, "pnpm ") });
    }
  },
}),
```

Both the read and the write are portable here. `event.tool.shell.command` is
normalized by the adapter, and `updateShell` reverses the same mapping: the new
command lands under whichever key this harness's tool actually uses — `command` for
Claude's `Bash`, `cmd` for Codex's `exec_command` — with every sibling input field
preserved. One hook body, every captured shell shape.

## How required and optional differ

| | `required` | `optional` |
| --- | --- | --- |
| At build time | Target must support it (to your configured minimum) or the target **fails with a diagnostic** | Never fails a build; an unavailable optional is recorded as info in the report |
| At runtime | Always available — you may return the effect unconditionally | Ask first: `ctx.capabilities.has(...)` |

The second half of the contract matters as much as the first: an optional capability
being unavailable does **not** mean returning the effect is quietly ignored. Returning
a rewrite on a target where you didn't confirm availability is a runtime contract
violation (diagnostic HN401, handled per your configured error policy). The
`ctx.capabilities.has()` check isn't decoration — it's how the hook keeps its promises.

## The second guard: `event.tool.shell !== undefined`

`updateShell` needs one more check than the capability, and it is per-invocation,
not per-target: **the tool's argument shape must be captured.** `event.tool.shell`
being defined is that signal, for reading and writing alike. Where it's undefined —
a shell-kind tool whose shape was never observed, such as Codex's tool literally
named `shell` — returning `updateShell` is HN401. No build-time matrix can carry
this, because it depends on which tool the harness invoked, which is why the
capability stays `tool.before.input.replace` and the shape check is a runtime guard.

## The escape hatches

Two, in increasing rawness — the portable path never replaces them:

1. **Portable key, hand-built input.** When you need to touch native keys *outside*
   the normalized view (delete one, set a harness-specific flag), build the input
   yourself but take the key name from the adapter instead of restating it:

   ```ts
   const input = event.tool.input as Record<string, unknown>;
   return replaceInput({ ...input, [event.tool.shell.commandKey]: next });
   ```

   `shell.commandKey` (and `shell.cwdKey`, where the tool has a working-directory
   key) is the same data `updateShell` uses, so it can't drift from the adapter's
   fixtures. Note `replaceInput` replaces the *whole* input object — spread the
   original and change only what you mean to.

2. **Fully native.** When `event.tool.shell` is undefined, the shape is uncaptured:
   read `event.tool.input` directly, treat the tool as unknown rather than assuming
   a key, and use `replaceInput` with whatever native shape you have verified
   yourself.

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
are modeled separately, each with its own portability answer per target. And the
rewrite path is [Decision 0007](../decisions/0007-portable-shell-write-back.md): the
adapter's per-tool key knowledge is one table driving both the normalized read and
the lowered write, so the two directions cannot skew — and where the table has no
entry, both directions decline rather than guess.

## Next

[Tutorial 3 — Injecting context](03-injecting-context.md): what happens when a target
genuinely *can't* do what a hook requires, and the two honest ways to respond.
