# A shell view names the grammar its command runs in

A shell tool's name does not say which interpreter runs its command. In the
[interpreter captures](../.capture/shell-dialects/README.md), Claude Code's `Bash`
ran Git Bash on Windows, OpenCode's `bash` ran PowerShell, Git Bash, cmd or tcsh
depending on how the host was configured, and Codex's `Bash` ran PowerShell or cmd
under identical hook input. 0.5.0 adds `tool.shell.dialect`, the grammar family a
command will be interpreted in, wherever the adapter can establish it
([ADR-0029](decisions/0029-shell-dialect.md)).

- `tool.shell.dialect` is `"posix"`, `"powershell"` or `"cmd"`. It is absent where
  the target cannot establish one, and absent means unknown, not POSIX.
- Claude Code sets it on every shell view, by tool: `Bash` is `posix` and
  `PowerShell` is `powershell`.
- OpenCode 1.x and 2.x set it from the shell the harness itself states before a
  call: `posix` for bash and zsh, `powershell` for either PowerShell, `cmd` for cmd.
  It is absent for any other shell, and until the harness has stated one
  ([OpenCode families](opencode-families.md)).
- Codex never sets it: the model picks the interpreter per call, and no hook input
  says which.
- `hooknostic inspect <target>` prints where a target's dialect comes from, with the
  adapter's reason and its evidence, and the generated support table says the same
  for every target.
- `hooknostic dispatch` takes the dialect a harness would have stated, so each
  branch of a hook can be tested: `"shell": { "dialect": "powershell" }` on an
  OpenCode test event's tool.

## Migrating

- A hook that does not read `dialect` builds and behaves as before.
- A hook that parses or quotes a command should branch on `dialect`, never on
  `tool.nativeName`, and decide what an absent one means: a guard that parses fails
  closed, and a rewrite that quotes fails open
  ([writing hooks safely](writing-hooks-safely.md#branch-on-the-shell-dialect-and-decide-what-unknown-means)).
- An OpenCode plugin with tool hooks (on 1.x, permission hooks too) also listens,
  read only, for the statement: on `tool.definition` in 1.x and `context` in 2.x.
- `hooknostic dispatch` refuses a stated dialect the target would not give that
  call. Claude's `Bash` is always `posix`, and Codex establishes none, so a Codex
  event exercises a hook's unknown branch.
- Adapter authors declare `shellDialect` (source, rationale, evidence) on an adapter
  with a shell shape table, and the contract suite holds its tables and classifier
  to the source it names. `classifyTool` takes what the harness reported as an
  optional third argument.

## Limits

- A family, not an interpreter: `posix` is bash or zsh and `powershell` is either
  edition, so a hook cannot assume a PowerShell 7 operator such as `&&`.
- The OpenCode dialect rests on the wording of the harness's statement. A build
  that words it differently reports no dialect until its statement is captured.
  The 1.x statement carries no session, so one is kept per plugin instance.
- macOS was captured on GitHub runners where `SHELL` named bash, and in no other
  configuration. What OpenCode states under zsh, a Mac's default, was captured on
  Linux only.
- Claude Code on a Windows host without Git for Windows was captured on one build,
  which advertised no `Bash` there. Another build that offered `Bash` on such a
  host and ran it through another shell would report `posix` wrongly.
- Codex needs the interpreter in its hook input before a dialect can be set:
  [openai/codex#44836](https://github.com/openai/codex/issues/44836).

Start with the [README](../README.md); [writing hooks safely](writing-hooks-safely.md)
covers branching on the dialect, and [testing your hooks](testing-your-hooks.md)
covers stating one in a test event.
