# Hooknostic

**Portable lifecycle hooks for coding-agent harnesses.** Author TypeScript hooks once;
Hooknostic checks whether each configured harness can implement the declared semantics,
reports exact/emulated/approximate/unsupported mappings, and emits the smallest native
bridge for every valid target.

v0.1 targets **Claude Code**, **OpenAI Codex CLI**, and **OpenCode**.

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
        const { command = "" } = event.tool.input as { command?: string };
        if (command.includes("rm -rf /")) return block("Refusing destructive root deletion");
        if (ctx.capabilities.has("tool.before.input.replace") && command.startsWith("npm "))
          return replaceInput({ command: command.replace(/^npm /, "pnpm ") });
      },
    }),
  ],
});
```

```
hooknostic check     # can the source satisfy the configured targets? (no artifacts)
hooknostic build     # check + bundle + emit self-contained per-target artifacts
hooknostic doctor    # are installed harness versions within validated ranges?
hooknostic inspect   # why does an adapter map a capability the way it does?
```

The central design rule: **event availability and effect semantics are separate.** A
harness may expose a "before tool" event while differing in whether code can block the
call, request approval, rewrite input, or add model-visible context. Hooknostic makes
those differences explicit through versioned, adapter-owned capability matrices instead
of hiding them behind optimistic adapters.

## Documentation

- [Design document](docs/design.md) — full architecture, contracts, and milestones
- [Native surface baseline](docs/baseline-2026-08-20.md) — primary-source snapshot the
  adapters are built against
- [Installing built artifacts](docs/installing-artifacts.md) — pointing each harness at
  `hooknostic build` output, including a repo that consumes its own artifacts
- [Adding an adapter](docs/adding-an-adapter.md) — the fixture-first adapter workflow
- [ADRs](docs/adr/) — semantic capability model, invocation-stateless contract,
  one-dispatcher composition, Agent Plugins relationship

## Repository

Node.js 22.13+ / pnpm 11 + TypeScript monorepo:

| Package | Purpose |
| --- | --- |
| `@hooknostic/sdk` | Public authoring API and canonical types |
| `@hooknostic/core` | Compiler: config, Plugin IR, capability analysis, diagnostics |
| `@hooknostic/runtime` | Dispatcher: decode → compose handlers → apply effects |
| `hooknostic` | CLI: `check` / `build` / `doctor` / `inspect` |
| `@hooknostic/adapter-{claude,codex,opencode}` | Harness adapters (internal) |
| `@hooknostic/testkit` | Fixtures, fake adapters, contract-test helpers |

```
pnpm install
pnpm build      # typecheck + bundle runtime/CLI artifacts
pnpm test       # vitest
pnpm lint
```

## Status

v0.1: all three adapters are implemented against fixtures captured from real
installed harnesses (Claude Code 2.1.238, Codex CLI 0.148.0, OpenCode 1.18.18) and
verified by live smoke tests (`HOOKNOSTIC_SMOKE=1 pnpm test`): tool blocking, input
rewriting, and context injection observed working end-to-end in real sessions of all
three. `check`, `build`, `doctor`, and `inspect` are functional; builds are atomic
(nothing is committed until every selected target passes) and reproducible from
configured version ranges, never the locally installed harness.

Hooknostic hook execution is **not a sandbox or security boundary**; generated
integrations preserve each harness's own trust and review mechanisms (Codex in
particular requires project trust + per-hook trust for repo-level hooks).
