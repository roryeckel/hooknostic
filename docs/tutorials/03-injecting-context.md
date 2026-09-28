# Tutorial 3 — Injecting context

**Example:** [`examples/context-injection`](../../examples/context-injection/) ·
**You'll learn:** the `addContext` effect, hooking two lifecycle points at once, and
how to handle a target that genuinely can't do what you need.

Context injection puts text in front of the model — house rules at session start, a
reminder right before a risky tool call. It's also the first place most projects meet a
real portability wall, which makes it the perfect tour of Hooknostic's honesty
machinery.

## The code

[`src/hooks.ts`](../../examples/context-injection/src/hooks.ts) declares two hooks:

```ts
hook("session.start", {
  id: "repo-context",
  capabilities: { "context.add": "required" },
  async run(event) {
    return addContext(
      [
        `Working directory: ${event.session.cwd}`,
        "House rules: pnpm (not npm), conventional commits, tests before push.",
      ].join("\n"),
    );
  },
}),

hook("tool.before", {
  id: "cwd-reminder",
  match: { kind: "shell" },
  capabilities: { "context.add": "optional" },
  run({ tool }, ctx) {
    if (!ctx.capabilities.has("context.add")) return;
    // Advice, not a guard: where the shape is uncaptured there is nothing
    // to advise on, so this hook simply stays quiet (fails open).
    if (tool.shell?.command.startsWith("cd ")) {
      return addContext("Reminder: prefer absolute paths over cd for tooling commands.");
    }
  },
}),
```

The session-start hook *requires* its capability — this plugin's whole point is those
house rules, so shipping without them would be shipping a lie. The per-tool reminder is
merely nice to have, so it's `optional` with a runtime check (the pattern from
[Tutorial 2](02-rewriting-tool-input.md)). The capability keys are relative to each
hook's event: `context.add` is `session.start.context.add` in the first hook and
`tool.before.context.add` in the second.

Note the two hooks treat an unreadable command differently, on purpose. The guard in
Tutorial 2 refuses a shell call it cannot read; this reminder just says nothing. Guards
fail closed, advice fails open — and `tool.shell?.command` makes that a one-token
decision rather than a default someone forgot to think about.

## The portability wall

Claude Code and Codex both have an exact channel for session-start context. OpenCode
has none — its only context-injection point is during conversation compaction. So
`session.start.context.add` is **unsupported** on OpenCode, and a config that included
OpenCode would fail `check` with an HN201 diagnostic naming this hook, this capability,
and this target.

There is no fourth option where the hook silently does nothing on OpenCode. Your two
honest choices:

**Choice A — narrow the targets (what this example does).** Look at
[`hooknostic.config.ts`](../../examples/context-injection/hooknostic.config.ts):

```ts
targets: {
  // session.start.context.add is exact on claude/codex; opencode has no
  // session-start context channel, so this config intentionally narrows
  // the target set instead of degrading.
  claude: { version: ">=2.1 <3", delivery: "package", output: "./dist/claude" },
  codex:  { version: ">=0.148 <1", delivery: "project", output: "./dist/codex" },
},
```

The plugin simply doesn't offer an OpenCode build. Explicit, and nothing to explain to
users later.

**Choice B — scope the hook, keep the target.** If the plugin had other hooks worth
shipping to OpenCode, you'd instead restrict just this hook:

```ts
hook("session.start", {
  id: "repo-context",
  targets: { include: ["claude", "codex"] },
  capabilities: { "context.add": "required" },
  // ...
}),
```

Intentionally scoping a hook to specific targets is not a portability failure — it
produces no warnings. The capability machinery exists to catch *accidental* meaning
drift, not to forbid deliberate per-target behavior.

(A third lever exists for capabilities that are supported-but-imperfect: the
`compatibility` policy in your config sets how much degradation — `emulated`,
`approximate` — you'll accept, globally or per target. It can't help here, because
unsupported is unsupported; see [Core concepts](../concepts.md#4-capabilities-the-honest-map-between-the-two).)

## Try it

```bash
cd examples/context-injection && node ../../packages/cli/bin/hooknostic.mjs build
```

```bash
claude --plugin-dir ./dist/claude
```

Ask the new session what the house rules are — it knows. Then try adding an
`opencode` target to the config and re-run `check` to see the HN201 diagnostic for
yourself; it tells you both remediation options above.

## Next

[Tutorial 4 — Packaging with Agent Plugins](04-packaging-with-agent-plugins.md): folding
your hooks into a portable plugin package alongside skills.
