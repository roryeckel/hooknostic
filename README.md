# Hooknostic

**Write lifecycle hooks for your coding agent once — run them in Claude Code, OpenAI
Codex CLI, and OpenCode.**

Coding agents let you hook into their lifecycle: run code before a tool executes, when
a session starts, when the agent wants to stop. The problem is that every agent — we
call each one a *harness* — has its own hook format, event names, and rules about what
hook code is actually allowed to do. The same "block dangerous shell commands" hook
gets written three times, three different ways.

Hooknostic fixes that. You author hooks once in TypeScript, and Hooknostic:

1. **Checks** whether each harness you target can actually deliver the behavior your
   hooks rely on — before anything is generated.
2. **Reports** exactly how each behavior maps: natively supported (`exact`), achieved a
   different way (`emulated`), close-but-different (`approximate`), or `unsupported`.
3. **Builds** the smallest possible native integration for every target that passes.

v0.1 targets **Claude Code**, **OpenAI Codex CLI**, and **OpenCode**.

## What it looks like

```ts
// src/hooks.ts
import { definePlugin, hook, block, replaceInput } from "@hooknostic/sdk";

export default definePlugin({
  name: "portable-repo-hooks",
  hooks: [
    hook("tool.before", {
      id: "protect-shell",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        const command = event.tool.shell?.command ?? "";
        if (command.includes("rm -rf /")) return block("Refusing destructive root deletion");
        if (ctx.capabilities.has("tool.before.input.replace") && command.startsWith("npm ")) {
          // Reading is portable; writing back is not -- keep every other field
          // and set the key this harness actually used.
          const input = event.tool.input as Record<string, unknown>;
          const key = "cmd" in input ? "cmd" : "command";
          return replaceInput({ ...input, [key]: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),
  ],
});
```

That one file blocks a destructive command on all three harnesses, and rewrites
`npm` to `pnpm` on the ones that support input rewriting — falling back gracefully
(and visibly) where they don't.

```
hooknostic check     # can my hooks work on every configured target? (no files written)
hooknostic build     # check, then generate ready-to-install output per target
hooknostic doctor    # are my installed agent versions within the validated ranges?
hooknostic inspect   # why does a target support (or not support) a given behavior?
```

## The idea in one paragraph

The central design rule: **being told about an event and being allowed to act on it
are two different things.** A harness may fire a "before tool" event but differ in
whether your code can block the call, ask the user for approval, rewrite the tool's
input, or add context the model can see. Hooknostic models each of those actions as a
named *capability*, and every adapter ships a versioned table of what its harness
really supports — so differences are explicit and inspectable, never silently papered
over by an optimistic translation layer.

## Documentation

**New here? Start with the [documentation wiki](docs/README.md)** — it has a
plain-language tour of the concepts, a getting-started walkthrough, and step-by-step
tutorials built on the [examples](examples/).

- [Core concepts](docs/concepts.md) — events, effects, capabilities, and the build
  pipeline, in plain language
- [Getting started](docs/getting-started.md) — from empty folder to installed hooks
- [Tutorials](docs/tutorials/) — guided walkthroughs of every example plugin
- [Installing built output](docs/installing-artifacts.md) — pointing each harness at
  `hooknostic build` output, including a repo that consumes its own hooks
- [Design document](docs/design.md) — the full architecture, contracts, and milestones
- [Native surface baseline](docs/baseline-2026-08-20.md) — the verified,
  primary-source snapshot of each harness the adapters are built against
- [Adding an adapter](docs/adding-an-adapter.md) — how to support a new harness
- [Design decisions](docs/decisions/) — why capabilities are separate from events, why
  hooks are stateless, why one dispatcher, how Agent Plugins fits in, and which
  effects end a dispatch
- [Glossary](docs/glossary.md) — every term of art used in these docs, defined

## Repository

Node.js 22.13+ / pnpm 11 + TypeScript monorepo:

| Package | Purpose |
| --- | --- |
| `@hooknostic/sdk` | Public authoring API and canonical types |
| `@hooknostic/core` | Compiler: config loading, plugin model, capability analysis, diagnostics |
| `@hooknostic/runtime` | Dispatcher: decode events → run your handlers → apply effects |
| `hooknostic` | CLI: `check` / `build` / `doctor` / `inspect` |
| `@hooknostic/adapter-{claude,codex,opencode}` | Per-harness adapters (internal) |
| `@hooknostic/testkit` | Fixtures, fake adapters, and the adapter contract suite |

```
pnpm install
pnpm build      # typecheck + bundle runtime/CLI output
pnpm test       # vitest
pnpm lint
```

## Status

v0.1: all three adapters are implemented against fixtures captured from real installed
harnesses (Claude Code 2.1.238, Codex CLI 0.148.0, OpenCode 1.18.18) and verified by
live smoke tests (`HOOKNOSTIC_SMOKE=1 pnpm test`): tool blocking, input rewriting, and
context injection observed working end-to-end in real sessions of all three. `check`,
`build`, `doctor`, and `inspect` are functional; builds are atomic (nothing is written
until every selected target passes) and reproducible from the version ranges in your
config — never from whatever happens to be installed locally.

**A note on trust:** Hooknostic hook execution is not a sandbox or security boundary.
Generated integrations preserve each harness's own trust and review mechanisms — Codex
in particular requires project trust plus per-hook trust for repo-level hooks — and
Hooknostic never modifies that trust state on your behalf.
