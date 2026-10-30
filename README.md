<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hooknostic-mark-dark.svg">
    <img src="docs/assets/hooknostic-mark-light.svg" alt="Hooknostic logo" width="112">
  </picture>
</p>

<h1 align="center">Hooknostic</h1>

<p align="center">
  <strong>Portable hooks, skills, and MCP servers for coding agents. Build native plugins for
  Claude Code, Codex, and GitHub Copilot CLI, or maintain integrations directly in your repository.</strong>
</p>

Keep one portable source and let Hooknostic translate it for **Claude Code**, **OpenAI
Codex CLI**, **GitHub Copilot CLI**, **OpenCode**, and **Pi**. Adapters handle native packaging, component configuration,
project discovery, and lifecycle behavior. Before writing output, Hooknostic checks what
each target can deliver and reports every compatibility shortfall.

## Standards in, native integrations out

[Agent Plugins 1.0](https://agent-plugins.org/specification) defines portable packages:
a manifest, Agent Skills, MCP servers, and namespaced client extensions. Hooknostic
validates that format and projects it into native harness artifacts. The source package
stays unchanged. Portable TypeScript hooks can accompany it, or be used on their own;
hooks are outside the standard's v1 portable component set. So are agents: Hooknostic's
provisional [agent definition format](docs/spec/agents/0.1.md) compiles one
Markdown file into each harness's own agent file (ADR-0034, proposed).

```text
Agent Plugins 1.0 package ─┐                 ┌─ Claude Code plugin → marketplace
TypeScript hooks ──────────┼─ check / build ─├─ Codex plugin       → marketplace
Direct skills / MCP ───────┘                 ├─ Copilot plugin     → marketplace or --plugin-dir
                                             ├─ OpenCode package or project artifact
                                             └─ Pi package or project artifact
                                  sync ──────── native repository wiring
```

The same source can contain hooks, skills, and MCP together, or only the components you
need. Native outputs are ready for their harness's installation workflow. Authors still
register their marketplace and list the built plugins; Hooknostic does not submit listings.

## Choose your starting point

Requires Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`. Install the CLI and configuration/hook authoring SDK:

```sh
npm install --save-dev hooknostic @hooknostic/sdk
```

| Your goal | Workflow | Start here |
| --- | --- | --- |
| Distribute a plugin | Author an Agent Plugins package, `check`, `build`, then install native output through a marketplace or package manager | [Combined package and marketplace tutorial](docs/tutorials/04-packaging-with-agent-plugins.md) |
| Maintain a repository | Keep portable hooks, skills, and MCP; `init --local`, `sync --dry-run`, `sync`, then `verify` | [Repository integration](docs/project-integration.md) |
| Write portable hooks | Author one TypeScript entry and choose package or project delivery | [First hook walkthrough](docs/getting-started.md) |

`build` writes distributable artifacts. `sync` additionally maintains project discovery
files and ownership records. Trust prompts, dependency installation, and activation remain
explicit harness/user steps. [Scope and contribution contract](CONTRIBUTING.md).

## One package, multiple targets

```text
portable/
├── plugin.json
├── skills/greet/SKILL.md
└── mcp.json
src/hooks.ts                 # optional
hooknostic.config.ts
```

```ts
import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  entry: "./src/hooks.ts",
  components: { root: "./portable" },
  targets: {
    claude: { version: ">=2.1 <3", delivery: "package", output: "./dist/claude" },
    codex: { version: ">=0.153 <1", delivery: "package", output: "./dist/codex" },
    copilot: { version: ">=1.0.101 <2", delivery: "package", output: "./dist/copilot" },
    opencode: { version: ">=2.0.17 <3", delivery: "package", output: "./dist/opencode" },
    pi: { version: ">=1 <2", delivery: "package", output: "./dist/pi" },
  },
});
```

Omit `entry` for a hookless package. For direct repository sources, use
`components.skills` / `components.mcp` and project delivery instead of a package root.
`components.agents` adds a directory of agent definitions to either form.

Pi 1.x receives the hooks, skills, and stdio and streamable-HTTP MCP servers,
which a generated extension registers with pi's native MCP client. pi rejects
the legacy SSE transport, so a package with an SSE server must accept
`pi:mcp-sse-omitted`. A `>=0.84 <1` target has no native MCP channel at all:
there `pi:mcp-stdio-omitted` and `pi:mcp-streamable-http-omitted` accept the
omissions, support remains `unsupported`, and the report records the skipped
servers. Other unsupported components still fail. See
[component policies](docs/configuration.md#compatibility-and-component-policies).

Skills may declare `metadata: { hooknostic/allow-implicit-invocation: "false" }`
to require explicit user invocation across supported harness versions. Author
them in `skills/` and let Hooknostic own the native copies; missing gates fail
unless the skill is omitted or the specific shortfall is explicitly accepted.
See [invocation policy](docs/project-integration.md) for authoring and support checks.
The [existing combined example](examples/agent-plugin/) includes a bundled MCP server,
so its generated packages run without workspace dependencies. OpenCode v1 remains
available through an explicit version range; see [version families](docs/opencode-families.md).

## Portable hooks

Coding agents expose different lifecycle events and different actions at those events.
Hooknostic lets you express the hook once and declare which capabilities it needs:

```ts
// src/hooks.ts
import { definePlugin, hook, block, updateShell } from "@hooknostic/sdk";

