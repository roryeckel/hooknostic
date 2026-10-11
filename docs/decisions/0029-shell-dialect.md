# Decision 0029 — The shell view names its grammar family, where a harness lets it

**Status:** Accepted — 2026-10-10 · Referenced from code and docs as **ADR-0029**
**Builds on:** ADR-0007 (portable shell write-back) and ADR-0027 (what a shim
learns beside a callback reaches the decoder as enrichment, never `event.raw`).

**In short:** `event.tool.shell?.dialect` is `"posix"`, `"powershell"` or `"cmd"`
when the adapter can establish which grammar the command will be interpreted in,
and absent when it cannot. Absent means unknown, not POSIX. Claude Code and both
OpenCode generations establish it; Codex does not.

## Context

`tool.shell` gave a hook the command and its native keys, but not the grammar
the command runs in. A hook that tokenizes a command to find an invocation, or
that quotes a rewrite, needs it. The only signal was `tool.nativeName`, which is
harness vocabulary and does not determine the interpreter: on Windows, Claude's
`Bash` ran Git Bash, OpenCode's `bash` ran Windows PowerShell, and Codex's `Bash`
covered PowerShell and cmd under identical hook input.

Captures on Windows, macOS and Linux (`.capture/shell-dialects`) established
what each harness does and what it tells a hook:

- **Claude Code** has one tool per family. `Bash` ran bash or zsh on all three
  platforms. That held on Linux where `SHELL` named fish or tcsh or was unset,
  and where `CLAUDE_CODE_SHELL` named fish, tcsh or PowerShell; and on Windows
  with Git taken off `PATH`, with the install-location variables redirected as
  well, and with its Git Bash path variable naming a missing file, `cmd.exe` or
  `powershell.exe`. A Windows host with no Git for Windows produced no `Bash`
  call under any configuration tried: where Claude Code started, `PowerShell`
  was the only shell tool it advertised, and with that turned off it would not
  start. `PowerShell` ran Windows
  PowerShell or PowerShell 7 depending on what `PATH` resolved. The tool name
  is in the hook payload.
- **OpenCode** picks the interpreter from the host: its `shell` configuration
  key, then `SHELL`, then what `PATH` resolves. One tool name ran PowerShell,
  Git Bash, cmd and tcsh, and its tool hooks carried nothing about the choice.
  But both generations state the shell's name to the model in the tool's
  description, and a plugin receives that text before the call: on 1.x through
  the `tool.definition` hook, on 2.x through the `context` hook. The stated name
  was the interpreter that ran in every case that captured it, all on Windows
  and Linux; the macOS session predates the statement probes.
- **Codex** lets the model select the interpreter per call and does not pass
  the selector to the hook. Identical payloads ran PowerShell and cmd on
  Windows, and bash, zsh, dash and PowerShell on Linux.

The harnesses differ in how finely they can be read. Claude Code's payloads do
not distinguish bash from zsh, or Windows PowerShell from PowerShell 7: one tool
ran both under identical input. OpenCode's statement names the exact shell.

## Decision

1. **`ToolShell.dialect` is optional, and absence is the signal.** It is set only
   where the adapter established the grammar from evidence. A hook branches on
   it, never on `nativeName`, and decides for itself what a grammar-dependent
   guard or rewrite does when it is absent.
2. **A dialect is a family, not an interpreter.** `posix` covers bash and zsh;
   `powershell` covers both editions; `cmd` is cmd.exe. A finer value could be
   established on OpenCode alone, so a portable hook could not rely on it. The
   family is what every adapter that establishes anything can state. The exact
   name OpenCode states is not exposed; that would be a separate decision.
3. **Only values some adapter can emit.** Every member of `SHELL_DIALECTS` has
   a captured case behind it. A new family joins the union with its evidence,
   and an exhaustive `switch` then fails to compile, which is the notice a hook
   author needs.
4. **Two ways to establish one, and no third.**
   - *The tool pins it.* A `ShellShape` may declare a `dialect` when every call
     of the tool runs in one family whatever the host is configured with. The
     codec emits it. This is Claude's `Bash` and `PowerShell`.
   - *The harness states it.* The shim listens for the harness's own statement
     and hands the name to the decoder as enrichment. The decoder maps the name
     to a family and attaches it to the view of the tool the statement is about.
     This is OpenCode's `bash` and `shell`.
   An adapter never infers a dialect from the host platform, from an
   environment variable, or by re-deriving the harness's choice. The Linux tcsh
   capture is what a platform default would have got wrong.
5. **A stated name maps only if a capture saw it stated and run.** bash and zsh
   map to `posix`, powershell and pwsh to `powershell`, cmd to `cmd`. Any other
   name leaves the dialect absent, including tcsh, which was captured running.
   The mapping is knowledge about shells and is extended with evidence, never
   from a name's resemblance.
6. **A statement that cannot be read is no statement.** OpenCode's statements
   are prose for the model, not a contract. The patterns match the captured
   wording exactly, as a line or sentence of its own, and anything else yields
   no name; so does a description that names two different shells. Each new
   statement replaces the last, so a description that stops naming a shell
   clears it. The playback lanes assert, in a test of their own, that a shell
   call carries a dialect on the real binary, which is what notices a reworded
   build. They assert it only on a host whose shell the adapter maps: on any
   other, a call without a dialect is correct.
