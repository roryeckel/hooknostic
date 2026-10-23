# Pi feature parity probes

Live, credential-free probes of the reference build on Windows and Linux,
first on 0.84.4 (2026-10-14) and repeated on 1.3.0 (2026-10-19), in
America/Chicago dates; raw timestamps use UTC. Evidence is kept per build:
0.84.4 in [Windows](feature-evidence/0.84.4/win32.json) and
[Linux](feature-evidence/0.84.4/linux.json), 1.3.0 in
[Windows](feature-evidence/1.3.0/win32.json) and
[Linux](feature-evidence/1.3.0/linux.json). Each profile's validation records
in `packages/adapter-pi/src/profile.ts` cite their build. A scripted loopback provider
selects tools and supplies replies; the payloads, interpreter ancestry, skill
wrappers, and session entries are produced by real Pi.

## Results and implementation

| Feature from master | Established behavior | Adapter consequence |
| --- | --- | --- |
| Shell dialect (ADR-0029) | Windows `powershell` executes Windows PowerShell or pwsh. `bash` can execute different interpreter families through `shellPath`. | Pin only `powershell`; leave `bash` dialect absent. |
| File view (ADR-0026) | `read`, `write`, and `edit` carry a single `path` in both tool callbacks. | Add FileShapes and the file codec, including view rederivation after input replacement. |
| Declared event fields (ADR-0027) | At `agent_settled`, `ctx.sessionManager.getBranch()` includes the final assistant message and its native session-entry id. At `before_agent_start`, the current prompt has no message entry yet. | Supply `turn.stop.lastMessage` and `turn.stop.correlation.turnId` when declared. No prompt-side turn id. |
| Skill directory (ADR-0028) | Explicitly loaded skills carry a native instruction resolving relative references against their directory; placeholders remain literal. | Project `${SKILL_DIR}` to `.` in the body for project and package delivery; report unsupported references. |
| Implicit skill invocation (ADR-0030) | `disable-model-invocation: true` hides ordinary discovery; false restores it; explicit `/skill:feature-probe` still injects the gated body. | Project the canonical policy after authored native settings, for project and package skills and shared `.agents/skills` copies. |

Other merged changes, including ordered effects, per-hook typing, field
analysis, and portable dispatch, already use shared SDK/core/runtime behavior.
The adapter changes above connect Pi to the new contracts. Existing unsupported
capabilities (native MCP, permission asking, and subagent lifecycle) remain as
recorded in the original capture; these probes do not establish them.

## 1.3.0 recheck

Every probe below was repeated on 1.3.0 and compared with the 0.84.4
observations. Tool lists and argument keys, interpreter ancestry, file-tool
payload shapes, skill visibility, listings, and explicit bodies on all four
skill routes, settled-branch reads, and all nine completion edges matched.
The differences were additive: `tool_result` now carries `structuredContent`
(an object for shells, a string for `read`), and `agent_settled` carries
`aborted`, true only after in-flight cancellation. The Windows host had no
`pwsh` this time, so the `pwsh` variants did not run and `powershell` resolved
to Windows PowerShell; that is the host, not the harness. No adapter
consequence above changed.

## Interpreter evidence

Every shell run used the same harmless command:
`node interpreter.cjs; echo hooknostic-shell-finished`. The child probe recorded
its actual parent executable and command line, rather than trusting a tool name,
environment variable, or model reply.

| Host and selection | Actual interpreter |
| --- | --- |
| Windows, default `bash` | Git Bash |
| Windows, `bash` with `SHELL` pointing at Windows PowerShell | Git Bash |
| Windows, `bash` with `shellPath` pointing at Windows PowerShell / pwsh | Selected PowerShell executable |
| Windows, `powershell`, default and controlled PATH variants | Windows PowerShell / pwsh |
| Linux, default `bash` | Bash |
| Linux, `bash` with `shellPath` `/bin/sh`, zsh, fish, tcsh | dash, zsh, fish, tcsh respectively |

The `bash` call retains `{command}` with no interpreter selector. Its advertised
description and prompt snippet still describe Bash even when another shell runs.
These verbatim descriptions are preserved beside the process observations.
Consequently neither the tool name nor Pi's prompt wording establishes its
dialect. The decoder does not read settings or infer a dialect from command
syntax. No macOS claim is made.

The Linux container uses a disposable non-root account. Its copy of the
interpreter probe records three ancestors (probe, shell, Pi), avoiding the
unreadable root-owned `su` ancestor. The shared probe itself is unchanged.

## Files, skills, and session reads

File discovery advertised `read`, `write`, `edit`, `grep`, `find`, and `ls`.
Each was executed, and before/after payloads were recorded. Search/listing
`path` arguments scope a directory; they are not normalized as single-file
operations. Read/edit and a `bash` call configured to PowerShell are promoted
to fixtures beside the existing write and PowerShell cases.

