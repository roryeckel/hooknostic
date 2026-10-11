# Shell interpreter evidence

Investigation for [issue #30](https://github.com/roryeckel/hooknostic/issues/30).
This procedure records which process interprets a shell call, what reaches the
hook, and what else a hook or plugin can read about the interpreter. Sessions:
native Windows and GitHub macOS runners on 2026-10-04; native Windows, a
Debian 12 container and Windows Sandbox on 2026-10-10.
[ADR-0029](../../docs/decisions/0029-shell-dialect.md) is the decision this
evidence supports.

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
   with `pid`, `ppid`, `ucomm`, and `comm`; Linux reads `/proc/<pid>/stat` and
   the `/proc/<pid>/exe` link. The macOS accounting name is recorded separately
   from the command field; `comm` is not normalized to an executable path. See
   the [Apple ps manual source](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.1).
   Each query helper is a child of Node and is outside the recorded ancestry.
4. Cases of one tool execute identical command bytes within a comparison:
   `node interpreter.cjs` where a Windows comparison reaches cmd.exe, which does
   not separate commands with `;`, and
   `node interpreter.cjs; echo hooknostic-shell-finished` elsewhere. The trailing
   `echo` keeps the interpreting shell alive during the ancestry query.
5. Two comparisons vary one thing each. The **default** comparison varies the
   model's arguments: Codex's per-call `shell` selector. The **configured**
   comparison (`drive.mjs <harness> configured`) holds the arguments fixed and
   varies the host: an environment variable, `opencode.json`, or what `PATH`
   resolves. Each configured case pins `SHELL` and records what it set and what
   the session therefore saw (`SHELL`, whether `pwsh` resolved on `PATH`).
   A third mode, **builds**, runs the default cases into a directory per
   version, so builds other than a comparison's own are recorded beside each
   other. A fourth, **without-git**, is for a Windows host with no Git for
   Windows. Which shell tools exist is its question, so each of its host
   configurations has a discovery of its own, followed by a call to every
   shell tool that discovery advertised. A configuration Claude Code will not
   start under is recorded with what it printed.
6. Three probes record what the harness itself says about its shell:
   - OpenCode 2.x: the tee plugin already receives the `context` hook, whose
     `tools.shell.description` carries a sentence naming the shell, and the
     `shell.created` bus event, whose `data.info.shell` is a path.
   - OpenCode 1.x: `opencode-v1-report.js` tees `tool.definition`, `config` and
     `shell.env`, and writes one file in arrival order.
   - Codex: `codex-transcript-at-hook.mjs` is a second PreToolUse hook. It reads
     the file the payload's `transcript_path` names, as it stands when the hook
     runs, and records the pending call's arguments and any stated shell.
7. `promote.mjs` requires successful drives, a written process observation, and
   exactly one native before payload per case. A configured comparison must
   also show identical hook-visible input for every case of one tool. It
   redacts only the account path segment to `user`.

Each harness rerun clears its ignored output directory before discovery, so
retired cases cannot survive into a new capture. Every platform and comparison
has its own output directory; promotion requires metadata and process
observations to match the selected platform.

The hook envelopes are **captured**. Process ancestry is **live-probe** evidence.
Model responses and argument values, including the requested shell selectors,
are constructed. No claim is made about what an unscripted model tends to send.
What Codex's transcript file held is evidence about that file, one level below
the hook boundary; it is not a hook payload.

## Builds

| Session | Claude Code | Codex | OpenCode 1.x | OpenCode 2.x |
| --- | --- | --- | --- | --- |
| macOS, 2026-10-04 | 2.1.286 | 0.156.1 | 1.18.34 | 2.0.20 |
| Windows and Linux, 2026-10-10 | 2.1.295 | 0.156.1 | 1.18.34 | 2.0.20 |
| Windows, builds, 2026-10-10 | 2.1.238 | not run | 1.18.0, 1.18.18 | 2.0.17 |
| Windows Sandbox, no Git for Windows, 2026-10-10 | 2.1.295 | not run | not run | not run |

The builds row is each adapter's reference build, and for OpenCode 1.x also the
floor of its recommended range.

The Windows default comparison was first captured on 2026-10-04 with Claude Code
2.1.286 and recaptured on 2026-10-10; `observations.json` holds the later run.
The earlier one recorded Codex's default and its `powershell.exe` selector
running a bundled `pwsh.exe` where the later one recorded Windows
`powershell.exe`, on the same Codex build and host. The cause is not
established.

The Linux container was `node:22.13.1-bookworm` with an unprivileged account
whose login shell was bash: bash 5.2.15, zsh 5.9, fish 3.6.0, tcsh 6.24.07, and
for the Codex cases PowerShell 7.6.6 from Microsoft's Debian 12 package feed.

## Claude Code

| Platform | Tool | Host configuration | Interpreter |
| --- | --- | --- | --- |
| Windows | `Bash` | default | Git for Windows `bash.exe` |
| Windows | `Bash` | `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` | Git for Windows `bash.exe` |
| Windows | `Bash` | `CLAUDE_CODE_GIT_BASH_PATH` names a missing file | Git for Windows `bash.exe` |
| Windows | `Bash` | `CLAUDE_CODE_GIT_BASH_PATH` names `cmd.exe` | Git for Windows `bash.exe` |
| Windows | `Bash` | `CLAUDE_CODE_GIT_BASH_PATH` names `powershell.exe` | Git for Windows `bash.exe` |
| Windows | `Bash` | Git for Windows removed from `PATH` | Git for Windows `bash.exe` |
| Windows | `Bash` | the same, and `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432` and `LOCALAPPDATA` name an empty directory | Git for Windows `bash.exe` |
| Windows | `PowerShell` | `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` | Windows `powershell.exe` |
| Windows | `PowerShell` | the same, `pwsh.exe` first on `PATH` | `pwsh.exe` |
| macOS | `Bash` | default | `/bin/bash` |
| Linux | `Bash` | default (`SHELL` names bash) | `/usr/bin/bash` |
| Linux | `Bash` | `SHELL` unset | `/usr/bin/zsh` |
| Linux | `Bash` | `SHELL` names zsh | `/usr/bin/zsh` |
| Linux | `Bash` | `SHELL` names fish | `/usr/bin/zsh` |
| Linux | `Bash` | `SHELL` names tcsh | `/usr/bin/zsh` |
| Linux | `Bash` | `CLAUDE_CODE_SHELL` names zsh | `/usr/bin/zsh` |
| Linux | `Bash` | `CLAUDE_CODE_SHELL` names fish | `/usr/bin/bash` |
| Linux | `Bash` | `CLAUDE_CODE_SHELL` names tcsh | `/usr/bin/bash` |
| Linux | `Bash` | `CLAUDE_CODE_SHELL` names pwsh | `/usr/bin/bash` |
| Windows, no Git for Windows | `PowerShell` | default | Windows `powershell.exe` |
| Windows, no Git for Windows | `PowerShell` | `CLAUDE_CODE_GIT_BASH_PATH` names a missing file, `cmd.exe` or `powershell.exe` | Windows `powershell.exe` |
| Windows, no Git for Windows | `PowerShell` | `CLAUDE_CODE_SHELL` or `SHELL` names `powershell.exe` | Windows `powershell.exe` |
| Windows, no Git for Windows | none | `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`, alone or with `CLAUDE_CODE_GIT_BASH_PATH` naming `cmd.exe` | Claude Code did not start |

Where Git for Windows was installed, and on macOS and Linux, `PowerShell` was
advertised only with the opt-in variable set. Its two cases there have
identical hook input and ran two PowerShell editions. `Bash` ran bash or zsh in
all seventeen cases. Ten of
them pointed it elsewhere: at fish, tcsh or PowerShell through `SHELL` or
`CLAUDE_CODE_SHELL` on Linux, and on Windows at a missing file, `cmd.exe` or
`powershell.exe` through its Git Bash path variable, with Git taken off
`PATH`, or with the install-location variables redirected as well. The
reference build's Windows default case ran Git for Windows `bash.exe` as well.

A session that does not set one of Claude Code's own interpreter variables
(`CLAUDE_CODE_SHELL`, `CLAUDE_CODE_GIT_BASH_PATH`,
`CLAUDE_CODE_USE_POWERSHELL_TOOL`) runs with it unset, whatever the driving
process inherited. Claude Code's Windows host-configuration cases were
recaptured on 2026-10-10 after the driver began enforcing that. The other
comparisons predate it: the Windows host has none of the three set, the Linux
container was a stock image given only this capture's own variables, and the
macOS sessions ran on GitHub's runners.

The Windows `Bash` rows ran on a host with Git for Windows installed, where
Claude Code found `bash.exe` at its install location whatever the variables
said. The last of them is the nearest that host comes to lacking it, and it
changed nothing: the environment cannot stand in for an uninstalled Git.

The last four rows are a host that never had it: Windows Sandbox, a disposable
Windows (10.0.26100) with no Git for Windows and no `bash.exe` on `PATH`,
running the same Claude Code build. `Bash` was not advertised in any of its
eight configurations. In the six that started, `PowerShell` was the only shell
tool and was advertised without the opt-in. Each call reached the hook as
`PowerShell`, with the same input as the opted-in cases above, and ran Windows
`powershell.exe`. Pointing the Git Bash path variable at a missing file,
`cmd.exe` or `powershell.exe` did not bring `Bash` back, and neither did naming
`powershell.exe` through `CLAUDE_CODE_SHELL` or `SHELL`. With the PowerShell
tool turned off, alone or with the Git Bash path variable naming `cmd.exe`,
Claude Code exited before any request: it printed that it requires a shell
tool, that Git Bash was not found and that the PowerShell tool is disabled. So
this host sent a hook no `Bash` call for the `posix` pin to be wrong about.

Anthropic's setup page and tools reference, as read on 2026-10-10, say the
same: Git Bash is what the `Bash` tool needs, and without Git for Windows
Claude Code runs shell commands through the `PowerShell` tool
(<https://code.claude.com/docs/en/setup>,
<https://code.claude.com/docs/en/tools-reference>). They also say `PowerShell`
is on by default beside `Bash` for some account types; in the loopback
sessions on the host with Git it was advertised only with the opt-in set.

This is one build on one such host. A build that offered `Bash` there through
another shell would make `posix` wrong on that host, and nothing scheduled runs
on one to notice.

## Codex

Every case reached the hook as `tool_name: "Bash"`, `tool_input: { "command" }`,
byte-identical within a platform.

| Platform | Selector or host configuration | Interpreter |
| --- | --- | --- |
| Windows | default | Windows `powershell.exe` |
| Windows | `shell: "powershell.exe"` | Windows `powershell.exe` |
| Windows | `shell: "cmd.exe"` | Windows `cmd.exe` |
| macOS | default | `/bin/bash` |
| macOS | `shell: "/bin/bash"` | `/bin/bash` |
| macOS | `shell: "/bin/zsh"` | `/bin/zsh` |
| Linux | default | `/usr/bin/bash` |
| Linux | `shell: "/bin/bash"` | `/usr/bin/bash` |
| Linux | `shell: "/bin/zsh"` | `/usr/bin/zsh` |
| Linux | `shell: "/usr/bin/fish"` | `/usr/bin/dash` |
| Linux | `shell: "/usr/bin/tcsh"` | `/usr/bin/dash` |
| Linux | `shell: "/usr/bin/pwsh"` | `/opt/microsoft/powershell/7/pwsh` |
| Linux | default, `SHELL` unset or naming zsh, fish or tcsh | `/usr/bin/bash` |

The model can therefore select PowerShell on Linux and cmd on Windows without
the hook input changing. The fish and tcsh selectors ran dash instead, and the
default did not follow `SHELL`.

In all thirteen Windows and Linux cases the transcript file existed when
PreToolUse ran and already held the pending call as a `function_call` named
`exec_command` with the model's own arguments, selector included, under the
payload's `tool_use_id`. It also held the default the harness stated to the
model: `<shell>powershell</shell>` on Windows and `<shell>bash</shell>` on
Linux, and the same value on one line at
`payload.state.environments.environments.local.shell`. The macOS session
predates this probe.

## OpenCode

The hook input of the `bash` (1.x) and `shell` (2.x) calls was identical across
the cases of each platform. Both generations chose the same interpreter in
every configuration:

| Platform | Host configuration | Interpreter | 1.x `tool.definition` | 2.x `context` |
| --- | --- | --- | --- | --- |
| Windows | `SHELL` unset | Windows `powershell.exe` | `Shell: powershell` | `using powershell.` |
| Windows | `SHELL` names Git Bash | Git for Windows `bash.exe` | `Shell: bash` | `using bash.` |
| Windows | `opencode.json` `shell: "cmd"` | Windows `cmd.exe` | `Shell: cmd` | `using cmd.` |
| Windows | `pwsh.exe` first on `PATH` | `pwsh.exe` | `Shell: pwsh` | `using pwsh.` |
| macOS | default | `/bin/bash` | not probed | not probed |
| Linux | default (`SHELL` names bash) | `/usr/bin/bash` | `Shell: bash` | `using bash.` |
| Linux | `SHELL` unset | `/usr/bin/bash` | `Shell: bash` | `using bash.` |
| Linux | `SHELL` names zsh | `/usr/bin/zsh` | `Shell: zsh` | `using zsh.` |
| Linux | `SHELL` names fish | `/usr/bin/bash` | `Shell: bash` | `using bash.` |
| Linux | `SHELL` names tcsh | `/usr/bin/tcsh` | `Shell: tcsh` | `using tcsh.` |

The last two columns are what the harness stated before the call, in the cases
of 2026-10-10:

- **1.x**: the `tool.definition` hook for tool `bash` received a description
  containing `Be aware: OS: <platform>, Shell: <name>`. It arrived before
  `tool.execute.before` in every case. The `config` hook carried
  `shell: "cmd"` only in the configured case; `shell.env` named no shell.
- **2.x**: the `context` hook's `tools.shell.description` contained
  `Commands run on <platform> using <name>.`, before `execute.before` in every
  case. The `shell.created` bus event followed `execute.before`, preceded
  `execute.after`, and carried a path to the interpreter.

The stated name matched the interpreter that ran in all twenty cases of
2026-10-10, ten per generation: the nine Windows and Linux rows above, and
the Windows default comparison, which repeats the first row. It also matched on
the three other OpenCode builds, whose Windows default case stated and ran
PowerShell. The macOS session predates these probes.

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

Run the default comparison with `SHELL` unset on Windows: OpenCode reads it, and
a Git Bash terminal sets it.

Append `configured` for the host-configuration comparison. On Windows it covers
Claude Code and both OpenCode generations; set `HKN_GIT_BASH` to Git for
Windows' `bash.exe` and `HKN_PWSH_DIR` to a directory holding `pwsh.exe`, or
those cases are skipped. On Linux it covers all four harnesses and requires
`/usr/bin/zsh`, `/usr/bin/fish` and `/usr/bin/tcsh`; the Codex default
comparison also requests `/usr/bin/pwsh` where it exists. The 2026-10-10 Linux
session ran every harness as an unprivileged account.

On Windows, the only platform this mode is established on, append `builds`
instead to record another build's default cases under
`captured/builds/<harness>-<version>/`. Install a build into a scratch
directory with an explicit `npm install --prefix`, and put its shim first on
`PATH`.

For a Windows host with no Git for Windows, append `without-git`, Claude Code
only. The driver refuses to run where it finds an install, so this comparison
needs a host that never had one. `node .capture/shell-dialects/windows-sandbox.mjs`
provides it with Windows Sandbox (the `Containers-DisposableClientVM` optional
feature): it maps this checkout, the Node install and a copy of the native
`claude.exe` on `PATH` into the sandbox read-only, and one output folder
writable. Inside, a script copies the sources off the mount, installs and
bundles them as the Linux session did, runs the driver, and shuts the sandbox
down. The launcher then copies the raw output to `captured/without-git/` and
removes its temporary folders once the sandbox has released them. The
sandbox needs the network for the dependency install only; the model is the
same loopback. `--keep` leaves the sandbox open, and `--prepare-only` writes
its configuration without starting it. Promote that capture with
`HKN_CAPTURE_ACCOUNT=WDAGUtilityAccount`, the sandbox's account.

Promote with `node .capture/shell-dialects/promote.mjs <comparison>`, where the
comparison is `win32` (the default), `darwin`, `linux`, `configured`,
`configured-linux`, `builds` or `without-git`.

`node --experimental-strip-types .capture/shell-dialects/promote-fixtures.mjs`
then writes the fixtures that rest on these captures: for each OpenCode
generation, one case whose stated shell the adapter maps (cmd) and one it does
not (tcsh), each with the before-tool payload, the enrichment the shim hands the
decoder, and the canonical event; and the canonical events of the Claude
fixtures whose tool pins a dialect. Set `HKN_CAPTURE_ACCOUNT` when the Linux
cases were captured under another account.

The manual `Shell interpreter capture` workflow runs all four recorded comparison
builds on fresh macOS runners, using the version in each adapter's shell-probe
validation record. It uploads raw output for review; it does not commit or
promote results. No model credentials or repository write token are supplied.
Download its four artifacts into `captured/darwin/`. When promoting a capture
made under another account, set `HKN_CAPTURE_ACCOUNT` to that account's name
(`runner` for these GitHub runners), then run the promotion command.

Raw output is retained under the ignored `captured/` directory. Review newly
promoted observations before committing them. Only the account segment of a
path is redacted; process names and temporary path shapes remain as observed.

## Records

| File | Comparison |
| --- | --- |
| `observations.json` | Windows, default |
| `observations-macos.json` | macOS, default |
| `observations-linux.json` | Linux, default |
| `observations-configured.json` | Windows, host configuration |
| `observations-configured-linux.json` | Linux, host configuration |
| `observations-builds.json` | Windows, default cases on other builds |
| `observations-without-git.json` | Windows with no Git for Windows, Claude Code, host configuration |
| `*-tools.json`, `*-tools-macos.json`, `*-tools-linux.json` | advertised tools of each default comparison |
| `claude-tools-without-git.json` | advertised tools with no Git for Windows and nothing set |

A configured record embeds the shell tools its discovery advertised. The
without-git record has a discovery per configuration and lists each one's shell
tools, and keeps a call that ran nothing with what the harness reported. A case
carries `reported` where OpenCode stated its shell and `transcript` where the
Codex transcript probe ran.

## Consequences and limits

A tool name or host platform does not select a portable grammar. OpenCode ran
PowerShell, Git Bash, cmd and tcsh under one tool name, chosen by the host's
configuration. Codex ran PowerShell and cmd on Windows, and bash, zsh, dash and
PowerShell on Linux, chosen by the model per call. Only Claude Code's tool names
tracked a grammar family, and neither of its tools tracked one interpreter.
A grammar-dependent parser or rewrite needs an established interpreter; an
unknown interpreter must remain unknown.

What follows for adapters is ADR-0029's to say. In evidence terms: Claude Code's
tool name is in the hook payload; OpenCode's statement reaches a plugin before
the call but is not part of the tool hook's input; and Codex's hook input
carries nothing that separates its cases.

These observations apply to the recorded builds and isolated configurations only.
The macOS defaults describe GitHub runners and the Linux ones a container, not
every user's shell configuration. OpenCode's statements are prose the harness
writes for the model, so their wording is evidence about these builds and not a
contract. Codex's transcript is an internal file whose format no hook input
describes.
