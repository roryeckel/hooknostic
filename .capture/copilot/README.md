# GitHub Copilot CLI capture project

Capture questions, method, and observations for `@hooknostic/adapter-copilot`,
against **GitHub Copilot CLI 1.0.101** on 2026-10-20. Fixtures live in
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
because repository hooks do not load otherwise. The scripts are committed so a
future build can be re-probed:

```
node .capture/copilot/probe.mjs camel-lifecycle
node .capture/copilot/probe.mjs pascal-lifecycle
node .capture/copilot/interactive-skill-probe.mjs project
node .capture/copilot/interactive-skill-probe.mjs plugin
node .capture/copilot/interactive-approval-probe.mjs allow
node .capture/copilot/interactive-approval-probe.mjs deny
node .capture/copilot/interactive-compact-probe.mjs
node .capture/copilot/transport-probe.mjs streamable-http
node .capture/copilot/project-transport-probe.mjs http
docker run --rm ... bash /capture/linux-capture.sh
node .capture/copilot/make-fixtures.mjs
```

## Layout

- `tee.mjs` — hook command: appends stdin verbatim to `captured/<label>.jsonl`,
  optionally prints a fixed JSON answer and exits with a fixed code.
- `probe.mjs` — scratch-project driver for lifecycle, tool-shape, effect,
  skill, plugin and MCP probes. Every hook entry uses `exec`/`args`, the same
  form Hooknostic generates.
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
  attaches a `preCompact` tee and captures the real payload.
- `mcp-transport-server.mjs` / `mcp-transport-runner.mjs` — a minimal loopback
  Streamable HTTP and legacy SSE MCP server, run as a child process (a
  `spawnSync` driver would block an in-process server's event loop).
- `transport-probe.mjs`, `project-transport-probe.mjs` — plugin and project
  remote MCP probes; record the URL and headers the client sent.
- `linux-capture.sh` — shell-dialect capture inside a disposable Debian
  container.
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
| `postToolUseFailure` context | `{additionalContext}` on exit 0 reached the model. Plain stdout with exit 2 did **not**, contrary to the reference's exit-code table. | `tool.error.context.add` uses the JSON field on exit 0. |
| `permissionRequest` | Fires before the permission service even in `-p` with `--allow-all-tools`. `{behavior:"allow"}` let the call run; `{behavior:"deny",message}` blocked it and the message reached the model. | Observe and block exact. |
| `userPromptSubmitted` output | Exit 2 did not stop the turn; `{additionalContext}` was not delivered. | No block or context cell advertised on `prompt.before`. |
| `preCompact` | Interactive `/compact` produced `{trigger:"manual", transcriptPath, customInstructions:""}`. | `context.compact.before.observe` and the `trigger` field exact; no block or context channel claimed. |
| `sessionStart` context | `{additionalContext}` was injected verbatim; the model quoted the token. | `session.start.context.add` exact. |
| `agentStop` prevent | `{decision:"block",reason}` forced another turn. The harness stopped after eight consecutive blocks; later calls had `stop_hook_active:true`. | `turn.stop.prevent` exact. |
| `subagentStop` prevent | `{decision:"block",reason}` forced more subagent turns. A session-scoped hook blocked more than forty consecutive completions with `stop_hook_active:true`; the documented eight-block guard was not observed. | `agent.stop.prevent` approximate, with the unbounded-loop rationale. |
| User-facing notification on stop | `{decision:"allow",reason}` changed nothing the user sees; no `systemMessage` channel was found. | `*.notify` unsupported. |

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
| Skill text | A loaded skill's context has a `Base directory for this skill: <path>` line, but the body kept `${SKILL_DIR}`, `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` and `$CLAUDE_SESSION_ID` as written. | `${SKILL_DIR}` is rewritten to an explicit model-substituted placeholder; other references are reported as unexpanded. |
| Invocation policy, interactive | `disable-model-invocation: true` withheld a project skill from ordinary listing. `/gated` in `.agents/skills` injected the gated body and the model answered from it; a package skill loaded with `--plugin-dir` did the same as `/hooknostic-interactive-skill-probe:gated`. Neither run made a `skill()` call. The session log recorded `skill.invoked` with `trigger: "user-invoked"` and `disableModelInvocation: true`, and the user message carried `<skill-context name="gated">`. | `agent-plugin.skills.invocation-policy` exact on the captured version: apply native `disable-model-invocation` after authored overlays. Project and package skills both retain explicit slash invocation. |
| Invocation policy, `-p` | A `-p` prompt naming `/gated` is text, not a slash command. The model-facing `skill()` tool excludes the gated skill, so `skill(gated)` returned `Skill not found`; the explicit `disable-model-invocation: false` control (`allowed`) and the ungated `open` control stayed in the available list. | Headless prompt mode has no explicit-invocation path; the policy rationale records it. Interactive use is unaffected. |

An earlier reading treated the `-p` model-facing call as an explicit slash
invocation. The pty probe separates the two: the interactive slash command
injects the skill, while `-p` has no slash path and can only ask the model to
call `skill()`. The probe writes the filtered `evidence.json` beside the screen
under ignored `captured/`; it fails if the session log lacks the injection.

## MCP

| Route | Observation | Consequence |
| --- | --- | --- |
| Project `.mcp.json` stdio | `{type:"stdio", command, args, env, cwd}` starts. `cwd` is honoured; relative `args` resolve from the project root; ambient `${USERPROFILE}` expands in args/env; `${PLUGIN_ROOT}` stays literal. | Project stdio goes through the shared launcher. |
| Project `.github/mcp.json` | The same stdio declaration works when moved to `.github/mcp.json`; the probe connected and called its tool. | Project integration writes the Copilot-scoped file, avoiding a collision with Claude's root `.mcp.json`. |
| Project `.mcp.json` remote | `type:"http"` (Streamable HTTP) and `type:"sse"` both connected to the loopback server. Ambient `${USERPROFILE}` expanded in the URL query; a missing `${HOOKNOSTIC_PROBE_MISSING:-fallback}` used the fallback in both the URL and headers; `${PLUGIN_ROOT}` stayed literal. | Both remote transports exact, with the environment-expansion deviation for a package's text. |
| Agent Plugins `mcp.json` stdio | `command`, `args`, `env`, `cwd` all expand `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`; `${PLUGIN_ROOT}/node-copy.exe` launched. Ambient `${USERPROFILE}` also expanded. The server's cwd was the `PLUGIN_DATA` directory. `PLUGIN_ROOT`/`PLUGIN_DATA` are exported in its environment. | `mcp.stdio` exact, with an ambient-expansion deviation. |
| Agent Plugins `mcp.json` remote | Streamable HTTP and SSE both connected. `${PLUGIN_ROOT}` stayed literal in headers (conforming); `${USERPROFILE}` and `${HOOKNOSTIC_PROBE_MISSING:-fallback}` expanded in the URL query and headers (not conforming). | Both remote components exact, with the deviation. |
| Plugin data | `PLUGIN_DATA` resolved under `$COPILOT_HOME/plugin-data/_direct/<hash>` and persists across sessions. | No launcher or data relocation needed for package delivery. |

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
- A legacy plugin's skill and an Agent Plugins package's skill both loaded.

## Not established

- `notification` (interactive permission prompts, background shells).
- Any host without a native platform package.
- An installed-marketplace (copied) plugin, rather than the live local load.
- Placeholder expansion in a remote MCP **header name**; the transport probes
  covered the URL query and header values.
- `errorOccurred` and `userPromptTransformed` are captured and declined: no
  portable event names a generic error or a pre-model prompt transformation.