Skill controls covered `.pi/skills`, project `.agents/skills`, ancestor
`.agents/skills`, and a package installed with `pi install -l --approve`.
Each route tested an absent gate, true, false, and explicit invocation with
true. The model request itself establishes discovery/body visibility. The
explicit body includes `References are relative to <directory>.` and leaves
all tested `${CLAUDE_*}`, `${SKILL_DIR}`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`, and
`${HOME}` references literal. The description's `${SKILL_DIR}` is also literal.
This is a discovery policy, not filesystem access control. No TUI-menu or
forced model file-read restriction is claimed.

The final response probe records native session reads beside the callback.
`agent-settled-with-message.input.json` retains the ordinary native envelope;
its `.enrichment.json` separately holds the branch. The adapter reads only
when a matching hook declares a final-response field, never inserts the branch
into `event.raw`, and uses the last message only if it is a successful assistant
completion. A failed read leaves both optional fields absent. Synthetic tests
cover malformed and user/tool leaves without promoting those mutations to
captured harness facts. Live completion-edge captures cover failures and cancellation.

## Completion edges

[The Windows RPC record](feature-evidence/0.84.4/completion-win32.json) ([1.3.0](feature-evidence/1.3.0/completion-win32.json)) reuses one
persisted session for nine runs: a baseline reply, HTTP 400 failure, recovery,
in-flight cancellation, recovery, HTTP 503 followed by Pi's successful native
retry, cancellation during retry backoff, recovery, and a successful reply after
reopening the same session file in a new Pi process. The loopback proxy's faults
are constructed inputs; callback events, session entries, and retry events are
real Pi outputs. No model credentials or external provider were used.

Each unsuccessful run appended an assistant message with `stopReason: error`
or `aborted`. Its predecessor remained in the branch, making stale-response
selection observable. Every successful completion had fresh native text and a
new session-entry id. Pi settled once after the successful retry, rather than
settling at the intermediate failed attempt. Cancelling retry left an error tip.
Reopening the session retained prior history and appended the resumed reply.

The curated record and five new `agent-settled-*` enrichment fixtures retain
the last three native message entries verbatim. These are captured branch
excerpts, not fabricated messages; full branches and model requests remain in
ignored raw captures. The generated extension is checked against all nine
native branch tips in ordinary Pi playback. Windows shell playback separately
checks actual PowerShell process ancestry and verifies that a `bash` call
configured to execute PowerShell still has no portable dialect. Linux checks
the configured `/bin/sh` route when that lane runs.

## Reproduce

From the repository root, after `pnpm run bundle`, run:

```powershell
$env:HKN_PI_BINARY = (Get-Command pi.cmd).Source
$env:HKN_PWSH_BINARY = (Get-Command pwsh.exe).Source
node --experimental-strip-types .capture/pi/probe-features.mjs all
node --experimental-strip-types .capture/pi/probe-completion.mjs
```

The optional mode is `shells`, `files`, `skills`, or `fields`; an optional
following label selects one session. Raw observations stay in ignored
`captured-features/<platform>/`. Sessions use a disposable home/agent directory,
a repository boundary, and credential stripping; scratch projects are removed
after recording. Pi's installed version is checked and recorded at runtime.

For Linux, mount the checkout read-only at `/source` and a dedicated evidence
directory at `/evidence` in a disposable `node:24.21.0-bookworm` Docker container
(1.3.0 needs Node 22.19 or later; the 0.84.4 run used `node:22.13.1-bookworm`),
then run `bash /source/.capture/pi/linux-features.sh`. It installs the Pi version
from harness metadata and the repository's pnpm version, plus alternate shells,
and writes only shell observations to the evidence mount.

Run `node --experimental-strip-types .capture/pi/promote-features.mjs` to curate
the observations and selected fixtures. The shared redactor removes account and
home variants and rejects surviving account strings. Then regenerate canonicals
with `node --experimental-strip-types .capture/pi/make-canonical.mjs`.

Regression coverage lives in Pi's `feature-support.test.ts`, core's
`skill-policy.test.ts`, and the Pi lane of `harness-playback.test.ts`. Playback
checks projected project skills and installed packages through both local-path
and loopback npm-coordinate installation, including hidden discovery and explicit
loading of the rewritten body. It also checks the declared final-response fields.
The completion driver uses RPC commands against a fault-injected local proxy;
raw results are written under ignored `captured-completion/`. Its `--project`
and `--output` options let playback exercise an existing disposable project
containing the generated extension. Normal capture requires the metadata's
reference build; scheduled playback accepts its explicit candidate version.
