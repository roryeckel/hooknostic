# Examples

Four runnable projects, each the companion to a [tutorial](../docs/tutorials/) that
walks through it line by line. They grow in scope in order:

| Example | Shows | Tutorial |
| --- | --- | --- |
| [`basic/`](basic/) | Block a dangerous shell command; observe session end | [1 — Your first hook](../docs/tutorials/01-your-first-hook.md) |
| [`rewrite-shell/`](rewrite-shell/) | Required vs optional capabilities; rewrite `npm` → `pnpm` with runtime feature detection | [2 — Rewriting tool input](../docs/tutorials/02-rewriting-tool-input.md) |
| [`context-injection/`](context-injection/) | Inject model-visible context at two lifecycle points; narrow targets when one can't comply | [3 — Injecting context](../docs/tutorials/03-injecting-context.md) |
| [`agent-plugin/`](agent-plugin/) | Combine hooks with an Agent Plugins package (manifest + skill); metadata inheritance | [4 — Packaging with Agent Plugins](../docs/tutorials/04-packaging-with-agent-plugins.md) |

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

`rewrite-shell/` and `agent-plugin/` have their built output (`dist/`,
`hooknostic-build.json`, and for `agent-plugin/` the generated
`com.anthropic.claude-code/` extension directory) committed, so you can inspect what a
build produces without running one.

To load the output into a real harness, see
[Installing built output](../docs/installing-artifacts.md).
