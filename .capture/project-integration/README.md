# Repository-local playback evidence

Recorded 2026-09-11 on Windows, Node 24.20.0. Commands run the production adapter
integrators and reconciliation engine in a synthetic temporary project, then point
the real harness at a credential-free scripted loopback model. No paid requests,
user-wide installation, or persistent trust changes are part of this probe.

| Harness | Observed version | Passed local assertions |
| --- | --- | --- |
| Claude Code | 2.1.268 | Project settings hook dispatch; `.claude/skills` discovery; stdio, Streamable HTTP, and SSE MCP |
| Codex | 0.153.2 | Nested-session `.codex/hooks.json` dispatch; `.agents/skills` discovery; project-root stdio cwd, target argv, and startup timeout |
| OpenCode | 1.18.30 | Project discovery module dispatch; native skill references; stdio/HTTP/SSE MCP; project-wins collision and isolated missing-variable disablement |

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
approval. Codex uses temporary test trust through the existing playback harness
and starts below the repository root. OpenCode uses the generated configuration
module's native discovery. Its playback config contributes a same-named inherited
server and an unrelated entry; the project server starts while a separate remote
declaration with an unset variable is reported disabled.

The initial capture left Codex project MCP unsupported. The follow-up in
`../codex-project-mcp` now validates stdio and Streamable HTTP. Package MCP evidence alone does not
establish project TOML merge or discovery behavior. No TOML writer is advertised.
The observed versions above are newer than the adapters' original hook fixture
reference versions; this record does not claim those exact older binaries were
rerun. Hook protocol fixtures and existing package projection captures remain
separate evidence. POSIX discovery was not probed here.

## Regression mutation evidence

`mutation-results.json` records isolated source mutants and the failed regression
names. Every new core reconciliation/recovery/integration and initialization test
was observed failing against at least one mutant, with production source restored
after each run. Mutants cover ownership, missing output, formatting, derived
timeouts, source-relative paths, runtime target identity, component omissions,
initialization overwrite, lock exclusivity, rollback, recovery, nested hook
bootstrap, direct exclusions/cwd containment, per-target MCP cloning/override translation, and OpenCode
collision/missing-variable isolation. Follow-up mutants cover selected-target
validation, direct executable-file rejection, canonical symlink containment,
URL-safe OpenCode wrapper imports, and Claude remote-reference omission and
runtime expansion. Additional regressions cover named OpenCode target discovery,
whole-file ownership relinquishment (including the generated skill-directory
marker), and missing direct MCP source diagnostics. The reusable adapter contract
also rejects a missing project support declaration. These are focused falsification
checks; they do not assert exhaustive mutation coverage.
