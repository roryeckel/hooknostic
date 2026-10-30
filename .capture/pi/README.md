# pi tee-capture project

Committed capture project for the pi coding agent (pi.dev,
`@earendil-works/pi-coding-agent`). pi is an **in-process TypeScript extension
harness** like OpenCode: extensions are modules pi imports; handlers receive
**live objects**, not JSON on stdin. The tee serializes a per-value-degraded
clone (never mutating what it was handed) and, in probe modes, deliberately
mutates or returns results to verify effect channels by effect.

## Layout

The [feature parity probes](FEATURES.md) add model-free Windows/Linux interpreter,
file-view, skill-text, invocation-policy, and final-response evidence for the
contracts introduced on master after the original Pi adapter.

- `hooknostic-capture.ts` — the capture + probe extension. Subscribes to
  every event the adapter observes and tees each invocation's payload to
  `captured-<probe>/<event>.jsonl`. `HKN_PI_PROBE` selects a mutation
  experiment; `HKN_CAPTURE_DIR` redirects output.
- `run-capture.mjs` — drives one probe session (`node --experimental-strip-types .capture/pi/run-capture.mjs
  [probe]`), writing to `captured-<probe>/` (gitignored). It uses the
  `ollama-localhost/deepseek-v4.1-flash:cloud` entry in Pi's user-wide
  `~/.pi/agent/models.json`. Compaction probes copy that entry into an
  ignored scratch settings directory with a 2048-token context window.
- `make-fixtures.mjs` — extracts, redacts, and curates
  `fixtures/pi/0.84/*.input.json` from the original 0.84.4 raw captures.
