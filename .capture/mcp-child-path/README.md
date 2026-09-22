# What environment an MCP stdio child is actually spawned with

Evidence class: **live-probe**. Tested Claude Code **2.1.273**, codex-cli
**0.154.0** and OpenCode **1.18.31** on **2026-09-16**, on native Windows. One
model call, on Codex only — the other two spawn a server from a command that
costs nothing.

## Question

`.capture/mcp-polyglot-runtime` left this open, and ADR-0017 rests on it. Of 24
stdio servers configured on one developer machine, all 17 third-party ones were
**runner commands** — `npx` ×9, `bun` ×4, `uvx` ×2, `docker`, `php` — rather
than an interpreter plus a bundled entry. A runner command is a bare executable
name, so it uses ambient platform lookup **on the consumer's machine, inside
whatever environment the harness hands the child**. This capture tests whether
the `PATH` portion of that lookup remains available; it does not establish lookup
precedence.

Nothing had ever measured that environment. `PATH` appears twice in all of
`.capture` and neither mention is about an MCP spawn. So: does a spawned MCP
child get the parent's `PATH`? And does the rest of the environment survive?

## Method

`probe/` is an Agent Plugin whose one stdio server is `node
${PLUGIN_ROOT}/record.mjs`. The recorder writes a JSON line —
`PATH`, its entry count, the total environment key count, `PATHEXT`,
`PLUGIN_ROOT`/`PLUGIN_DATA`, `cwd`, and whether `node`, `npx`, `uvx`, `uv`,
`docker`, `python3` and `python` have a candidate on `PATH` using `PATH` order
and `PATHEXT` — and then answers `initialize` so the harness completes its
handshake rather than reporting a failed connection. The record is written
first, so a failed handshake still leaves the measurement.

It deliberately depends on nothing being given to it: the output path defaults
to the system temp directory rather than a declared `env` value, because what
the harness puts in the environment is the thing under test.

Four spawns, all from the same Git Bash parent so the comparison is like for
like:

- **baseline** — the generated launcher run directly from the shell.
- **Claude** — `claude --plugin-dir <dist/claude> mcp list`, which health-checks
  approved servers and therefore connects. Installs nothing.
- **Codex** — installed from a local marketplace, then one `codex exec` with a
  content-free prompt. `codex mcp list` reads configuration and does **not**
  spawn, and there is no health-check subcommand, so a session is the only way.
- **OpenCode** — a project `opencode.json` naming the built directory, then
  `opencode mcp list`, which connects. No model call.

## Observations

| | PATH entries | env keys | PATH vs parent | `PLUGIN_ROOT` | cwd |
| --- | --- | --- | --- | --- | --- |
| baseline | 48 | 104 | — | bound | output dir |
| Claude | 48 | 105 | **identical** | bound | plugin dir |
| Codex | 50 | **22** | **superset** (+2) | bound | installed plugin root |
| OpenCode | 48 | 109 | **identical** | bound | nested `package/` |

**On native Windows in the captured Claude Code 2.1.273, Codex 0.154.0, and
OpenCode 1.18.31 probes, `PATH` survives to the child process.** This does not
establish the same behavior on POSIX or for other versions.
`uvx`, `uv`, `npx`, `docker` and `node` had a PATH probe candidate in every one
of these four Windows captures. Claude and OpenCode pass the parent's `PATH`
through byte for byte. Codex passes a **superset**: all 48 parent entries plus
two of its own — an `arg0` shim directory and its vendored `codex-path`.

**Codex filters the rest of the environment to 22 variables, against ~104
elsewhere.** This is the finding that matters. `.capture/codex-project-mcp`
established that Codex does not forward ambient environment on the *project*
route unless each name is listed in `env_vars`; the same filtering applies on the
**plugin/package route**, where there is no `env_vars` to list them in.

So a server that reads its configuration from the ambient environment works on
Claude and OpenCode and silently does not on Codex. The variables a non-Node
server is most likely to want are exactly the kind that vanish: `PYTHONPATH`,
`VIRTUAL_ENV`, `UV_CACHE_DIR`, `PIP_INDEX_URL`, `DOCKER_HOST`, `SSL_CERT_FILE`,
`GOPATH`, `CARGO_HOME`, `DOTNET_ROOT`.

