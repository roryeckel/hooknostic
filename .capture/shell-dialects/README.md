# Shell interpreter evidence

Investigation for [issue #30](https://github.com/roryeckel/hooknostic/issues/30),
captured on native Windows and GitHub macOS runners on 2026-10-04. This procedure
records which process interprets a shell call and what reaches the hook. It does
not add a portable dialect field or choose its value set.

## Method

No model spend. The real harness binaries connect to the loopback playback
model from `packages/cli/test/harness-playback.ts`.

1. A discovery turn records the tools and argument keys advertised by each
   harness. The driver declines missing tools and command keys.
2. The model scripts one shell call in a fresh scratch project with the
   existing tee template attached. Claude and Codex have isolated configuration
   homes; OpenCode uses isolated configuration and state directories.
3. `interpreter.cjs` runs as the command's Node child and records its process
   ancestry. Windows uses `Get-CimInstance Win32_Process`; macOS uses `/bin/ps`
   with `pid`, `ppid`, `ucomm`, and `comm`. The macOS accounting name is recorded
   separately from the command field; `comm` is not normalized to an executable
   path. See the [Apple ps manual source](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.1).
   Each query helper is a child of Node and is outside the recorded ancestry.
4. Codex's cases execute identical command bytes within each platform:
   `node interpreter.cjs` on Windows, and
   `node interpreter.cjs; echo hooknostic-shell-finished` on macOS. The trailing
   `echo` keeps the macOS interpreting shell alive during the ancestry query.
   Shell selectors are scripted model arguments, not fabricated hook fields.
5. `promote.mjs` requires successful drives, a written process observation, and
   exactly one native before payload per case. It saves the native envelopes
   and process observations in separate Windows and macOS observation files,
   redacting only the account path segment to `user`. Tool discovery files
   contain advertised names and shell-tool argument keys.

Each harness rerun clears its ignored output directory before discovery, so
retired cases cannot survive into a new capture. Windows and macOS use separate
output directories; promotion requires metadata and process observations to match
the explicitly selected platform.

The hook envelopes are **captured**. Process ancestry is **live-probe** evidence.
Model responses and argument values, including the requested shell selectors,
are constructed. No claim is made about what an unscripted model tends to send.

## Windows observations

| Harness build | Tool at hook boundary | Requested interpreter | Direct parent of command's Node child |
| --- | --- | --- | --- |
| Claude Code 2.1.286 | `Bash` | default | Git for Windows `bash.exe` |
| Codex 0.156.1 | `Bash` | default | bundled `pwsh.exe` |
| Codex 0.156.1 | `Bash` | `powershell.exe` | bundled `pwsh.exe` |
| Codex 0.156.1 | `Bash` | `cmd.exe` | Windows `cmd.exe` |
| OpenCode 1.18.34 | `bash` | default | Windows `powershell.exe` |
| OpenCode 2.0.20 | `shell` | default | Windows `powershell.exe` |

All six executed cases exited 0 with no playback errors and wrote their process
observation. The three Codex hook inputs are identical:
`tool_name: "Bash"`, `tool_input: { "command": "node interpreter.cjs" }`.
The per-call shell selector is absent at that boundary. The process observation
separately proves that one case executed in cmd and the others in PowerShell.
The promoted record is `observations.json`.

## macOS observations

The [successful capture run](https://github.com/roryeckel/hooknostic/actions/runs/37181419929)
used the same builds as the Windows comparison. All four discovery sessions and
all six executed cases exited 0 without playback errors.

| Harness build | Tool at hook boundary | Requested interpreter | Direct parent's accounting name and command |
| --- | --- | --- | --- |
| Claude Code 2.1.286 | `Bash` | default | `bash`, `/bin/bash` |
| Codex 0.156.1 | `Bash` | default | `bash`, `/bin/bash` |
| Codex 0.156.1 | `Bash` | `/bin/bash` | `bash`, `/bin/bash` |
| Codex 0.156.1 | `Bash` | `/bin/zsh` | `zsh`, `/bin/zsh` |
| OpenCode 1.18.34 | `bash` | default | `bash`, `/bin/bash` |
| OpenCode 2.0.20 | `shell` | default | `bash`, `/bin/bash` |

The three Codex hook inputs again match exactly:
`tool_name: "Bash"`,
`tool_input: { "command": "node interpreter.cjs; echo hooknostic-shell-finished" }`.
The explicit bash and zsh selectors are absent from the hook input even though
the process observations distinguish their execution. The promoted record is
`observations-macos.json`; advertised tools are in `*-tools-macos.json`.

Claude's discovery did not advertise `PowerShell` in either model configuration.
The older captured payload remains in
`fixtures/claude/2.1/pre-tool-powershell.input.json`; these sessions do not replace
or strengthen that tool's interpreter evidence.

## Reproduce

Build the checkout first with `pnpm run bundle`. Then:

```text
node --experimental-strip-types .capture/shell-dialects/drive.mjs claude
node --experimental-strip-types .capture/shell-dialects/drive.mjs codex
```

For OpenCode v1, put the desired recorded v1 build's npm shim first on `PATH`
and set `HOOKNOSTIC_PLAYBACK_VERSION` to that build's version, then run:

```text
node --experimental-strip-types .capture/shell-dialects/drive.mjs opencode-v1
```

For v2, set `HKN_OPENCODE_BINARY` to its executable and run:

```text
node --experimental-strip-types .capture/shell-dialects/drive.mjs opencode-v2
```

On Windows, promote with `node .capture/shell-dialects/promote.mjs`. On macOS,
use `node .capture/shell-dialects/promote.mjs darwin`.

The manual `Shell interpreter capture` workflow runs all four recorded comparison
builds on fresh macOS runners, using the version in each adapter's shell-probe
validation record. It uploads raw output for review; it does not commit or
promote results. No model credentials or repository write token are supplied.
Download its four artifacts into `captured/darwin/`. When promoting a foreign
runner capture, set `HKN_CAPTURE_ACCOUNT` to the capturing account name (`runner`
for these GitHub runners), then run the macOS promotion command.

Raw output is retained under the ignored `captured/` directory. Review newly
promoted observations before committing them. macOS captures redact only the
account segment in `/Users/runner/` paths; process names and temporary path shapes
remain as observed.

## Consequences and limits

A tool name or host platform does not select a portable grammar: on Windows,
Claude's `Bash` ran Git Bash, OpenCode's `bash` ran Windows PowerShell, and Codex's
`Bash` covered both PowerShell and cmd. On macOS, Codex's `Bash` covered both bash
and zsh. A grammar-dependent parser or rewrite needs an established interpreter;
an unknown interpreter must remain unknown.

These observations apply to the recorded builds and isolated configurations only.
The macOS defaults describe GitHub runners, not every user's shell configuration.
Existing Linux evidence remains in
`.capture/codex-hook-matcher/observations-linux.json`; it is not a new Linux
capture. How to represent PowerShell editions or POSIX-family grammars, whether
an adapter may use host platform information, and whether rewrites consult a
future dialect field remain design questions in #30. No SDK, schema, classifier,
or rewrite behavior changes in this investigation.