7. **A rewrite keeps the dialect.** `updateShell` and `replaceInput` re-derive
   the view from the new input (ADR-0007 decision 6). Where the codec states a
   dialect, that is the new one. Where it does not, the view gets the dialect
   the adapter established for the event: the one the view arrived with, or for
   a call that arrived with none, the one its shim hands dispatch
   (`shellDialect`). The arriving view comes first because a hook has already
   been shown it. The dialect describes the tool and its host, not the input,
   so it also reaches a view that only a rewrite creates. An input that no
   longer classifies drops the whole view.
8. **`updateShell` stays dialect-blind.** It lowers the command under the
   tool's native key and does not quote or translate. The hook writes a command
   in the dialect it read.
9. **`hooknostic dispatch` accepts a stated dialect.** A test event's tool may
   carry `shell: { "dialect": … }` and nothing else of the view. The target's
   classifier decides whether it applies, so the event is refused if the target
   would give that call a different dialect or none (ADR-0023: a test cannot
   hand a hook an event its harness never would). On a target that hears a
   statement, a call whose input has no view yet keeps the stated dialect for a
   rewrite to use, provided the tool is one the adapter has a shell shape for.
   A shell-kind tool without a shape can never be given a view, so a dialect
   stated for it is refused. Without it an OpenCode event carries no dialect,
   as when the harness has stated nothing.
10. **No capability and no field rating; the adapter declares its source.**
    Whether a dialect is present depends on the individual call and host, like
    the views themselves (ADR-0007 decision 4, ADR-0026 decision 7), so no
    matrix can rate it. Each adapter instead declares `shellDialect`: `tool`,
    `statement` or `none`, with a rationale and evidence. `hooknostic inspect`
    prints it, the generated support page lists it, and the contract suite
    holds the adapter's shape table and classifier to it, so "why is there no
    dialect here" has an answer a user can quote.

## What stays unknown

- **Claude Code's `Bash` on a Windows host without Git for Windows, on another
  build.** One build was captured on such a host, in Windows Sandbox, under
  eight host configurations. In the six that started it advertised no `Bash`,
  including those that pointed its Git Bash path variable at `cmd.exe` and
  `powershell.exe`; in the two that turned the PowerShell tool off it exited
  before any model request. So no `Bash` call reached a hook for the `posix`
  pin to be wrong about.
  Anthropic's setup page and tools reference, as read on 2026-10-10, describe
  the same thing: `Bash` needs Git Bash, and without it shell commands run
  through `PowerShell`. A build that did offer `Bash` there and ran it through
  another shell would make `posix` wrong on that host, not absent, and no
  scheduled lane runs on one to notice.
- **What OpenCode states on macOS.** No macOS session recorded the statement.
  A build that words it differently there reports no dialect, which is the
  safe direction, but nothing here predicts it.
- **Every Codex shell call.** No captured hook input names the interpreter. The
  session transcript held the pending call's selector, under the hook's
  `tool_use_id`, when PreToolUse ran in every direct-mode capture. It is not a
  route this adapter takes: Codex's hook documentation says the transcript
  format is not a stable interface, and a nested Code Mode call reaches the hook
  under Codex's own `exec-<uuid>` id rather than the model's call id
  (`.capture/codex-code-mode`), so the lookup that worked in direct mode has
  nothing to match there. Whether the transcript identifies such a call another
  way is unprobed. The upstream request is
  [openai/codex#44836](https://github.com/openai/codex/issues/44836).
- **An OpenCode shell this adapter has not seen stated and run**, and any call
  made before the harness has stated one.
- **The edition or exact shell within a family**, as far as the view goes: on
  Claude Code nothing establishes it, and on OpenCode the adapter hears it and
  reports only its family.
- **Whether two sessions of one OpenCode 1.x instance can run different
  shells.** The 1.x statement carries no session, so the shim keeps one per
  plugin instance. By source reading the tool resolves its shell once per
  project instance and a configuration change builds a new one; no capture
  exercises two sessions against one instance. If they could differ, a call
  would carry the dialect of whichever session stated last.
- **A shell another plugin changes after the statement.** By source reading,
  OpenCode 2.x has a shell-creation hook that runs after the tool hook and can
  replace the executable. That is uncaptured, and a change made there would not
  be visible here.
- **Tools whose shape is uncaptured** have no view, so no dialect.

## Consequences

- A grammar-dependent guard can be correct on three adapters and explicit about
  the fourth, instead of guessing from a tool name everywhere.
- The OpenCode shims register one more hook each when a plugin has tool hooks:
  `tool.definition` on 1.x and `context` on 2.x, read only. They keep the last
  stated name, per plugin instance on 1.x (the callback carries no session) and
  per session, bounded, on 2.x.
- The OpenCode dialect rests on wording. The statement was captured on the
  floor and the reference build of each recommended range and on the newest
  build probed; a build that words it differently reports no dialect until its
  statement is captured and the pattern extended.
- The contract suite compares a fixture's shell view to the codec's modulo a
  dialect the codec does not state, and hands a fixture's dialect to
  `classifyTool` as what the harness reported. A table that pins a dialect must
  therefore have a fixture recording it, and an adapter that takes one from the
  harness must reproduce it.
