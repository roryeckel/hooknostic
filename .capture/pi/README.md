# pi tee-capture project

Committed capture project for the pi coding agent (pi.dev,
`@earendil-works/pi-coding-agent`). pi is an **in-process TypeScript extension
harness** like OpenCode: extensions are modules pi imports; handlers receive
**live objects**, not JSON on stdin. The tee serializes a per-value-degraded
clone (never mutating what it was handed) and, in probe modes, deliberately
mutates or returns results to verify effect channels by effect.

## Layout

- `hooknostic-capture.ts` — the capture + probe extension. Subscribes to
  every event the adapter observes and tees each invocation's payload to
  `captured-<probe>/<event>.jsonl`. `HKN_PI_PROBE` selects a mutation
  experiment; `HKN_CAPTURE_DIR` redirects output.
- `run-capture.mjs` — drives one probe session (`node .capture/pi/run-capture.mjs
  [probe]`), writing to `captured-<probe>/` (gitignored). It uses the
  `ollama-localhost/deepseek-v4.1-flash:cloud` entry in Pi's user-wide
  `~/.pi/agent/models.json`. Compaction probes copy that entry into an
  ignored scratch settings directory with a 2048-token context window.
- `make-fixtures.mjs` — extracts, redacts, and curates
  `fixtures/pi/0.84/*.input.json` from the raw captures.
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
  channel is a `custom` message, which the model sees verbatim (the
  `model-request-before-context-add` scenario is recorded inconclusive for pi
  for this reason — its assertion demands a system message).
- The scheduled compaction scenario is recorded inconclusive for pi like the
  other three harnesses (loopback cannot fill a context window
  deterministically); the compaction cells are live-verified by the
  compact-cancel/compact-run probes above.
- The installed **projected Agent Plugin** package was driven through
  `pi install -l --approve <path>` in an isolated project and agent home,
  using a loopback model server. Its skill description reached model input,
  and its bundled hook rewrote a shell command (verified by the created file's
  content). Removing the `pi.extensions` declaration made the same test execute
  the original command, so mere package installation is not taken as evidence
  that hooks ran. This is the local-path route; npm-published installation is
  not established by this probe.

## Captured facts (pi 0.84.4, Windows, 2026-09-27)

All "verified by effect" claims below were observed as changes in model
behavior or session artifacts, never by absence of harness errors.

| Channel | Claim | Evidence class |
|---|---|---|
| Extension loading | discovery loads `*.ts`/`*.js` only from project `.pi/extensions/` and global `<agentDir>/extensions/`, one level deep (no `.mjs`) | schema-derived (loader.js source) + captured (extension loaded via `-e`) |
| `session_start` | payload `{type, reason: "startup"\|"reload"\|"new"\|"resume"\|"fork", previousSessionFile?}` | captured |
| `input` | **low-level event: fires per token** in print mode (prompt text arrives word-by-word as multiple `input` events), not once per submission. Not a semantic prompt boundary — `before_agent_start` is. `{action: "handled"}` suppressed the turn **mid-stream only**: suppressing the first token still ran the agent (2× `agent_start`) and the print-mode process hung. Unusable as a block channel — unrated in the profile | captured + verified by effect |
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
| Tool shapes | `bash`/`powershell` `{command, timeout?}` (no cwd key); `read` `{path, offset?, limit?}`; `write` `{path, content}`; `edit` `{path, edits: [{oldText, newText}]}`; `grep` `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit?}`; `find` `{pattern, path?, limit?}`; `ls` `{path?, limit?}` | schema-derived (tools type defs) + captured (bash, write) |
| Stale ctx | after compaction reload/session replacement, captured `ctx` is **stale** — using it logs "Extension error … ctx is stale". The shim must never cache ctx across such boundaries | captured (twice) |
| Permission channel | **none exists** in the extension event surface (0.84.4 types enumerate all events; no permission event) | schema-derived |
| Native MCP | **none** in the harness; MCP arrives via third-party extensions (the capture environment had `npm:pi-mcp-adapter` and `npm:pi-subagents` globally installed, which added `mcp`/`mcpScript`/`subagent` tools to the system prompt — environment contamination noted, not a harness fact) | schema-derived + captured (system prompt) |
| pi packages | `package.json` `"pi"` manifest declares `extensions`, `skills`, `prompts`, `themes` (globs supported); `pi install -l <path>` writes a path reference to project `.pi/settings.json` (requires `--approve` on untrusted projects); installed package's extension **and** skill both load (verified: marker file written; skill answered "package-skill-loaded-ok") | captured + verified by effect |
| Skills | native Agent Skills standard: `SKILL.md` + frontmatter `name`/`description`, XML prompt injection, name falls back to directory name | schema-derived (skills.js source) + captured (behavior) |

## Fixture curation

`fixtures/pi/0.84/` holds the curated cases (input = shim invocation shape
`{event, ctx: {cwd, mode}}`), redacted per the harness-capture skill. The
provenance table lives in `fixtures/pi/0.84/README.md`.

## Reproduce

```
node .capture/pi/run-capture.mjs tee             # passive capture
node .capture/pi/run-capture.mjs block-bash      # tool_call block probe
node .capture/pi/run-capture.mjs mutate-input     # in-place input rewrite probe
node .capture/pi/run-capture.mjs replace-output  # tool_result replace probe
node .capture/pi/run-capture.mjs inject-before-agent
node .capture/pi/run-capture.mjs input-handled   # prompt suppression probe
node .capture/pi/run-capture.mjs compact-cancel  # compaction cancel probe
node .capture/pi/run-capture.mjs prevent-stop   # agent_settled turn-injection probe
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
  `session_start` per session, and `input` firing once per prompt token in
  print mode (not once per prompt).
- **`input` `{action: "handled"}` is not a usable block channel**: mid-stream
  suppression worked (turn never started), but suppressing the first token
  still ran the agent and the print-mode process hung. Unrated in the
  profile; `prompt.before.block` stays unsupported on pi 0.84.x.
- `notify` (user-facing): `ctx.ui.notify` verified to be a safe no-op in
  print mode (`hasUI: false`); TUI/RPC rendering not probed (no fixtures can
  represent it).
