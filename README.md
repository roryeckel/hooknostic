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
- [ADRs](docs/adr/) — semantic capability model, invocation-stateless contract,
  one-dispatcher composition, Agent Plugins relationship

## Repository

pnpm + TypeScript monorepo:

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

Pre-release (v0.1 in progress). "Hooknostic" hook execution is **not a sandbox or
security boundary**; generated integrations preserve each harness's own trust and review
mechanisms.