export default definePlugin({
  name: "portable-repo-hooks",
  hooks: [
    hook("tool.before", {
      id: "protect-shell",
      match: { kind: "shell" },
      capabilities: { block: "required", "input.replace": "optional" },
      run({ tool }, ctx) {
        // Normalized across harnesses; undefined only where the tool's shape is
        // uncaptured -- and a guard refuses what it cannot read.
        const command = tool.shell?.command;
        if (command === undefined) return block(`Unrecognized ${tool.nativeName} input`);
        if (command.includes("rm -rf /")) return block("Refusing destructive root deletion");
        if (ctx.capabilities.has("input.replace") && command.startsWith("npm ")) {
          // Lands under whichever key this harness uses, siblings preserved.
          return updateShell({ command: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),
  ],
});
```

That one file blocks a destructive command on every supported harness, and rewrites
`npm` to `pnpm` on the ones that support input rewriting — falling back gracefully
(and visibly) where they don't. Capability keys are relative to the hook's event
(`block` means `tool.before.block`), and a hook can return several effects at once
(`[notify(message), preventStop(reason)]`). File tools get the same treatment as shell
tools: `tool.file?.paths` lists every file a call targets, whatever each harness names
the argument.

## Commands at a glance

```sh
hooknostic init --local         # scaffold a repository integration
hooknostic check                # compile and validate without writing target artifacts
hooknostic build                # emit native artifacts and a build report
hooknostic sync --dry-run       # preview repository changes
hooknostic sync                 # reconcile owned project wiring
hooknostic verify               # detect integration drift
hooknostic doctor               # diagnose installed versions and activation
hooknostic inspect codex --delivery package --component agent-plugin.mcp.stdio --config hooknostic.config.ts
hooknostic dispatch --target claude --events events.jsonl
```

`build` and `sync` are alternatives, not consecutive steps. In a repository integration,
`sync` writes the same artifacts as `build` and also records their ownership, so use `sync`
there. It refuses files that an earlier `build` left without an ownership record; move
them aside first ([project integration](docs/project-integration.md)).

See the [command reference](docs/configuration.md). Trusted materializers may run during
compilation, including `check`; review their network/cache behavior like other build code.

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
plain-language tour of the concepts, two delivery workflows, and step-by-step
tutorials built on the [examples](examples/).

- [Configuration and commands](docs/configuration.md) — sources, delivery, policies, dependencies, and reports
- [Marketplace packages](docs/tutorials/04-packaging-with-agent-plugins.md) — install the combined example in Claude, Codex, and Copilot
- [Repository integration](docs/project-integration.md) — sync, verify, ownership, and recovery
- [Core concepts](docs/concepts.md) — events, effects, capabilities, and the build
  pipeline, in plain language
- [Getting started](docs/getting-started.md) — from empty folder to installed hooks
- [Writing hooks safely](docs/writing-hooks-safely.md) — stdout, side effects,
  `process.execPath`, stop loops, and `HOOKNOSTIC_DEBUG`
- [Tutorials](docs/tutorials/) — guided walkthroughs of every example plugin
- [Installing built output](docs/installing-artifacts.md) — pointing each harness at
  `hooknostic build` output, including a repo that consumes its own hooks
- [Design document](docs/design.md) — the full architecture, contracts, and milestones
- [Native surface baseline](docs/baseline-2026-08-20.md) — the verified,
  primary-source snapshot of each harness the adapters are built against
- [Adding an adapter](docs/adding-an-adapter.md) — how to support a new harness
- [Dependency inventory](docs/dependencies.md) — authoritative versions, reviewed updates, and artifact refresh
- [Design decisions](docs/decisions/) — why capabilities are separate from events, why
  hooks are stateless, why one dispatcher, how Agent Plugins fits in, and which
  effects end a dispatch
- [Glossary](docs/glossary.md) — every term of art used in these docs, defined

## Repository

Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` / pnpm 12 + TypeScript monorepo. Use the pnpm version pinned in
`package.json`; compiler versions and compatibility constraints are documented in
[Dependencies](docs/dependencies.md):

| Package | Purpose |
| --- | --- |
| `@hooknostic/sdk` | Public authoring API and canonical types |
| `@hooknostic/agent-plugin` | Public Agent Plugins 1.0 loader, schemas, and projection contracts |
| `@hooknostic/core` | Compiler: config loading, plugin model, capability analysis, diagnostics |
| `@hooknostic/runtime` | Dispatcher: decode events → run your handlers → apply effects |
| `hooknostic` | CLI: compile, reconcile projects, inspect support, and test hooks |
| `@hooknostic/adapter-{claude,codex,copilot,opencode,pi}` | Per-harness adapters (internal) |
| `@hooknostic/testkit` | Fixtures, fake adapters, and the adapter contract suite |

```
pnpm install
pnpm build      # typecheck + bundle runtime/CLI output
pnpm test       # vitest
pnpm lint
```

## Support and status

Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode (v1 and v2 families), and Pi
are each supported for package and project delivery. The
[generated support table](docs/harness-support.md) is the authority: version ranges,
the support level of every component, and the captured evidence behind each claim.
This section flags only what is most likely to change a decision.

A weekly [harness-watch](docs/harness-watch.md) workflow detects new harness releases
on npm, runs the model-free playback suite against them, and records each pass in that
table, so support tracks upstream releases rather than a one-time snapshot. A failure
opens an issue instead.

**macOS has unit and fixture coverage, but no real-harness playback evidence.**
Shell-interpreter captures exist there for every harness except Pi; end-to-end
harness behavior is established on Windows and Linux.

Known limits worth reading before you rely on a harness:

- **Codex CLI**: installed-plugin (package) hooks need a newer Codex than repository
  hooks, so package support has a narrower version range.
- **GitHub Copilot CLI**: repository hooks load only in a trusted folder and from the
  directory the session starts in. Copilot also reads Claude Code's
  `.claude/settings.json` hooks and root `.mcp.json`, so Hooknostic keeps each harness
  on its own generated output when a project targets both
  ([ADR-0033](docs/decisions/0033-no-cross-harness-compatibility-reads.md),
  [installation](docs/installing-artifacts.md#github-copilot-cli)).
- **OpenCode v2**: context injection and stop behavior are approximate, and Code Mode
  MCP calls are not normalized to `kind: "mcp"`. Read
  [OpenCode families](docs/opencode-families.md) before relying on those capabilities.
- **Pi**: has no permission event, so permission hooks are unsupported. Pi 1.x runs
  stdio and streamable-HTTP MCP servers through its native client and rejects SSE
  ([details above](#one-package-multiple-targets),
  [installation](docs/installing-artifacts.md#pi)).

Release notes: [release highlights](docs/release-highlights.md).

The default compatibility minimum is `emulated`. Unsupported components and degraded
items fail by default; known standard deviations warn and remain visible in the report.
Use [component policies](docs/configuration.md#compatibility-and-component-policies) to
require exact behavior or accept a specific documented exception.

**A note on trust:** Hooknostic hook execution is not a sandbox or security boundary.
Generated integrations preserve each harness's own trust and review mechanisms — Codex
in particular requires project trust plus per-hook trust for repo-level hooks — and
Hooknostic never modifies that trust state on your behalf.

**And on scope:** Hooknostic reports differences between harnesses rather than hiding
them. Where a harness cannot do something, the answer is `unsupported` with a reason —
never an emulation that quietly behaves differently. [CONTRIBUTING.md](CONTRIBUTING.md)
states that boundary in full.

## Contributing

Contributions are welcome, and the scope statement in
[CONTRIBUTING.md](CONTRIBUTING.md) is written so you can tell whether an idea fits
*before* writing any code. The short version: every claim about a harness needs captured
evidence, docs and bug fixes can arrive as pull requests directly, and anything touching
a harness claim or the portable vocabulary should start as an issue.

Adapter changes can be verified against the real harness binaries with **no model
credentials and no spend** — see [docs/testing.md](docs/testing.md).

Everyone participating is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Hooknostic generates code that runs inside your agent's trust boundary. Please report
vulnerabilities privately rather than in a public issue —
[SECURITY.md](SECURITY.md) explains the reporting route and what is in scope.

## License

[Apache License 2.0](LICENSE).