**This is why ADR-0017 has a materialized runtime declare its own `env` in
`mcp.json`** — `"PYTHONPATH": "${PLUGIN_ROOT}/runtime/pypi"` — rather than
relying on the ambient value. The launcher expands placeholders in `env` values
itself, so a declared variable reaches the child on every harness. Measured
necessity, not tidiness.

**`PLUGIN_ROOT` is bound in all three**, by the generated launcher rather than
by the harness. OpenCode's is the nested `package/` directory, which is why a
materialized tree has to be placed inside it.

## Packaged ambient-variable follow-up (2026-09-21)

The first run established `PATH`, but `PATH` may be a special platform
allowlist entry. A second live probe asked the narrower question ADR-0018 turns
on: does an arbitrary, non-credential-shaped ambient variable reach a packaged
stdio server, and does Codex's generated `env_vars` declaration change that?

Run the repeatable driver from the repository root:

```powershell
pnpm run bundle
node .capture/mcp-child-path/probe.mjs --codex C:\path\to\codex-0.153.2.exe
```

The driver builds the same portable package twice. `undeclared` has no
`components.mcpEnvironment`; `declared` names only `SYNTHETIC_MARKER` for the
`recorder` server. It then loads the actual projected package into Claude Code
**2.1.278**, OpenCode **1.18.32**, codex-cli **0.154.0**, and the supplied
codex-cli **0.153.2** binary. Claude and OpenCode receive disposable isolated
configuration roots. Each Codex run gets an isolated `CODEX_HOME`, marketplace,
plugin install and trusted project, and reaches only a loopback model endpoint
that returns HTTP 503. Every harness command receives a small allowlist of
platform process variables plus the synthetic marker, so no user-defined
credential or service configuration is inherited.

The committed, value-free result is `environment-observations.json`:

| Harness | Undeclared marker | Declared marker |
| --- | --- | --- |
| Claude Code 2.1.278 | present | present |
| OpenCode 1.18.32 | present | present |
| codex-cli 0.154.0 | absent | present |
| codex-cli 0.153.2 | absent | present |

This establishes the distinction directly rather than inferring it from an
environment-key count. Claude and OpenCode pass an arbitrary ambient value to
the projected child without a target declaration, so they correctly ignore
`components.mcpEnvironment`. Codex filters it on both captured versions and the
projector's `env_vars` output is what admits it. The 0.153.2 run exercises the
installed-plugin path and the generated projection itself, closing the older
edge of `CODEX_PLUGIN_MODE_RANGE` rather than borrowing evidence from Codex's
separate project-MCP route.

## Not measured

- **Ambient lookup precedence or cwd shadowing.** The recorder searched only
  `PATH` plus `PATHEXT`; it did not test whether the launcher checks its working
  directory first. Hooknostic's Windows cwd-before-PATH behavior is established
  by its `cross-spawn` launcher implementation and unit tests, not this capture.
- **Which 22 variables Codex keeps.** The recorder captured the count, not the
  names. Knowing the survivors would let a server be told precisely what it may
  rely on; it needs one more Codex session.
- **A Windows shim launched through a harness.** `npx` had a candidate on all
  three PATHs, which is the half this probe covers. Whether `cross-spawn` then
  launches a `.cmd` correctly under a harness is still only unit-tested
  (`mcp-launcher.test.ts`), not observed end to end.
- **POSIX.** Windows only, and the `PATH`/`PATHEXT` split is the most
  platform-specific thing here.
- `python3`/`python` resolved in **none** of the four environments, including
  the baseline. That is a property of the Git Bash parent this probe ran from,
  not of any harness — recorded so the table is not misread.

## Cleanup

Claude installed nothing (`--plugin-dir`). OpenCode ran under an isolated
`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`. Codex has no equivalent that permits a real
session, so the plugin was installed into the real `~/.codex` and removed
afterwards: `config.toml` was sha256-verified byte-identical before and after,
and the `plugins/cache/path-probe` directory that `plugin remove` leaves behind
was deleted.

The 2026-09-21 driver uses only disposable configuration roots and removes its
scratch projects, isolated homes, marketplaces, plugin installs and recorder
output in `finally`. The generated `probe/dist/` trees are ignored build output.
