# Tutorial 4 — Packaging with Agent Plugins

**Example:** [`examples/agent-plugin`](../../examples/agent-plugin/) ·
**You'll learn:** combining Hooknostic hooks with an Agent Plugins package, metadata
inheritance, and where generated files land in a combined package.

[Agent Plugins](https://github.com/agentplugins/agent-plugins-spec) is a vendor-neutral
standard for packaging portable agent extensions — skills, MCP configuration, and a
`plugin.json` manifest. What it deliberately leaves client-specific is lifecycle hooks.
That's the exact gap Hooknostic fills, and the two compose cleanly: the standard
provides a formal extension mechanism (reverse-domain-namespaced directories like
`com.anthropic.claude-code/`), and Hooknostic emits into it.

## The package layout

```
examples/agent-plugin/
├── plugin.json                  ← Agent Plugins manifest (name, version, description)
├── skills/greet/SKILL.md        ← a portable skill, untouched by Hooknostic
├── hooknostic.config.ts
├── src/hooks.ts
└── com.anthropic.claude-code/   ← generated: hooks in the standard's extension slot
    ├── hooks/hooks.json
    └── runtime/hooknostic.mjs
```

One directory is simultaneously a valid Agent Plugins package *and* carries compiled
hooks where the standard says client-specific data belongs.

## Turning it on

One config line ([`hooknostic.config.ts`](../../examples/agent-plugin/hooknostic.config.ts)):

```ts
export default defineConfig({
  entry: "./src/hooks.ts",
  targets: { /* claude / codex / opencode as usual */ },

  agentPlugin: { root: "." },   // ← "this directory is an Agent Plugins package"
});
```

With that set, `hooknostic build` does two extra things:

1. **Reads `plugin.json` for metadata.** In
   [`src/hooks.ts`](../../examples/agent-plugin/src/hooks.ts) the plugin declares only
   a `name` — `version` and `description` are inherited from the manifest, so there's
   one source of truth.
2. **Emits the Claude hook files into `com.anthropic.claude-code/`** (in addition to
   the normal `dist/` outputs), so a repository that already *is* an Agent Plugin
   carries its hooks in the standard's conventional location rather than a
   Hooknostic-specific one.

## The boundary Hooknostic never crosses

This integration is governed by
[Decision 0004](../decisions/0004-agent-plugins-relationship.md), and the rules are
strict because the manifest schema is closed (unknown top-level fields make a package
non-conforming):

- Hooknostic **reads** `plugin.json`; it never writes or modifies it.
- It never adds root-level manifest fields, and never touches the portable parts
  (`skills/`, `mcp.json`).
- The whole integration is optional — everything in tutorials 1–3 worked with no
  `plugin.json` in sight, and that standalone mode stays first-class.

## The hook itself

This example's hook guards file reads instead of shell commands:

```ts
hook("tool.before", {
  id: "protect-env-files",
  match: { kind: "file.read" },
  capabilities: { "tool.before.block": "required" },
  async run(event) {
    const { file_path: filePath = "" } = event.tool.input as { file_path?: string };
    if (/\.env(\.|$)/.test(filePath)) {
      return block("Reading .env files is not allowed by this plugin.");
    }
  },
}),
```

Nothing new mechanically — but note `match: { kind: "file.read" }`: the same portable
tool classification from Tutorial 1, on a different tool family. One caution worth
repeating from the [concepts page](../concepts.md#what-hooknostic-is-not): a hook like
this is a guardrail against accidents, not a security boundary — some harness tool
paths bypass hooks entirely.

## Build and poke around

```bash
cd examples/agent-plugin && node ../../packages/cli/bin/hooknostic.mjs build
```

Compare `dist/claude/hooks/hooks.json` with
`com.anthropic.claude-code/hooks/hooks.json`, and check
`dist/claude/.claude-plugin/plugin.json` — its version and description came from the
Agent Plugins manifest. The `skills/greet` skill rides along untouched: portable
packaging from the standard, portable hooks from Hooknostic.

## Where to go from here

You've now seen the whole authoring surface: blocking, rewriting, context injection,
observation, required/optional capabilities, target scoping, and packaging. From here:

- [Installing built output](../installing-artifacts.md) — the production install story
  per harness, including updates and trust.
- [Core concepts](../concepts.md) and the [design document](../design.md) — the full
  model when you need the fine print.
- [Adding a harness adapter](../adding-an-adapter.md) — if your favorite agent isn't
  supported yet.
