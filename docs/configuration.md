# Configuration and commands

Install `hooknostic` and `@hooknostic/sdk` with Node.js 22.13 or newer. Configuration
is executable TypeScript or JavaScript; review it and its imported providers before
running a command. Paths resolve from `hooknostic.config.ts`.

## Choose your sources and delivery

| Input | Configuration | Use |
| --- | --- | --- |
| Portable hooks | `entry: "./src/hooks.ts"` | Hooks alone or alongside components |
| Agent Plugins 1.0 package | `components: { root: "./portable" }` | Standard manifest, skills, MCP, and supported client extensions |
| Direct project components | `components: { skills: ["./skills"], mcp: "./mcp.json" }` | Repository integration without a package manifest; either field can be used alone |
| Subagent definitions | `components: { subagents: ["./agents"] }` | [Portable subagents](spec/subagents/0.1.md), alone or beside either of the above |

At least one of `entry` and `components` is required. A package root and direct
`skills`/`mcp` sources are mutually exclusive; `subagents` combines with either.
`components.targets` optionally narrows which configured targets receive components;
hooks retain their configured target set.

`components.subagents` names directories of flat `<name>.md` files in the
[Hooknostic Subagent Definition 0.1](spec/subagents/0.1.md) format: a name, a
description, harness-only fields under `native`, and the instructions as the body.
Project delivery writes each harness's own agent file (`.claude/agents/<name>.md`,
`.codex/agents/<name>.toml`, `.opencode/agents/<name>.md`). Beside a package `root`,
package delivery translates them into the package instead: a Claude plugin agent, or
an agent the OpenCode module registers. A Codex plugin has no agents route, so a Codex
package target reports them as unsupported. `hooknostic inspect <target> --component
subagents.definition` shows a target's level and evidence.

Every target has a version range, `delivery`, and output directory. A target name
defaults to its adapter id; set `adapter` explicitly for multiple named targets.

- `delivery: "package"`: native distributable output. Components require package identity.
- `delivery: "project"`: project artifacts. Direct components and synchronization use
  `project: { root: "." }`. Only one synchronized target per adapter is allowed.
- Build ranges select the adapter behavior; installed versions do not change compilation.
  See [harness support](harness-support.md) and [OpenCode families](opencode-families.md).

## Compatibility and component policies

Support levels are `exact`, `emulated`, `approximate`, and `unsupported`.
`compatibility.minimum` defaults to `emulated`; `onBelowMinimum` defaults to `error`.
Set these globally or on a target. Optional hook capabilities must be checked at
runtime with `ctx.capabilities.has(...)`, which accepts the key as declared
(`"input.replace"`) or its full id (`"tool.before.input.replace"`).

| Component option | Default | Meaning |
| --- | --- | --- |
| `onInvalid` | `error` | Invalid component the loader would skip |
| `onUnsupported` | `error` | Valid component the target cannot represent |
| `onDegraded` | `error` | Emitted item falls short of its component's advertised fidelity |
| `onDeviation` | `warn` | Harness behavior departs from Agent Plugins 1.0 |
| `accept` | `[]` | Qualified deviation/degradation ids explicitly accepted by the author |

An accepted instance remains visible as information in diagnostics and the report.
Unknown ids fail validation. Acceptance does not make unsupported components work.
For strict translation, set `compatibility.minimum: "exact"` and
`components.onDeviation: "error"`. For a known exception, accept its specific id
instead of reducing every diagnostic to a warning.

## Dependencies and included files

- Bundle a Node MCP server when it must run without an install-time package manager.
  The [combined example](tutorials/04-packaging-with-agent-plugins.md) does this through
  an author-owned `components.materialize` provider.
- `components.runtimePackage` is a separate, captured Claude marketplace npm contract.
  It is not a portable dependency installer. See [runtime dependencies](installing-artifacts.md#the-npm-case).
- `components.exclude` adds exclusions to the built-in filters for repository data,
  secrets files, source config/hooks, dependency directories, and target output.
- `executableFiles` explicitly assigns portable executable permission; other files use 0644.
- Packaged MCP declarations keep the standard's placeholder rules. Direct project
  sources have separate environment handling. `mcpEnvironment` declares ambient variable
  names for packaged servers; `mcpOverrides` applies only to direct project sources.

Materializers are trusted build programs and can use network or persistent caches.
`check` and `verify` do not promise to suppress those provider side effects.

## Commands

| Command | Result |
| --- | --- |
| `init --local` | Create missing project configuration and empty hooks without overwriting files |
| `check` | Compile and validate in memory; no target artifacts written |
| `build` | Write artifacts and the build report |
| `sync --dry-run` | Preview project reconciliation and conflicts |
| `sync` | Apply generated wiring and update ownership records |
| `verify` | Compare generated integration with the project; report drift |
| `recover` | Recover an interrupted project transaction when its preconditions still hold |
| `doctor` | Inspect installed versions, runtime availability, wiring, and activation guidance |
| `inspect <target>` | Explain hook capabilities or component support |
| `dispatch --target <target>` | Run hooks against portable JSON Lines events for tests |

Use `--config <path>` to select a configuration. `check` and `build` accept
`--target <a,b>` to narrow the configured targets; project reconciliation commands
process the whole integration and reject that flag. Most commands accept `--json`;
`dispatch` always returns JSON Lines and accepts `--events <path>` or stdin.

```sh
hooknostic inspect codex --delivery package --component agent-plugin.mcp.stdio --config hooknostic.config.ts
hooknostic dispatch --target claude --events events.jsonl
```

Project commands return 0 on success, 1 for verification drift, and 2 for invalid
configuration, conflicts, or operational failure. A dry run with changes succeeds;
a dry run with conflicts fails. See `hooknostic --help` for the complete flag list.

## Build reports and troubleshooting

`hooknostic-build.json` is written beside the configuration. It records requested
targets, support decisions, diagnostics, inventoried source files, and projected,
omitted, degraded, or deviating components. Read it before assuming a successful
build means every authored component shipped. The checked-in examples relocate
their report under `dist/` only as part of the repository regeneration script.

Start with `check`, inspect the reported component/capability, then use `doctor` for
activation guidance. For synchronized repositories, use `verify` and review the
ownership record before `sync`. See [project integration](project-integration.md)
for conflicts and recovery, and [testing hooks](testing-your-hooks.md) for dispatch tests.
