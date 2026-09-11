# Repository-local playback evidence

Recorded 2026-09-11 on Windows, Node 24.20.0. Commands run the production adapter
integrators and reconciliation engine in a synthetic temporary project, then point
the real harness at a credential-free scripted loopback model. No paid requests,
user-wide installation, or persistent trust changes are part of this probe.

| Harness | Observed version | Passed local assertions |
| --- | --- | --- |
| Claude Code | 2.1.268 | Project settings hook dispatch; `.claude/skills` discovery; stdio, Streamable HTTP, and SSE MCP |
| Codex | 0.153.2 | Project `.codex/hooks.json` dispatch; `.agents/skills` discovery |
| OpenCode | 1.18.29 | Project discovery module dispatch; native skill directory references; stdio, Streamable HTTP, and SSE MCP |

Reproduce with `HOOKNOSTIC_PLAYBACK=<adapter> pnpm exec vitest run
packages/cli/test/harness-playback.test.ts -t "repository-local integration"`.
Use the platform's environment-variable syntax. The executable test is the
credential-free capture/playback fixture; transport servers are loopback only.

Assertions observe `tool.before` through generated runtime tracing, the skill
marker in the actual model request, MCP transport connections, and the stdio
fixture's cwd, source root, data directory, and argv. The source has no package
manifest. Claude's synthetic test explicitly passes the generated `.mcp.json`
with `--mcp-config` and an isolated Claude configuration directory: this proves
translation and startup with explicit activation, not automatic project MCP
approval. Codex uses temporary test trust through the existing playback harness.
OpenCode uses the generated configuration module's native discovery.

The initial capture left Codex project MCP unsupported. The follow-up in
`../codex-project-mcp` now validates stdio and Streamable HTTP. Package MCP evidence alone does not
establish project TOML merge or discovery behavior. No TOML writer is advertised.
The observed versions above are newer than the adapters' original hook fixture
reference versions; this record does not claim those exact older binaries were
rerun. Hook protocol fixtures and existing package projection captures remain
separate evidence. POSIX discovery and nested harness-session cwd were not probed
here; project launch guidance remains explicit.

## Regression mutation evidence

`mutation-results.json` records isolated source mutants and the failed regression
names. Every new core reconciliation/recovery/integration and initialization test
was observed failing against at least one mutant, with production source restored
after each run. Mutants cover ownership, missing output, formatting, derived
timeouts, source-relative paths, runtime target identity, component omissions,
initialization overwrite, lock exclusivity, rollback, and recovery. The reusable
adapter contract also rejects a missing project support declaration. These are
focused falsification checks; they do not assert exhaustive mutation coverage.
