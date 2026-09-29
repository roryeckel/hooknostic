# Synthetic repository-local example

From the Hooknostic checkout root:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/bin/hooknostic.mjs sync --config examples/local-project/hooknostic.config.ts
node packages/cli/bin/hooknostic.mjs verify --config examples/local-project/hooknostic.config.ts
```

Edit `hooks.ts`, `skills/`, `mcp.json`, or `agents/`, sync, review generated changes, then verify. The
example commits native wiring, runtime artifacts, copied skill resources, and
`.hooknostic/integration.json`. It has no Agent Plugins manifest. Dependencies
and harness activation are explicit human steps; sync does neither.

All three harnesses receive hooks, skills, a synthetic stdio MCP server, and a
`reviewer` subagent written once in `agents/reviewer.md` as a
[portable subagent definition](../../docs/spec/subagents/0.1.md). Its `native` block
limits it to read-only tools on Claude and denies edits and shell on OpenCode. Codex
has no per-agent tool list, so there it keeps the session's tools and sandbox.
The server has no dependencies beyond Node and starts only when the harness
activates it. Additional transport and source-path behavior is exercised by
credential-free local playback fixtures. See the
[local integration guide](../../docs/project-integration.md) for MCP configuration.
