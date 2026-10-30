# GitHub Copilot CLI capture project

Capture questions, method, and observations for `@hooknostic/adapter-copilot`,
against **GitHub Copilot CLI 1.0.101** on 2026-10-20; the custom-agent probes
were repeated on **1.0.102** on 2026-10-22. Fixtures live in
`fixtures/copilot/1.0/`; the profile is the normative home for every capability
claim.

## Environment

|  |  |
| --- | --- |
| Harness | `copilot` 1.0.101 (`@github/copilot`, native binary package per platform) |
| Windows host | Windows 11, Node 24.20.0, Windows PowerShell 5.1 |
| Linux host | Debian `node:24-bookworm` container, Node 24, `/usr/bin/bash` |
| Model | `halogen-qwen3.8-flash-next` through the owner's OpenAI-compatible BYOK endpoint |
| Isolation | a scratch git repository per probe, outside this checkout; `COPILOT_HOME` inside that scratch |

Model/provider identity is execution provenance only; it does not upgrade any
payload claim. No credential appears in a capture: the provider key was supplied
through the environment (`COPILOT_PROVIDER_API_KEY`), and hook payloads do not
carry it.

Capture uses `--trust-folder --allow-all-tools --disable-client-telemetry`,
because repository hooks do not load otherwise. A session left to auto-update
downloads a newer build into the shared `%LOCALAPPDATA%\copilot\pkg` cache (seen
2026-10-21: 1.0.102), after which every `copilot`, the native binary included,
starts that build. Every driver here and the playback lane pass
`--no-auto-update`; check `copilot --version` before trusting a capture. The scripts are committed so a
future build can be re-probed:

```
node .capture/copilot/probe.mjs camel-lifecycle
node .capture/copilot/probe.mjs pascal-lifecycle
node .capture/copilot/interactive-skill-probe.mjs project
node .capture/copilot/interactive-skill-probe.mjs plugin
node .capture/copilot/agents-probe.mjs --write   # requires a BYOK provider in COPILOT_PROVIDER_*
node .capture/copilot/interactive-approval-probe.mjs allow
node .capture/copilot/interactive-approval-probe.mjs deny
node .capture/copilot/interactive-compact-probe.mjs [observe|block-json|block-exit2|context]
node .capture/copilot/probe.mjs hooks-malformed
node .capture/copilot/probe.mjs plugin-hooks-malformed
node .capture/copilot/probe.mjs plugin-hooks-valid-shapes
node .capture/copilot/probe.mjs plugin-mcp-stdio-fallback
node .capture/copilot/probe.mjs project-mcp-stdio-fallback
node .capture/copilot/transport-probe.mjs streamable-http
node .capture/copilot/project-transport-probe.mjs http
docker run --rm ... bash /capture/linux-capture.sh
docker run --rm ... bash /capture/workspace-probe.sh
node .capture/copilot/installed-plugin-probe.mjs          # in the Linux container
docker run --rm ... bash /capture/claude-settings-probe.sh
node .capture/copilot/claude-tolerance-probe.mjs [claude-binary]
docker run --rm ... bash /capture/foreign-components-probe.sh
node .capture/copilot/probe.mjs mcp-permission
node .capture/copilot/claude-mcp-fence-probe.mjs [claude-binary]
node .capture/copilot/probe.mjs notification-shell-while-busy
node .capture/copilot/probe.mjs notification-background-agent
node --experimental-strip-types .capture/copilot/session-start-notify.mjs [variant...]
node --experimental-strip-types .capture/copilot/session-start-notify-pty.mjs [variant...]
node .capture/copilot/make-fixtures.mjs
```

## Layout

- `tee.mjs` — hook command: appends stdin verbatim to `captured/<label>.jsonl`,
  optionally prints a fixed JSON answer and exits with a fixed code.
- `probe.mjs` — scratch-project driver for lifecycle, tool-shape, effect,
  skill, plugin and MCP probes. Every hook entry uses `exec`/`args`, the same
  form Hooknostic generates.
- `agents-probe.mjs` — custom-agent driver: project `.github/agents` and Claude
  `.claude/agents` discovery, `--agent` by ID and frontmatter name, a package's
  `agents/` directory, the namespace tree that is not loaded, and two negative
  controls. It writes `evidence/agents-1.0.102.json`.
- `interactive-skill-probe.mjs` — pty driver for the interactive slash command:
  it loads `.agents/skills` or a `--plugin-dir` package, submits `/gated` or
  `/<plugin-name>:gated`, records the screen, and reads the session event log.
  It fails unless the log records `skill.invoked` with `trigger: "user-invoked"`
  and the gate, plus a user message carrying `<skill-context name="gated">`.
  `--headless` also runs the `-p` control and writes a filtered
  `headless-evidence.json`; it fails on a nonzero exit or if the log lacks the
  `skill(gated)` call and its not-found result.
