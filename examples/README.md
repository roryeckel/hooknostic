# Examples

Four runnable projects, each the companion to a [tutorial](../docs/tutorials/) that
walks through it line by line. They grow in scope in order:

| Example | Shows | Tutorial |
| --- | --- | --- |
| [`basic/`](basic/) | Block a dangerous shell command; observe session end | [1 — Your first hook](../docs/tutorials/01-your-first-hook.md) |
| [`rewrite-shell/`](rewrite-shell/) | Required vs optional capabilities; rewrite `npm` → `pnpm` with runtime feature detection | [2 — Rewriting tool input](../docs/tutorials/02-rewriting-tool-input.md) |
| [`context-injection/`](context-injection/) | Inject model-visible context at two lifecycle points; narrow targets when one can't comply | [3 — Injecting context](../docs/tutorials/03-injecting-context.md) |
| [`agent-plugin/`](agent-plugin/) | Combine hooks with an Agent Plugins package (manifest + skill + MCP server); metadata inheritance | [4 — Packaging with Agent Plugins](../docs/tutorials/04-packaging-with-agent-plugins.md) |

## Running them

From the repository root:

```bash
pnpm install && pnpm build
```

then, inside any example directory:

```bash
node ../../packages/cli/bin/hooknostic.mjs check
```

```bash
node ../../packages/cli/bin/hooknostic.mjs build
```

`rewrite-shell/` and `agent-plugin/` commit their built output (`dist/` and
`dist/hooknostic-build.json`), so you can inspect what a
build produces without running one — and so this
repository practises the committed-artifact model that
[ADR-0006](../docs/decisions/0006-artifact-distribution.md) recommends to
consumers. CI rebuilds it and fails on any diff, which is what keeps the two
honest: an unreproducible build is caught here rather than in someone else's
repository.

`agent-plugin/` is committed specifically because it is the only example using
`components`, and that config shape is where a machine-specific path can reach
the build report — a gate that rebuilds only `rewrite-shell` cannot see it.

The other two examples are built on demand and their output is gitignored.

To load the output into a real harness, see
[Installing built output](../docs/installing-artifacts.md).