- `probe-sessions.mjs` — model-free loopback sessions (lifecycle, bash,
  PowerShell, an exit-7 error, a populated prompt, RPC compaction, cancelled
  compaction, and a stop-prevention continuation), writing to ignored
  `captured-sessions/<platform>/`. `promote-sessions.mjs` curates them into
  the reference fixture directory. See [pi 1.3.0 recapture](#pi-130-recapture-windows-and-linux-2026-10-19).
- `probe-session-start-notice.mjs` — model-free probe that tests whether
  `ctx.ui` notices from `session_start` reach the user and the model, across
  print, RPC, and TUI. It writes to ignored `captured-session-start/`. See
  [session-start notices](#session-start-notices-130-and-140-windows-2026-10-30).
- `scratch/` — probe workspace (probe pi-package, scratch agent dirs);
  gitignored.

## Model routing provenance note

Capture sessions ran against `deepseek-v4.1-flash:cloud` via the local
ollama daemon (remote-backed cloud model). The model identity is
execution-environment provenance only and does not upgrade any captured
payload claim.

To reproduce these sessions, configure Pi's user-wide
`~/.pi/agent/models.json` with an `ollama-localhost` provider using
`http://127.0.0.1:11434/v1`, `openai-completions`, and a model entry with
`"id": "deepseek-v4.1-flash:cloud"`. Pi's installed `docs/models.md`
describes the full format. The local Ollama daemon must have that model
available. The capture driver checks for the entry before starting Pi.

## Security findings (capture sessions)

- **The bash/powershell tools inherit the full user environment.** A session
  that dumped the environment produced tool output containing a live API
  token (`AI_PAT=…`). That output enters session files and is sent to the
  model provider. Fixture curation scrubs environment dumps wholesale
  (`make-fixtures.mjs`); token rotation was requested, not confirmed. Capture
  prompts must never ask the agent to print the environment.
- The account name appears in payloads in many casing/path forms
  (`C:\Users\…`, `/c/Users/…`, `HOMEPATH`, `USERNAME`, POSIX bash cwd
  forms). `make-fixtures.mjs` redacts all observed variants to `user`.

## Playback-era findings (0.84.4, loopback lane, 2026-09-27)

- **Project trust gates project-local extensions**: a fresh scratch project
  loads `.pi/extensions/` only with `--approve` (same gate the package probe
  hit). The playback drive carries its own trust.
- **The `context` event's message array is `AgentMessage[]`** (user/assistant/
  toolResult/custom/thinking — no system role): a system-role entry appended
  to the returned `{messages}` is silently dropped by pi's AgentMessage→Message
  conversion before the provider request. The working per-request context
  channel is a `custom` message, which the provider receives as a user-role
  message. Playback now checks the marker in every model request at that role.
- The scheduled compaction scenario is recorded inconclusive for pi like the
  other three harnesses (loopback cannot fill a context window
  deterministically); the compaction cells are live-verified by the
  compact-cancel/compact-run probes above.
- The projected Agent Plugin package was driven through both
  `pi install -l --approve <path>` and `pi install -l --approve npm:<name>@<version>`
  in isolated projects and agent homes. The npm route used `pnpm pack` and a
  local read-only registry, with metadata and tarball requests observed. Both
  routes loaded the skill into model input and honored the compiled hook's
  shell rewrite. Removing `pi.extensions` made the local-path test execute
  the original command. No public registry publication was attempted.
- Project `sync` and `verify` were run in a fresh project. The generated
  extension and skill were observed on disk; a real Pi loopback session saw
  the skill description in model input and executed the hook's shell rewrite.
- The Windows `powershell` tool was forced through `--tools powershell` with
  loopback playback. Its live `tool_call` had input `{command}` and the
  successful `tool_result` had the same input. Both payloads are curated in
  `fixtures/pi/0.84/tool-*-powershell.*.json`.
- The original `run-capture.mjs` launched Pi through a shell with an unquoted
  argument array. Multiword prompts became separate submissions; for example,
  `before-agent-start.input.json` records only `"Create"` as its prompt.
  Those payloads remain real captures, but the split invalidates conclusions
  drawn from their prompt cadence. The driver now preserves the prompt as one
  argument. A fresh isolated 0.84.4 loopback run observed one `input` event
  containing the complete prompt, one `before_agent_start`, and one
  `agent_start`; the tool exchange made two local model requests.
- With the same single-prompt loopback setup, both `input-handled` and
  `input-handled-first` returned `{action: "handled"}` on the sole `input`
  event. Each run exited 0 with no `before_agent_start`, no `agent_start`,
  and no model request. This verifies print-mode suppression. Interactive
  modes and a portable `prompt.before.block` mapping remain unverified.

For that recheck, each probe used a fresh temporary project and
`PI_CODING_AGENT_DIR`. The existing `startModelPlayback("openai-chat",
"rewrite")` server supplied the model, `writePiProviderExtension` registered
it through `-e`, and `hooknostic-capture.ts` ran through a second `-e` with
`HKN_PI_PROBE` set to the probe name. Pi received `--approve --no-session -p`
with the complete prompt as one argument. The tee records and loopback request
count established the observations above; no model provider was contacted.

## pi 1.3.0 recapture (Windows and Linux, 2026-10-19)

The scheduled harness-watch run found 1.3.0 outside `>=0.84 <1`. Model-free
playback had already passed against it, and its drift capture-compare showed
only added fields. The owner chose a separate `>=1 <2` profile, so 1.3.0 is
now the reference build and `fixtures/pi/1.3` the reference fixtures. The
`>=0.84 <1` profile and `fixtures/pi/0.84` stay as that line's evidence.

Every session used the scripted loopback model, a disposable home, agent
directory, and project, and a repository boundary. No model provider was
contacted. pi 1.3.0 was installed with `--ignore-scripts` into a scratch
prefix and selected with `HKN_PI_BINARY`; the global 0.84.4 install was left
alone and served as the comparison build.

| Question | Observation on 1.3.0 | Consequence |
|---|---|---|
| Payload shapes (`probe-sessions.mjs`, feature and completion probes) | Every adapter-mapped event matched 0.84.4 apart from added fields: `messageType` and `systemPromptOptions` keys on `before_agent_start`, `structuredContent` on `tool_result`, `aborted` on `agent_settled`, and `systemMessage` in `session_compact`'s entry. A failed bash result carries no `details`. Tool input shapes are unchanged | No decode change for these; `fixtures/pi/1.3` records them |
| A run started by a custom message | The tee's `prevent-stop` probe posted `sendMessage({triggerTurn: true})` from `agent_settled`. 1.3.0 fired a second `before_agent_start` with `messageType: "custom"`, the message, and no `prompt`; 0.84.4 fired one `before_agent_start` for the same session. The 1.2.0 changelog describes the union | `prompt.before` declines the custom run explicitly (`before-agent-start-custom`). It was already declined by the missing-prompt check, silently, through the shim's fail-open path |
| Print-mode continuation | 1.3.0 completed the continuation in print mode (two model requests, the second reply printed); 0.84.4 printed the first reply and exited after one request | Stop prevention also works in print mode now; the rating stays emulated |
| Compaction | `ctx.compact()` at `agent_end` in print mode cancelled (too small) or ended before the summary, so `compact-run` uses an RPC `compact` command with `compaction.keepRecentTokens: 1`. `{cancel: true}` produced `session_compact_failed` with `aborted: true`, no `session_compact`, and no summarization request | Compaction cancel verified by effect; reason is `"manual"` in these captures |
| Stale ctx | After the compaction session reload, the tee's captured ctx logged the same "ctx is stale" extension error | The shim must still not cache ctx |
| Interpreters, file tools, skills, final message | The [feature probes](FEATURES.md) matched 0.84.4 on Windows and Linux, apart from `structuredContent` | Unchanged ratings |
| Effects | `HOOKNOSTIC_PLAYBACK=pi` passed against 1.3.0 on Windows and in the scheduled Linux run: block, rewrite, output replacement, prompt and per-request context, stop prevention, completion fields, and project/package skills with their hook | Every rated cell has 1.3.0 evidence |
| Type surface and changelog (schema-derived) | No mapped event renamed or removed; no permission event; native MCP since 0.99.0 (`.pi/mcp.json`, `mcp__<server>__<tool>` tools); `codemode` and `tool_search` built-ins, off by default, whose nested calls reach `tool_call` with `parentToolCallId`; `context` handlers no longer see system messages (0.87.0) | MCP is projected through `pi.registerMcpServer` and its tools classify as `mcp`; nested codemode calls are captured ([pi native MCP](../pi-mcp/README.md)) |

Reproduce from the repository root after `pnpm run bundle`, with
`HKN_PI_BINARY` naming the build under test:

```sh
node --experimental-strip-types .capture/pi/probe-sessions.mjs
node --experimental-strip-types .capture/pi/probe-features.mjs all
node --experimental-strip-types .capture/pi/probe-completion.mjs
node --experimental-strip-types .capture/pi/promote-sessions.mjs
node --experimental-strip-types .capture/pi/promote-features.mjs
node --experimental-strip-types .capture/pi/make-canonical.mjs
```

The probes check the build against `referenceVersion`;
`HKN_PI_EXPECTED_VERSION` overrides that for a candidate probed before the
metadata moves. Promotion accepts only the reference build.

## Session-start notices (1.3.0 and 1.4.0, Windows, 2026-10-30)

Question: can an extension show the user a notice at session start that the
model never sees? `probe-session-start-notice.mjs` loads an extension whose
`session_start` handler calls every fire-and-forget `ctx.ui` notice method:
`notify` at `info` and `warning`, `setStatus`, `setWidget`, and `setTitle`.
For comparison, the same handler sends `pi.sendMessage({customType, content,
display: true})`. Each string carries a per-run nonce, a per-start sequence
number, the reason, and the method, so a match names the exact start and the
method that produced it. A prompt follows every start, so the loopback model
receives a request that could carry the notice. Each surface runs in a
disposable home, agent directory, and project, with `PI_OFFLINE` and
`PI_SKIP_VERSION_CHECK` set, so the only traffic is the loopback model. Both
builds were installed with `--ignore-scripts` into scratch prefixes.

Surfaces and starts:

- **print**: `-p`, then `--continue -p`, then `--fork <first session> -p`.
  Stdout and stderr were searched.
- **rpc**: `--mode rpc` startup, then `new_session`, `switch_session` back to
  the first session, `fork`, and `clone`. A second process ran with
  `--continue`. Stdout rows were searched.
- **tui**: the interactive TUI ran under node-pty and was rendered by
  `@xterm/headless`. It went through startup, `/new`, `/reload`, `/resume`
  (first entry), and `/fork` (first entry), then a second process with
  `--continue`. Everything painted was searched: the raw stream with escapes
  stripped, plus OSC title sequences for `setTitle`.

1.3.0 and 1.4.0 gave identical results:

| Surface | Reason (how started) | `ctx.ui` notice shown | Notice reached model | `sendMessage` shown | `sendMessage` reached model |
|---|---|---|---|---|---|
| print | `startup` (plain, `--continue`, `--fork`) | none (`hasUI: false`) | no | no (only the reply prints) | yes |
| rpc | `startup` (plain, `--continue`) | notify info + warning, setStatus, setWidget, setTitle as `extension_ui_request` | no | no stdout row | yes |
| rpc | `new` (`new_session`) | all five, as above | no | `message_start`/`message_end` | yes |
| rpc | `resume` (`switch_session`) | all five | no | yes | yes |
| rpc | `fork` (`fork`, `clone`) | all five | no | yes | yes |
| tui | `startup` (fresh) | notify info + warning, status line, widget, title | no | yes | yes |
| tui | `startup` (`--continue`) | status line, widget, title; **no notify** | no | yes | yes |
| tui | `new` (`/new`) | all five | no | yes | yes |
| tui | `reload` (`/reload`) | warning notify, status, widget, title; **info notify never painted** | no | yes | yes |
| tui | `resume` (`/resume`) | as reload | no | yes | yes |
| tui | `fork` (`/fork`) | as reload | no | yes | yes |

No model request on any surface carried a notice nonce. Every displayed
`sendMessage` nonce reached the next request and stayed in later context.

Observed behaviour behind the table. Where source is cited, it is the
installed `dist/`, which is schema-derived:

- **The start reasons are `startup`, `new`, `resume`, `fork`, and `reload`.**
  A launch that resumes or forks an existing session (`--continue`, `--fork`)
  reports `startup` with no `previousSessionFile`, even though the earlier
  context reached the model. The other reasons occur only when a running
  process replaces its session. `reload` is TUI-only: RPC has no reload
  command.
- **RPC fires `session_start` twice per session replacement.** `new_session`,
  `switch_session`, `fork`, and `clone` each logged two `session_start`
  events with the same reason. Each event produced its own UI requests and its
  own `sendMessage` entry, and both entries reached the model. Only the second
  entry produced `message_start`/`message_end` rows on stdout. Startup fired
  once. In `rpc-mode.js`, the runtime host's rebind callback and the
  command's explicit `rebindSession()` both rebind extensions. The TUI fired
  once per replacement.
- **RPC startup**: a `sendMessage` made at startup produced no stdout row. It
  was still persisted and sent to the model. The UI requests for that start
  did arrive.
- **The TUI drops some notify calls before they paint.** An `info` notify
  renders through the chat's collapsing status line. After `/reload`,
  `/resume`, and `/fork`, Pi writes its own status message ("Reloaded …",
  "Resumed session", "Forked to new session") into that line before the next
  render, so the notice never reaches the terminal. On a `--continue` launch,
  `renderInitialMessages()` runs after extensions bind, and both notify rows
  were gone before the first paint. `setStatus` (footer), `setWidget` (above
  the editor), and `setTitle` (OSC 0) survived every start. A `warning`
  notify survived everything except `--continue`.
- `/fork` puts the forked message back in the editor, so the TUI's next
  probe prompt was appended to it. This does not affect any nonce.

Consequence: Pi can show the user a model-invisible notice at session start
in the TUI and in RPC, and has no channel for one in print mode. `setStatus`
and `setWidget` were the only methods that rendered for every reason in the
TUI. `notify` was dropped for some reasons. `pi.sendMessage` does not meet
the requirement, because the model reads it (`packages/adapter-pi/src/apply.ts`
already treats it as model-visible). This section records evidence only. No
vocabulary, capability cell, or adapter behaviour follows from it.

Reproduce from the repository root after `pnpm run bundle`:

```sh
node --experimental-strip-types .capture/pi/probe-session-start-notice.mjs <pi-1.3.0-binary> <pi-1.4.0-binary>
```

Each build's ignored `captured-session-start/<version>/` holds
`summary.json` (per-start verdicts, every start event, RPC UI requests, and
nonces per model request) and the TUI screens.

## Captured facts (pi 0.84.4, Windows, 2026-09-27)

All "verified by effect" claims below were observed as changes in model
behavior or session artifacts, never by absence of harness errors.

| Channel | Claim | Evidence class |
|---|---|---|
| Extension loading | discovery loads `*.ts`/`*.js` only from project `.pi/extensions/` and global `<agentDir>/extensions/`, one level deep (no `.mjs`) | schema-derived (loader.js source) + captured (extension loaded via `-e`) |
| `session_start` | payload `{type, reason: "startup"\|"reload"\|"new"\|"resume"\|"fork", previousSessionFile?}` | captured |
| `input` | The corrected single-prompt print-mode run delivered one event with the complete prompt. `{action: "handled"}` on that event suppressed the turn before `before_agent_start` and model traffic. The earlier per-token observation came from shell-split CLI arguments. This is a pre-turn input channel; a portable `prompt.before.block` mapping has not been validated across modes | captured + verified by effect |
| `before_agent_start` | payload `{prompt, systemPrompt, systemPromptOptions, images?}`; result `{message?, systemPrompt?}` — injected system prompt was quoted verbatim by the model; injected message rode along | captured + verified by effect |
| `context` | payload `{messages}` (deep copy); result `{messages}` **replaces** — injected marker message quoted verbatim by the model | captured + verified by effect |
| `tool_call` | payload `{type, toolCallId, toolName, input}`; result `{block?, reason?, terminate?}`. Block verified: model reported the block reason, tool never ran. `terminate` (batch early-stop hint) not yet probed | captured + verified by effect |
| `tool_call` input rewrite | **in-place mutation** of `event.input` (doc-comment confirmed: "Mutate it in place… No re-validation is performed after mutation"); the mutated command executed instead of the requested one. Reassignment not tested — treat mutation as the only sanctioned channel | captured + verified by effect |
| `tool_result` | payload `{type, toolCallId, toolName, input, content, isError, usage?, details}`; result `{content?, details?, isError?, usage?}` replaces. Verified: model saw the replaced content while the real command output was observable only via side channel | captured + verified by effect |
| `tool_execution_start/update/end` | observability-only events (`tool_execution_start` carries `args`; `tool_execution_end` carries `result` and `isError`); no result-type channels | captured |
| `turn_start`/`turn_end` | `{turnIndex, timestamp}` / `{turnIndex, message, toolResults}` | captured |
| `agent_start`/`agent_end`/`agent_settled` | `{type}` / `{messages}` / `{type}` | captured |
| `session_before_compact` | rich payload `{preparation, branchEntries, customInstructions?, reason, willRetry, signal}`; result `{cancel: true}` verified to suppress compaction (following event was `session_compact_failed` with `aborted: true`) | captured + verified by effect |
| `session_compact_failed` | `{reason, errorMessage?, aborted, willRetry, fromExtension}` | captured |
| `session_shutdown` | `{reason: "quit"\|"reload"\|"new"\|"resume"\|"fork", targetSessionFile?}` | captured |
| preventStop channel | `pi.sendMessage({...}, {triggerTurn: true})` from `agent_settled` starts another agent turn (2× `agent_start`) — the turn.stop posting equivalent | verified by effect |
| notify channel | `ctx.ui.notify` is TUI/RPC-only; in print mode (`hasUI: false`) it is a safe no-op (verified: session ran clean, no artifact) | captured + verified by effect |
| Tool shapes | `bash`/`powershell` `{command, timeout?}` (no cwd key); `read` `{path, offset?, limit?}`; `write` `{path, content}`; `edit` `{path, edits: [{oldText, newText}]}`; `grep` `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit?}`; `find` `{pattern, path?, limit?}`; `ls` `{path?, limit?}` | schema-derived (tools type defs) + captured (bash, powershell, write) |
| Stale ctx | after compaction reload/session replacement, captured `ctx` is **stale** — using it logs "Extension error … ctx is stale". The shim must never cache ctx across such boundaries | captured (twice) |
| Permission channel | **none exists** in the extension event surface (0.84.4 types enumerate all events; no permission event) | schema-derived |
| Native MCP | **none** in the harness; MCP arrives via third-party extensions (the capture environment had `npm:pi-mcp-adapter` and `npm:pi-subagents` globally installed, which added `mcp`/`mcpScript`/`subagent` tools to the system prompt — environment contamination noted, not a harness fact) | schema-derived + captured (system prompt) |
| pi packages | `package.json` `"pi"` manifest declares `extensions`, `skills`, `prompts`, `themes` (globs supported); `pi install -l <path>` writes a path reference to project `.pi/settings.json` (requires `--approve` on untrusted projects); installed package's extension **and** skill both load (verified: marker file written; skill answered "package-skill-loaded-ok") | captured + verified by effect |
| Skills | native Agent Skills standard: `SKILL.md` + frontmatter `name`/`description`, XML prompt injection, name falls back to directory name | schema-derived (skills.js source) + captured (behavior) |

## Fixture curation

`fixtures/pi/1.3/` holds the reference build's curated cases, and
`fixtures/pi/0.84/` those of the `>=0.84 <1` line (input = shim invocation
shape `{event, ctx: {cwd, mode}}`), redacted per the harness-capture skill.
Each directory's README holds its provenance table.

## Reproduce

### Free drift capture

After bundling the repository, run:

```sh
node scripts/drive-capture-session.mjs pi --transport playback
node scripts/drive-capture-session.mjs pi --transport playback --pi-tool powershell --scratch .capture/pi/scratch/powershell-playback
```

This starts a loopback model server, loads the tee in passive mode, and drives
one bash exchange in a fresh temporary project with an isolated Pi agent home.
The generated command writes `hooknostic-original` to `hooknostic-tool.txt`;
this driver captures native events and does not load the hook-rewriting plugin.
Raw JSONL stays in `<scratch>/captured`, and unwrapped `{event, ctx}` records
are compared with the committed fixtures. `--scratch <directory>` selects a
scratch workspace; each run replaces that workspace's capture output.

The 2026-09-27 reference run established the isolated
`before-agent-start-isolated` fixture. The original prompt fixture includes
user-installed MCP/subagent tool snippets and repository skills/context files;
the isolated fixture has neither. Both shapes remain evidence, rather than
ignoring those fields in the comparator. Unmapped tee events are diagnostic
only, and compaction/write/error variants not driven by this scenario are
reported as not exercised. `--pi-tool powershell` forces the alternate tool;
the generic bash comparator then reports expected differences while the raw
payloads remain available for curation. The `--transport llm` driver uses a
local credential-isolating OpenAI-compatible proxy. A loopback proxy test
verified the wiring and a failed-proxy test verified exit 5; a paid run
through this route has not been performed. The direct live-provider check
below is separate from that automation route.

### Halogen Qwen live-provider check (2026-09-27)

Pi 0.84.4 on Windows was driven directly with
`halogen-qwen3.8-flash-next` through Halogen's OpenAI-compatible chat-completions
endpoint, using the owner's configured provider credential. This replaces the
requested Ollama Cloud run, which was not attempted after the owner reported
its usage limit. Model/provider identity is execution provenance only.

Method: use a fresh temporary project and isolated `PI_CODING_AGENT_DIR`, load
`hooknostic-capture.ts` with `HKN_PI_PROBE=tee`, and select the configured model
with `--thinking low --approve --no-session -p`. A loopback proxy held the
upstream credential; Pi received a dummy local key and a minimal environment.
The Pi model used `openai-completions`, a 262144-token context window, a
4096-token output cap, `supportsDeveloperRole: false`,
`supportsReasoningEffort: true`, and `supportsStore: false`. The prompt was:

> Use bash exactly once to run: echo hooknostic-paid-drift. Then reply DONE.
> Do not inspect files or run other commands.

Observed results:

- Two streamed model requests returned HTTP 200 with `reasoning_effort: low`.
- Exactly one `bash` call executed `echo hooknostic-paid-drift`; its
  `tool_result` had `isError: false` and text `hooknostic-paid-drift\n`.
- Pi exited 0, printed `DONE`, and emitted no stderr.
- Unwrapped native captures compared **clean** against `fixtures/pi/0.84`,
  including all expected prompt, context, bash, settled, and session events.
- Compaction, write-tool, and tool-error variants were not exercised. The tee
  was passive; this does not establish block/rewrite effects or the scheduled
  `--transport llm` route.

The local run summary is in ignored `scratch/halogen-check-result.json`; raw
JSONL remains in the temporary capture directory named there. No credential
is stored in either the summary or committed evidence. The observed shapes
already match existing fixtures, so no new shape or capability is claimed.

### Model-backed probes

Run `pnpm run bundle` first; the capture driver uses the repository's Pi
playback launcher to preserve CLI arguments on Windows.

```
node --experimental-strip-types .capture/pi/run-capture.mjs tee             # passive capture
node --experimental-strip-types .capture/pi/run-capture.mjs block-bash      # tool_call block probe
node --experimental-strip-types .capture/pi/run-capture.mjs mutate-input     # in-place input rewrite probe
node --experimental-strip-types .capture/pi/run-capture.mjs replace-output  # tool_result replace probe
node --experimental-strip-types .capture/pi/run-capture.mjs inject-before-agent
node --experimental-strip-types .capture/pi/run-capture.mjs input-handled   # prompt suppression probe
node --experimental-strip-types .capture/pi/run-capture.mjs compact-cancel  # compaction cancel probe
node --experimental-strip-types .capture/pi/run-capture.mjs prevent-stop   # agent_settled turn-injection probe
node .capture/pi/make-fixtures.mjs               # regenerate fixtures (redacting)
```

Package-route probe: install `scratch/hkn-probe-package` into
`scratch/pkg-test` with `PI_CODING_AGENT_DIR=scratch/pi-home pi install -l
--approve <pkg>`, then run a session there with `--approve`.

## Not established by these sessions

- `tool_call` result `terminate` field behavior (batch early-stop) — not probed.
- `message_end` message replacement, `user_bash` operations override,
  `before_provider_request` payload replacement, `context` messages
  replacement — channels exist per types; behavior not probed.
- Reassignment (vs in-place mutation) of `event.input` — types say mutation;
  reassignment untested.
- Whether `session_start` fires twice per run — observed duplicates were
  artifacts of two probe extensions being loaded in one session (`-e` twice
  with the same file loads it once; the duplicates came from earlier runs
  appending to the same capture dir). Fresh clean runs show exactly one
  `session_start` per session.
- Whether `input` `{action: "handled"}` provides the same suppression in
  interactive and RPC modes. The single-prompt print-mode probe succeeded;
  `prompt.before.block` remains unrated until the portable mapping is verified.
- `notify` (user-facing): `ctx.ui.notify` verified to be a safe no-op in
  print mode (`hasUI: false`). Rendering from `session_start` in the TUI and
  in RPC is covered by [session-start notices](#session-start-notices-130-and-140-windows-2026-10-30).
  Notify from other events is not probed.