- `interactive-approval-probe.mjs` — pty driver for `permissionDecision: "ask"`.
  `allow` selects Yes and requires the command to run; `deny` selects No/Esc and
  requires the structured session log to record an interactive denial with no
  marker file.
- `interactive-compact-probe.mjs` — pty driver for a manual `/compact`; it
  attaches a `preCompact` tee and captures the real payload. A mode makes the
  tee answer with a JSON block, exit 2 or `additionalContext`; the probe then
  asks the model for the context token and prints the session-event types.
- `mcp-transport-server.mjs` / `mcp-transport-runner.mjs` — a minimal loopback
  Streamable HTTP and legacy SSE MCP server, run as a child process (a
  `spawnSync` driver would block an in-process server's event loop).
- `transport-probe.mjs`, `project-transport-probe.mjs` — plugin and project
  remote MCP probes; record the URL and headers the client sent.
- `linux-capture.sh` — shell-dialect capture inside a disposable Debian
  container.
- `workspace-probe.sh` — whether `GITHUB_WORKSPACE` moves where project stdio
  MCP servers start (Linux container, no model needed).
- `claude-settings-probe.sh` — whether Copilot runs Claude Code's
  `.claude/settings*.json` hooks, in which entry forms, and which keys make it
  drop them (Linux container, no model needed).
- `foreign-components-probe.sh` — which of Claude's project skills and MCP
  servers Copilot loads beside its own, which file wins, and which fences it
  honours (Linux container, no model needed).
- `claude-mcp-fence-probe.mjs` — Claude's side of a shared root `.mcp.json`:
  `cwd`, `disabledMcpjsonServers`, and Copilot's fence file.
- `claude-tolerance-probe.mjs` — the other half: whether Claude Code still
  runs an entry carrying such a key and applies the rest of the settings file.
- `installed-plugin-probe.mjs` — installs one package three ways (a direct git
  URL, a git-hosted marketplace, `--plugin-dir`) from a loopback smart-HTTP git
  server and records the install tree, a dependency-install marker, and the
  `PLUGIN_ROOT`/`PLUGIN_DATA` a hook and a stdio server see.
- `session-start-notify.mjs` / `session-start-notify-pty.mjs` — the
  session-start notice probe, headless and TUI, against the loopback model
  (no model spend). `COPILOT_BINARY` selects the build.
- `make-fixtures.mjs` — redacts the account name to `user` and writes input
  fixtures plus the native-event hints the camelCase payloads need.
- `captured/` — gitignored raw tees.

## Hook wire facts

| Question | Observation on 1.0.101 | Consequence |
| --- | --- | --- |
| Where do repository hooks live? | `.github/hooks/*.json`, `{version: 1, hooks: {...}}`; loaded at CLI start. User hooks are `$COPILOT_HOME/hooks/*.json`. | Project integration writes one whole file at `.github/hooks/hooknostic.json`. |
| Are repository hooks gated? | Without `--trust-folder` (or `COPILOT_ALLOW_ALL=true`) they silently do not run: same project, same prompt, zero payloads. | Documented human prerequisite. |
| Which directory do they load from? | A session started in `nested/` loaded only `nested/.github/hooks`, not the repo root's file. A linked worktree loaded the worktree's own file. | Project guidance: start Copilot at the project root. No `rootCheckoutProjectPaths` quirk. |
| CamelCase vs PascalCase events | Configuring `sessionStart` and `SessionStart` for one event fires both entries. CamelCase payloads use `sessionId`/`toolName`/`toolArgs`; PascalCase payloads state `hook_event_name` and use `session_id`/`tool_name`/`tool_input`. | Decoder accepts both. Generation uses camelCase, which keeps `powershell` beside `bash`. |
| Does a camelCase payload name its event? | No `hook_event_name`; `permissionRequest` uniquely carries `hookName: "permissionRequest"`; `notification` carries `hook_event_name: "Notification"`. | The generated entry passes its native event as argv[1] (the shim's `process.argv[2]`), and decode treats it as a hint. `raw` is untouched. |
| PascalCase tool names | `PreToolUse.tool_name` is the Claude name: the runtime `powershell` call arrives as `Bash`; `create`/`view`/`edit` become `Write`/`Read`/`Edit`, while the input keys stay native (`path`, `file_text`, `old_str`, `new_str`). | Pascal shapes map the file keys and the shell `command`; `Bash` carries no dialect because it aliases both runtime tools. |
| PascalCase subagent payload | `SubagentStart` is hybrid: camelCase base (`sessionId`, `transcriptPath`) with snake agent fields (`agent_id`, `agent_type`, `parent_agent_id`), and no `hook_event_name`. `SubagentStop` is fully snake. | Reader accepts either spelling per field. |
| Correlation ids | Every payload has `sessionId` and `cwd`. Subagent events and events fired inside a subagent add `agentId`/`agentType`/`parentAgentId`. No payload carries a turn id or a tool-call id. | Only the stated ids are surfaced; `toolCallId`/`turnId` stay absent. |
| Timeout | `timeoutSec` (seconds), default 30. | Emitted from the portable runtime budget. |
| `command` fallback vs `exec` | The cross-platform `command` form reached the shell in a probe but failed under our quoting; `exec` + `args` ran every probe. | Generated artifacts use `exec`/`args` only. |

## Effect facts, verified by effect

| Channel | Observation | Consequence |
| --- | --- | --- |
| `preToolUse` deny | `{permissionDecision:"deny", permissionDecisionReason}` blocked the call and the reason reached the model. Exit 2 also blocks (a bare exit-2 probe denied). | Encode the deny as JSON on exit 0; exit 2 remains a harness-side fail-closed path for crashes. |
| `preToolUse` rewrite | `modifiedArgs` replaced the arguments at execution: the tool result was `marker-modified-args` although the timeline showed the original. | `replaceInput`/`updateShell` lower to `modifiedArgs`. |
| `preToolUse` ask | `{permissionDecision:"ask"}` denied in `-p` with "unable to ask user for confirmation". Interactively, it surfaced the native "Hook permission request" dialog with the hook reason; Yes ran the command and No/Esc denied it. | Exact: both user choices and the headless deny are captured. |
| `preToolUse` context | `{additionalContext}` on the same event reached the model (it quoted the token), though the hook reference does not list the field. | `tool.before.context.add` exact. |
| Multiple `preToolUse` entries | The first entry's deny short-circuited; the second entry never ran. | A deny is terminal across entries, matching one-dispatcher composition. |
| `postToolUse` output | `{modifiedResult:{resultType:"success",textResultForLlm}}` replaced what the model saw. `additionalContext` rides beside it. | `tool.after.output.replace` exact, text-encoded. |
| `postToolUse` block | `{decision:"block",reason}` replaced the result with `Tool result blocked: <reason>`. Asked for three sequential calls, the model made no call after the first block and replied as the reason told it; `additionalContext` beside the block was dropped. `{continue:false,stopReason}` changed nothing. | `tool.after.blockContinuation` approximate; context from the dispatch joins the reason. |
| `postToolUseFailure` context | `{additionalContext}` on exit 0 reached the model. Plain stdout with exit 2 did **not**, contrary to the reference's exit-code table. | `tool.error.context.add` uses the JSON field on exit 0. |
| `permissionRequest` | Fires before the permission service even in `-p` with `--allow-all-tools`. `{behavior:"allow"}` let the call run; `{behavior:"deny",message}` blocked it and the message reached the model. `{additionalContext}` beside an allow did not reach it. | Observe and block exact; `permission.request.context.add` unsupported. |
| `userPromptSubmitted` block | Exit 2 did not stop the turn. `{decision:"block",reason}` on exit 0 did: the session log has no user message and no model turn, `-p` exited 1, and the reason was printed. | `prompt.before.block` exact, JSON on exit 0. |
| `userPromptSubmitted` context | `{additionalContext}` was not delivered. `{modifiedPrompt}` was, although the hook reference says config-file output is dropped: the model answered the replacement, and the session log kept the typed prompt as `content` with the replacement in `transformedContent`. | `prompt.before.context.add` emulated: the context is appended to the native `prompt` as `modifiedPrompt`. |
| `userPromptTransformed` output | `{modifiedTransformedPrompt}` replaced what the model saw. `{additionalContext}` and a JSON block with exit 2 were ignored. | Declined: `modifiedPrompt` covers the context case on the event `prompt.before` already uses. |
| `preCompact` | Interactive `/compact` produced `{trigger:"manual", transcriptPath, customInstructions:""}`. A `{decision:"block"}` answer and an exit 2 both left `session.compaction_complete` in the log, and `{additionalContext}` did not reach the model afterwards. Neither a `postCompact` entry nor `sessionStart` fired after compaction. | `context.compact.before.observe` and the `trigger` field exact; block, context and `context.compact.after` unsupported. |
| `sessionStart` context | `{additionalContext}` was injected verbatim; the model quoted the token. | `session.start.context.add` exact. |
| `agentStop` prevent | `{decision:"block",reason}` forced another turn. The harness stopped after eight consecutive blocks; later calls had `stop_hook_active:true`. | `turn.stop.prevent` exact. |
| `subagentStop` prevent | `{decision:"block",reason}` forced more subagent turns. A session-scoped hook blocked more than forty consecutive completions with `stop_hook_active:true`; the documented eight-block guard was not observed. | `agent.stop.prevent` approximate, with the unbounded-loop rationale. |
| User-facing notification on stop | `{decision:"allow",reason}` changed nothing the user sees, and `{systemMessage}` on `agentStop` and `subagentStop` appeared neither in the output nor in the session log. | `*.notify` unsupported. |
| User-facing notice at session start | `{systemMessage}` on `sessionStart` was shown nowhere and never reached the model. A `type:"prompt"` entry is an auto-submitted user turn, not a notice. See [Session-start notice](#session-start-notice). | No `session.start.notify` channel. |

## Session-start notice

Question: can a `sessionStart` hook show the user a notice that the model never
sees? This is the evidence for a possible portable `session.start.notify`; no
vocabulary or adapter behaviour depends on it yet.

Method (2026-10-30, Windows 11, no model spend): `session-start-notify.mjs`
(headless) and `session-start-notify-pty.mjs` (TUI under node-pty with an
`@xterm/headless` screen) run the real binary against the loopback playback
model with the BYOK variables the playback lane uses, a private `COPILOT_HOME`
and `COPILOT_ALLOW_ALL=true` (`--trust-folder` is refused beside `--resume` and
outside `-p`). A command hook answers `{systemMessage}` (`notify`),
`{systemMessage, additionalContext}` (`compose`) or `{additionalContext}`
(`context`, the control). Each string carries a per-run nonce and the payload's
`source`. The `prompt` variants add a `{type:"prompt", prompt}` entry beside a
silent command entry. Every variant ran again under `SessionStart` (`pascal-*`),
where `compose` and `context` also returned
`hookSpecificOutput.additionalContext`. Each nonce was searched in stdout and
stderr (text and `--output-format json`), in every file under `COPILOT_HOME`
(session `events.jsonl` and the process logs), on the rendered screen, and in
every loopback request. Builds: scratch `npm install --prefix` of 1.0.101 and
1.0.102. With auto-update left on, a native binary starts the newest build in
`%LOCALAPPDATA%\copilot\pkg`, whatever its own version.
`COPILOT_AUTO_UPDATE=false` kept the 1.0.101 binary on 1.0.101. Every run sets
it and records `--version` under that environment.

| Source (how) | Surface | `systemMessage` shown | `systemMessage` reached model | `additionalContext` | `prompt` entry |
| --- | --- | --- | --- | --- | --- |
| `new` (`-p`) | stdout text and JSON stream | no | no | not shown; reached the model | did not run |
| `resume` (`-p --resume=<id>`) | stdout text and JSON stream | no | no | not shown; reached the model | did not run |
| `new` (TUI first prompt) | screen | no | no | not shown; reached the model | submitted at launch as the first user turn: shown as `❯ <prompt>`, answered by the model |
| `resume` (TUI `--resume=<id>`) | screen | no | no | not shown; reached the model | not resubmitted; the earlier turn is replayed from history |
| `new` (TUI `/clear`) | screen | no | no | not shown; reached the model | submitted again in the fresh session |

Observations, identical on 1.0.101 and 1.0.102 and in both hook spellings:

- **`systemMessage` is dropped at parse.** The hook printed it on every run, but
  the session log's `hook.end` record keeps only recognised output. That is
  `{"success":true}` for `notify`, and `output:{additionalContext}` only for
  `compose`. The nonce appeared in no output stream, log, screen or request.
- **Sources.** Only `new` and `resume` were observed. `/clear` in the TUI
  starts a new session id and fires the event again with `source: "new"`.
  Compaction does not fire it (`preCompact` row above).
- **Timing in the TUI.** The event fires when the first prompt is submitted,
  not at launch: its `initialPrompt` is the typed text, so nothing a hook
  returns can be on screen before the user's first prompt. A `prompt` entry
  becomes that first prompt, which fires the event at launch with
  `initialPrompt` set to the entry's text.
- **Context placement.** `additionalContext` arrives as its own `user`
  message holding exactly the string, before the user's prompt. On resume the
  new `-resume` context is inserted at the head of the replayed history, and
  the original `-new` context is not replayed. Under `SessionStart`,
  `hookSpecificOutput.additionalContext` beside a top-level
  `additionalContext` did not reach the model; only the top-level field did.
  The nested field was not probed alone.
- **`prompt` entry.** Interactive-only. In `-p` it neither ran nor reached
  the model. In the TUI it is a real user turn: written to the log as
  `user.message`, sent to the model, and shown as the user's own input. It is
  model-visible by construction, so it is no notice channel.

Consequence: Copilot has no user-only channel at session start. A portable
`session.start.notify` would be `unsupported` here; the only start-time output
that reaches anything is `additionalContext`, which is model-visible.

## Tool shapes and shell dialects

| Tool | Captured input | Classification |
| --- | --- | --- |
| `powershell` (Windows) | `{command, description}` | shell, dialect `powershell`; ran `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe` 5.1, and was the only shell tool advertised on that host |
| `bash` (Linux) | `{command, description}` | shell, dialect `posix`; ran `/usr/bin/bash` |
| `bash` (macOS arm64) | `{command, description}` | shell, dialect `posix`; ran `/bin/bash` (`.capture/shell-dialects/observations-macos-copilot.json`) |
| `create` | `{path, file_text}` | file.write, file.path |
| `view` | `{path}` | file.read, file.path |
| `edit` | `{path, old_str, new_str}` | file.edit, file.path |
| `glob` | `{pattern}` | file.read, no file view |
| `grep` | `{pattern, paths, output_mode}` | file.read, no file view |
| `web_fetch` | `{url}` | web.fetch |
| `task` | `{name, agent_type, description, prompt}` | agent |
| `skill` | `{skill}` | other |
| `list_powershell`, `read_powershell`, `stop_powershell`, `run_dynamic_workflow` | background-session/dynamic-workflow controls | other |

A Windows host advertised no `bash` tool; a Linux host advertised no
`powershell` tool. macOS was captured separately in `.capture/shell-dialects`
(the arm64 `bash` tool ran `/bin/bash`). An MCP call arrives as
`<server>-<tool>` (`probe-probe_echo`); the built-in GitHub server's tools are
`github-mcp-server-*`. Both segments may contain hyphens and no payload states
the split, so `tool.mcp` is never set (ADR-0032).

## Skills

| Question | Observation | Consequence |
| --- | --- | --- |
| Discovery | `.github/skills`, `.agents/skills` and `.claude/skills` are project sources; `.agents/skills` was listed and invoked. | Project integration writes `.agents/skills`. |
| `.claude/skills` beside `.agents/skills` (`foreign-components-probe.sh`, `copilot skill list`) | A name present in both listed once, from `.agents/skills`; distinct names merged, so a `.claude/skills`-only skill is listed too. | In a project targeting both, Copilot uses its own `.agents/skills` copy of a shared skill. A skill only Claude's target writes, or Claude's copy in a project without a Copilot target, reaches Copilot as an Agent Skills `SKILL.md` with `${CLAUDE_SKILL_DIR}` left literal; that is accepted as a shared standard format (ADR-0033). |
| Skill text | A loaded skill's context has a `Base directory for this skill: <path>` line, but the body kept `${SKILL_DIR}`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` and `$CLAUDE_SESSION_ID` as written. | `${SKILL_DIR}` is rewritten to an explicit model-substituted placeholder; other references are reported as unexpanded. |
| Invocation policy, interactive | `disable-model-invocation: true` withheld a project skill from ordinary listing. `/gated` in `.agents/skills` injected the gated body and the model answered from it; a package skill loaded with `--plugin-dir` did the same as `/hooknostic-interactive-skill-probe:gated`. Neither run made a `skill()` call. The session log recorded `skill.invoked` with `trigger: "user-invoked"` and `disableModelInvocation: true`, and the user message carried `<skill-context name="gated">`. | `agent-plugin.skills.invocation-policy` exact on the captured version: apply native `disable-model-invocation` after authored overlays. Project and package skills both retain explicit slash invocation. |
| Invocation policy, `-p` | A `-p` prompt naming `/gated` is text, not a slash command. The model-facing `skill()` tool excludes the gated skill, so `skill(gated)` returned `Skill not found`; the explicit `disable-model-invocation: false` control (`allowed`) and the ungated `open` control stayed in the available list. | Headless prompt mode has no explicit-invocation path; the policy rationale records it. Interactive use is unaffected. |

An earlier reading treated the `-p` model-facing call as an explicit slash
invocation. The pty probe separates the two: the interactive slash command
injects the skill, while `-p` has no slash path and can only ask the model to
call `skill()`. The probe writes the filtered `evidence.json` beside the screen
under ignored `captured/`; it fails if the session log lacks the injection.

## Custom agents

Curated evidence: [`evidence/agents-1.0.102.json`](evidence/agents-1.0.102.json).
The driver is `agents-probe.mjs`; it uses the provider configured by
`COPILOT_PROVIDER_*`, not a paid GitHub model.

| Question | Observation on 1.0.102 | Consequence |
| --- | --- | --- |
| Where do project agents live? | `.github/agents/<id>.agent.md` and `.github/agents/<id>.md` both load. The ID is the file stem without either extension, and `--agent` also accepts the frontmatter `name`. | Project integration writes `.github/agents/<name>.agent.md`. |
| What is in the file? | YAML frontmatter with `name`, `description` and optional `tools`; the Markdown body becomes the selected agent's instructions. `tools: ["read"]` was recorded as the selected agent's tool list, and the body's random token was the model's reply. | The portable `name`, `description` and body map directly; `native.copilot` fields ride in the frontmatter. |
| How is it selected? | `--agent <id>` and `--agent <frontmatter name>` both selected the same file. The session log recorded `subagent.selected` with `agentName` and `tools`. | `agents.primary` is exact. |
| Can it be a subagent? | Copilot documents delegation to custom agents and exposes an `agent`/`Task` tool alias. The captured session's `subagent.selected` event is the CLI's own record of the selected agent, not a model-initiated delegation. | `agents.definition` is exact; a model-initiated delegation was not separately driven. |
| Default agent | `copilot help config` and `copilot config --list` expose no project or user key that starts every session as a custom agent. `--agent` and `/agent` are per session. | `agents.default` is unsupported, not emulated. |
| Package route | A `--plugin-dir` package's `agents/pkg.agent.md` loaded as `<plugin>:pkg` and ran its instructions. The same package's `com.github.copilot/agents/ns.agent.md` was not listed. | The projector writes `agents/<name>.agent.md` at the plugin root; the client-extension namespace is not an agent route. |
| Claude's directory | `.claude/agents/foreign.md` was listed and selectable as `foreign`. With both `.github/agents/shared.agent.md` and `.claude/agents/shared.md` present, `--agent shared` ran the `.github` copy. | This is a foreign read (ADR-0033). A same-ID Copilot target copy wins; a Claude-only project's agents are still visible to Copilot. |
| Negative controls | `--agent does-not-exist` exited 1; a `.github/agents/malformed.md` with no frontmatter exited 1; the namespace package's `plugin:ns` exited 1 with "No such agent". | The positives are not an artifact of every unknown name being accepted. |

Limits: Windows only; no Linux or macOS run. `--agent` selection was driven
headlessly, not through the interactive `/agent` picker. A model-initiated
delegation was not required by the assertions; the documented route and the
selected-agent event are the evidence for availability. The package agent was
loaded with `--plugin-dir`, not installed from a marketplace.

## MCP

| Route | Observation | Consequence |
| --- | --- | --- |
| Project `.mcp.json` stdio | `{type:"stdio", command, args, env, cwd}` starts. `cwd` is honoured; relative `args` resolve from the project root; ambient `${USERPROFILE}` expands in args/env; `${PLUGIN_ROOT}` stays literal. | Project stdio goes through the shared launcher. |
| Project `.github/mcp.json` | The same stdio declaration works when moved to `.github/mcp.json`; the probe connected and called its tool. | Valid only without a root `.mcp.json` (next row), so project integration writes the root file. |
| `.mcp.json` beside `.github/mcp.json` (`foreign-components-probe.sh`, Linux) | Copilot reads **one** workspace file: a root `.mcp.json` whenever it exists, else `.github/mcp.json`. With both present only root servers launched, whether names matched or not; an empty `{"mcpServers":{}}` or an unparseable root file launched nothing, with no fallback. A root entry Copilot rejects (`type: "bogus"`) was skipped alone and its valid sibling launched. | Project integration writes the root `.mcp.json`, which Claude Code reads too. A server both targets declare gets one entry that serves both: entries are shared, and `sync` refuses a server whose per-target overrides define it differently (ADR-0033). |
| Fences in a shared root file (Linux, 1.0.101, plus `claude-mcp-fence-probe.mjs` on Claude 2.1.238 and 2.1.306) | `.github/copilot/settings.json` `disabledMcpServers` stopped the named servers in Copilot, and Claude ignored it. Claude's `disabledMcpjsonServers` in `.claude/settings.json` stopped the named server in Claude, and Copilot ignored it. Repo-level `deniedMcpServers` was ignored in every form. An entry with `cwd: "."` started in the project under Copilot even with `GITHUB_WORKSPACE` elsewhere, and Claude ran it in the project, ignoring `cwd`. | Shared entries carry `cwd: "."`. When `components.targets` selects one of the two harnesses, core writes the root servers to the other's setting, so the left-out harness starts none of them. |
| `GITHUB_WORKSPACE` (`workspace-probe.sh`, Linux) | The config is still read from the session's directory, but a stdio server with no `cwd` is spawned **in `GITHUB_WORKSPACE`** when that is set, and relative `args` resolve there: with it pointing at another project, Copilot ran that project's `server.mjs`. A missing directory means no spawn. An explicit `cwd: "."` or `cwd: "sub"` resolved against the session's project either way. Found when the CI playback lane, whose `GITHUB_WORKSPACE` is the repository checkout, failed to start the project launcher. | Project integration writes `cwd: "."` beside the relative launcher path. |
| Project `.mcp.json` remote | `type:"http"` (Streamable HTTP) and `type:"sse"` both connected to the loopback server. Ambient `${USERPROFILE}` expanded in the URL query; a missing `${HOOKNOSTIC_PROBE_MISSING:-fallback}` used the fallback in both the URL and headers; `${PLUGIN_ROOT}` stayed literal. | Both remote transports exact, with the environment-expansion deviation for a package's text. |
| Agent Plugins `mcp.json` stdio | `command`, `args`, `env`, `cwd` all expand `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`; `${PLUGIN_ROOT}/node-copy.exe` launched. Ambient `${USERPROFILE}` also expanded. The server's cwd was the `PLUGIN_DATA` directory. `PLUGIN_ROOT`/`PLUGIN_DATA` are exported in its environment. | `mcp.stdio` exact, with an ambient-expansion deviation. |
| Agent Plugins `mcp.json` remote | Streamable HTTP and SSE both connected. `${PLUGIN_ROOT}` stayed literal in headers (conforming); `${USERPROFILE}` and `${HOOKNOSTIC_PROBE_MISSING:-fallback}` expanded in the URL query and headers (not conforming). | Both remote components exact, with the deviation. |
| Plugin data | `PLUGIN_DATA` resolved under `$COPILOT_HOME/plugin-data/_direct/<hash>` and persists across sessions. | No launcher or data relocation needed for package delivery. |
| Reference forms, stdio | `plugin-mcp-stdio-fallback` and `project-mcp-stdio-fallback` log each server's argv, cwd and env at launch. `${NAME:-fallback}` (unset name) took its fallback in `command`, `args`, `env` and `cwd`; a set name won over its fallback. Bare `$NAME` expanded when set, whole or embedded (`x$NAME-y`), in all four fields, and stayed literal when unset. `%NAME%` stayed literal. On the plugin route `$PLUGIN_ROOT`, `$PLUGIN_DATA` and `${PLUGIN_ROOT:-x}` expanded to the aliases in `command`, `args`, `env` and `cwd`. | Every form is a deviation except the exact `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` in `args`, `env` and `cwd`. |
| Reference forms, remote | The transport probes add bare `$NAME`, `%NAME%`, `$PLUGIN_ROOT`, `${PLUGIN_ROOT:-fallback-root}` and a header **named** `X-Probe-Name-$HOOKNOSTIC_PROBE_SET`. Bare `$NAME` expanded in the URL and header values; `%NAME%` and bare `$PLUGIN_ROOT` stayed literal; `${PLUGIN_ROOT:-fallback-root}` became `fallback-root`; the header name arrived as written on all four routes. | Header names are conforming; the alias-with-fallback is a deviation. The loader's header-name validation already rejects `${...}` there. |
| Plugin stdio `cwd` | `./sub`, `${PLUGIN_ROOT}/sub`, `${PLUGIN_DATA}` and alias-rooted values holding `${NAME}`, `${NAME:-x}` or `$NAME` were honoured. An absolute path, a bare relative `sub`, a wholly ambient `${NAME}` and `${NAME:-<absolute>}` all ran in the plugin root instead; an alias-rooted value that expanded to an invalid path failed to spawn. | The forms Copilot ignores are exactly those Agent Plugins 1.0 makes invalid, which the loader already rejects. The project route honoured every form. |

## Plugins

- **Agent Plugins 1.0** is native: `plugin.json` with the canonical `$schema`,
  `skills/`, `mcp.json`, and Copilot components under `com.github.copilot/`.
- `--plugin-dir <path>` loads the plugin live and lists it as an external
  plugin. A local marketplace (`copilot plugin marketplace add <path>` followed
  by `copilot plugin install probe@probe-market`) also loads it live from the
  source path: "nothing was copied". A `package.json` plus lockfile in the
  plugin root produced no `node_modules`.
- Hooks declared in a legacy plugin's `hooks.json` fire, and hooks declared in
  `com.github.copilot/hooks/hooks.json` fire for an Agent Plugins 1.0 package on
  1.0.101. The 1.0.60–1.0.82 reports of plugin hooks never running were not
  re-probed at those builds, so the adapter's target range starts at 1.0.101
  rather than assuming the fix reached earlier releases.
- A plugin hook may use `${PLUGIN_ROOT}/tee.mjs` in `exec` `args`; a relative
  `tee.mjs` also ran, so the plugin hook's cwd is the plugin root.
- **Installed (copied) plugins** (`installed-plugin-probe.mjs`, Linux,
  1.0.101): a direct git-URL install copies the package to
  `$COPILOT_HOME/installed-plugins/_direct/<url-slug>/` (Copilot warns that
  direct installs are deprecated), and `plugin@marketplace` from a git-hosted
  marketplace (`.github/plugin/marketplace.json`) copies it to
  `installed-plugins/<marketplace>/<plugin>/`. Neither ran a dependency
  install: the package's `postinstall` marker never appeared and no
  `node_modules` was created. The installed hook fired and the stdio server
  started from the copy, with `PLUGIN_ROOT` the copy and `PLUGIN_DATA` under
  `plugin-data/_direct/<hash>` or `plugin-data/<marketplace>/<plugin>`. The
  `--plugin-dir` control copied nothing. A hook's environment carried
  `PLUGIN_ROOT` but not `PLUGIN_DATA` on all three routes; a stdio server's
  carried both. A copied install is a snapshot, so a rebuilt package reaches
  Copilot only through `copilot plugin update`.
- **A malformed hook entry rejects a plugin's whole hooks file**, while a
  `.github/hooks/*.json` file drops only that entry (`hooks-malformed`,
  `plugin-hooks-malformed`): in the plugin no entry beside the fault ran, on
  any event. The loader logged each rejection: a non-object entry; a command
  entry with neither `exec` nor `bash`/`powershell`/`command`, or with both; a
  `type` other than `command`, `http` or `prompt`; a `prompt` entry off
  `sessionStart`; an `http` entry without `url`, or with a plain `http://` URL
  on `preToolUse`, `permissionRequest` or the undocumented `preMcpToolCall`; a
  non-string `exec`, shell field or `cwd`; `args` that is not an array of
  strings; `env` that is not an object of strings; a non-numeric `timeoutSec`
  or `timeout`. A wrong `version` or a non-array event list rejects the file on
  either route, and an unknown event name is ignored.
- Accepted beside a sibling that then ran (`plugin-hooks-valid-shapes`): a
  missing `type`, `exec` without `args`, `cwd`/`env`/`timeoutSec`, the
  `timeout` alias, a `matcher` (even an invalid regex or a number), an unknown
  field, `bash` and/or `powershell`, `command`, a `sessionStart` prompt hook
  and an `http` hook. The projector applies the rejection rules to authored
  hooks before merging them with the dispatcher's entries.
- A legacy plugin's skill and an Agent Plugins package's skill both loaded.

## Coexistence with Claude Code project hooks

Found by a consumer smoke test on 1.0.102 and reproduced on 1.0.101: in a
project that also targets Claude Code, **Copilot denied every shell call**.

| Question | Observation | Consequence |
| --- | --- | --- |
| Does Copilot run Claude's project hooks? | Yes. `claude-settings-probe.sh` (Linux, 1.0.101) ran a `SessionStart` entry from `.claude/settings.json` and from `.claude/settings.local.json`, attributed to `"repo settings"`, with a PascalCase payload. | Any repository with Claude project hooks is also a Copilot hook source. |
| Does Hooknostic's Claude entry run there? | No. Copilot runs `command` as a shell command and ignores `args`, so `{command:"node", args:[<dispatcher>]}` ran a bare `node` that read the payload as a script and exited 1. On `preToolUse` that failed closed: an allowed `echo` was refused with `Denied by preToolUse hook from "repo settings" (hook errored)`. The PascalCase tool name `Bash` matched the entry's `Bash\|PowerShell` matcher. | The entry must not reach Copilot at all. Copilot runs Hooknostic's own Copilot target from `.github/hooks`. |
| Can a settings file opt out? | One entry with `exec` beside `command`, or a non-numeric `timeoutSec`, made Copilot drop the file's whole `hooks` field: neither that entry, a valid sibling, nor a second event ran, and nothing failed closed. No Copilot setting turns off reading Claude's settings; `disableAllHooks` would also turn off Hooknostic's Copilot hooks. | |
| Does Claude tolerate the key? | `claude-tolerance-probe.mjs` on 2.1.238 and 2.1.306: an entry carrying either key still ran, and the same file's `env` value reached it, so the settings file was not rejected. | The Claude project integration writes `timeoutSec: "hooknostic: Claude Code only; …"` on every entry. A hand-written hook in the same `.claude/settings.json` therefore no longer runs under Copilot either. |

## Declined events

- `errorOccurred` and `userPromptTransformed` are captured and declined: no
  portable event names a generic error or a pre-model prompt transformation.
- `notification` is captured and declined (Linux, 1.0.101): a background
  shell finishing while the agent ran another command produced
  `notification_type: "shell_completed"`, and a background subagent produced
  `agent_idle`. Both payloads state `hook_event_name: "Notification"`. A
  shell whose output the agent read with `read_bash` raised none. No portable
  event names an asynchronous status notice.

## Not established

- Any host without a native platform package.
- The `permission_prompt`, `elicitation_dialog` and `shell_detached_completed`
  notification types; the event is declined whatever its type.
