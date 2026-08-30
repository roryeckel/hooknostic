# Tutorial 1 — Your first hook

**Example:** [`examples/basic`](../../examples/basic/) ·
**You'll learn:** defining a plugin, blocking a tool call, observing an event, and the
difference between `check` and `build`.

The finished example blocks `git push --force` (while allowing the safer
`--force-with-lease`) and quietly observes session-end events — the two simplest kinds
of hook: one that intervenes, one that only watches.

## Run it first

From a checkout of this repository:

```bash
pnpm install
```

```bash
pnpm build
```

```bash
cd examples/basic && node ../../packages/cli/bin/hooknostic.mjs check
```

(In your own project you'd have the CLI installed as a dependency and run
`npx hooknostic check` — see [Getting started](../getting-started.md).)

`check` resolves both hooks against all three configured targets and passes: every
capability this plugin needs is supported everywhere.

## The code, piece by piece

[`src/hooks.ts`](../../examples/basic/src/hooks.ts):

```ts
import { definePlugin, hook, block } from "@hooknostic/sdk";

export default definePlugin({
  name: "basic-example",
  version: "0.1.0",
  description: "Minimal hooknostic example",
  hooks: [ /* ... */ ],
});
```

A plugin is a default export made with `definePlugin`: a name, a version, and a list of
hooks. The name and version flow into the generated output (they become the Claude
plugin's manifest, for instance).

### Hook 1: intervening

```ts
hook("tool.before", {
  id: "no-force-push",
  match: { kind: "shell" },
  capabilities: {
    "tool.before.block": "required",
  },
  async run(event) {
    // Normalized read with a raw fallback: where the shape is uncaptured
    // (`shell` undefined), a guard must not fail open on an empty string.
    const raw = (event.tool.input as { command?: unknown }).command;
    const command = event.tool.shell?.command ?? (typeof raw === "string" ? raw : "");
    if (/git\s+push\s+.*--force(?!-with-lease)/.test(command)) {
      return block("Use --force-with-lease instead of --force.");
    }
  },
}),
```

Reading it top to bottom:

- **`hook("tool.before", ...)`** — subscribe to the normalized "a tool is about to run"
  event. On Claude Code and Codex that's the native `PreToolUse` event; on OpenCode
  it's the `tool.execute.before` callback. You never see those names.
- **`id`** — a stable identifier. Diagnostics and the build report refer to hooks by
  id, so make it meaningful.
- **`match: { kind: "shell" }`** — only fire for shell tools, using the portable
  classification (Claude's `Bash`, Codex's exec tools, etc. all count as `shell`). The
  hook simply never runs for file edits or web fetches.
- **`capabilities`** — the contract. This hook is pointless if it can't block, so
  `tool.before.block` is `required`: any target that can't block a pending tool call
  would fail the build with a clear diagnostic, rather than shipping a guard that
  silently doesn't guard.
- **`run`** — the logic. `event.tool.input` is the tool's input as the harness reported
  it (for shell tools, an object with a `command`). Returning `block(reason)` stops the
  call and shows the reason; returning nothing (the fall-through) lets it proceed.

### Hook 2: observing

```ts
hook("session.end", {
  id: "observe-session-end",
  async run(event) {
    void event.reason;   // observation only: no effect means continue
  },
}),
```

No `capabilities` block at all: merely using an event implies its `observe` capability,
and observing is all this hook does. A hook that returns nothing never changes
behavior — useful for logging or metrics.

## Build it

```bash
node ../../packages/cli/bin/hooknostic.mjs build
```

You get one self-contained directory per target under `dist/`, plus
`hooknostic-build.json`. Open the report and find `no-force-push`: you'll see
`tool.before.block` resolved as `exact` on all three targets — Claude blocks via a
`permissionDecision: "deny"` response, Codex the same, OpenCode by throwing inside the
callback. Same hook, three mechanisms, one declared meaning.

## Try it live

Pick a harness and follow [Installing built output](../installing-artifacts.md) — the
quickest is Claude Code's one-session flag:

```bash
claude --plugin-dir ./dist/claude
```

Then ask the agent to force-push something. It can't.

## Next

[Tutorial 2 — Rewriting tool input](02-rewriting-tool-input.md) adds the feature that
makes portability practical: capabilities your hook would *like* but can live without.
