# Pi default-role investigation

Question: can the default-agent part of [ADR-0032](../../docs/decisions/0032-portable-agents.md)
be delivered on Pi without depending on a third-party subagent extension?

Twenty-four credential-free probes of the installed reference build on Windows,
2026-10-17 (America/Chicago). The exact harness and Node builds are recorded in
[the curated evidence](evidence/win32.json). The native append-file route is
implemented as an instruction-only project-default prototype (ADR-0032).
Named agents, delegation and agent-scoped hooks remain unsupported.

## Method and provenance

```sh
node --experimental-strip-types .capture/pi-default-agent/drive.mjs
node .capture/pi-default-agent/promote.mjs
```

After `pnpm run bundle`, `node .capture/pi-default-agent/verify-mutations.mjs`
temporarily applies nine controlled defects and requires the focused regressions
to fail, including generated-artifact playback. It restores each source file in
`finally`; ignored reports record each failing assertion count. The defects cover
core pruning, named omissions, lost delegation, falsely supported native fields
and agent scopes, ownership bypass, and a deselected default still being counted.

The driver checks the installed binary against `piHarness.referenceVersion`, or
the explicit `HOOKNOSTIC_PLAYBACK_VERSION` used by a newer-build watch lane.
Each case has a disposable project, agent directory and home, with an empty
repository boundary and scrubbed model credentials. Pi runs offline against a
scripted loopback provider. No real model, paid smoke, user trust entry, external
subagent extension, or user configuration is used.

The explicit provider extension only supplies the local model transport. The
observer records native callback events, the resolved system prompt, and Pi's
thinking-level read API. Sixteen cases exercise native files/settings/flags;
four separately exercise a tiny **project-local** prompt callback, representing
an option available to the Pi extension Hooknostic already generates. Those four
cases use native project extension discovery, including its trust gate.

Effect is established from the actual model request: prompt markers must be in
the high-priority message, the selected model must be the requested model, and
the declared tools must match the control. For this reasoning-enabled loopback
provider, Pi serializes its system prompt as a `developer` message. The driver
accepts the observed `system`/`developer` transport roles and requires exactly one
such message; it does not search arbitrary request strings.

`captured/<platform>/` is ignored and holds full requests, callback snapshots,
arguments, setup options, and process output per case. Four additional cases
synchronize a portable primary definition through core's actual `sync` and
`verify`, including a projected skill in the default case. They prove generated
bytes reach Pi with native and custom system prompts, while CLI append and
untrusted startup suppress the role. Run just these plus the control with
`--generated-only`; their raw output goes to `captured/<platform>-generated/`.
`packages/cli/test/pi-default-agent-playback.test.ts` runs that subset in the Pi
playback lane. The curated JSON is
**live-probe** evidence: marker presence/order, counts and tool lists are derived
observations; `toolEvents` retain the native tool callbacks. Promotion uses the
shared account redactor, changing only the account's path segment to `user`.
These are not new decoder fixtures, and do not evidence named-agent identity.

## Observed native behavior

| Control | Observation |
| --- | --- |
| `.pi/SYSTEM.md` | Replaces Pi's base prompt. Project context files and the skill listing still reach the model afterward. A scripted `read` executes normally. |
| `.pi/APPEND_SYSTEM.md` | Preserves the base prompt and adds the role before project context. A scripted `read` executes normally. |
| Both files | The replacement prompt is followed by the append. |
| Project and global prompt files | Project `SYSTEM.md` replaces the global system file; project `APPEND_SYSTEM.md` shadows the global append. Selection is independent for the two file names. |
| Empty project append | Still shadows the nonempty global append. Copying an empty role is not harmless. |
| Untrusted project | Project prompt files, settings and skill discovery are ignored. Global prompt files remain active; `AGENTS.md` context still reaches the model. |
| Project settings | `defaultModel` and `defaultThinkingLevel` select the role model and thinking level; `defaultTools` changes the model's built-in tool list. |
| Additional extension tool | Remains available despite `defaultTools: ["read", "grep"]`. This setting cannot establish a complete read-only or sandbox posture. |
| CLI overrides | `--system-prompt`, `--append-system-prompt`, `--model`, `--thinking`, and `--tools` override the corresponding file/settings choices. CLI append replaces discovery of file appends, including the project role. |
| Start from a child directory | The root project's prompt files and settings are not applied; ancestor `AGENTS.md` context still is. Root prompt/settings projection needs explicit launch-directory guidance. |
| `.pi/agents/reviewer.md` alone | Does not advertise or activate that named definition in an otherwise native session. |
| Tool callbacks in role sessions | The observed `tool_call` and `tool_result` payloads contain tool/call data and no agent name/type or agent id. |

The trust probes force `--approve` and `--no-approve` in isolated state; they do
not test the interactive trust picker. The loops prove model-request effects,
not whether a real model follows the role instructions. No Linux/macOS, RPC,
resume, reload, package-default, nested-extension discovery, or interaction with
unrelated extensions is claimed.

## Existing-extension alternative

A project-local listener returning
`{ systemPrompt: event.systemPrompt + "\n<role instructions>" }` from
`before_agent_start` was also driven through Pi's actual discovery mechanism.
It preserves the already-resolved native/custom system prompt and global append.
The model sees the appended role. In an untrusted project the listener does not
load and the role marker is absent.

It also appends **after a CLI prompt override**. This route therefore needs an
explicit decision about how a user disables/overrides the default role. It does
not inherit the native-file route's CLI precedence automatically. Interactions
and ordering with other prompt-transforming extensions remain uncaptured.

This would extend Hooknostic's existing generated Pi extension; it would not
require supporting an external subagent plugin. It does not supply delegation,
a named primary-agent registry, or observed agent identity.

## Chosen prototype and deferred alternatives

1. **Native project default, instruction-first.** Write the selected definition's
   instructions to an owned `.pi/APPEND_SYSTEM.md`. Preserve `.pi/SYSTEM.md` and
   Pi's base prompt. Refuse an existing unowned/modified append using normal sync
   ownership. Explain that this overrides a user's global append, is bypassed by
   CLI append, and applies when Pi starts at the project root with trust. Do not
   copy personal global instructions into a repository artifact. This is a
   implemented `agents.default: emulated` route; named agents stay unsupported.
2. **Role through the existing generated extension.** Append to the resolved
   prompt and preserve global appends. Resolve override semantics and extension
   composition before adopting it. Keep native model/thinking settings separate.
3. **External subagent integration.** Defer. It adds a separately versioned
   discovery, execution, lifecycle and identity contract that this investigation
   does not establish. Generating a new delegation runtime would add orchestration
   responsibilities beyond the [compiler boundary](../../CONTRIBUTING.md).

The prototype uses option 1 and leaves native fields unsupported. A narrow
allowlist of startup model and thinking settings could be considered separately.
Never hoist arbitrary `native.pi` keys into project
settings: packages, extensions, trust, shell behavior and unrelated preferences
would change the whole project. Do not imply `defaultTools` is a security boundary.

### Generic core rule

The previous project build counted `agents.definition` first and removed all loaded
definitions when that component is unsupported. Merely changing Pi's
`agents.default` rating would therefore discard the selected definition before
the projector could use its instructions.

The prototype distinguishes **delivering the selected definition as the
project's fixed role** and **offering named definitions for invocation/delegation**.
Core resolves the default first, independently of named definition support. A
primary-only default counts only under `agents.default` where no named route
exists. Every other selected definition is a named omission. An `all` default
still reports unsupported `agents.definition` for its missing delegation, while
retaining its fixed role. No Pi conditional or general `agents.definition`
support bypass is involved.

Either route should leave named primary-agent selection, delegation, agent-scoped
hooks, and package-level defaults unsupported. Model text containing a role name
does not justify synthesizing `correlation.agentType`: the native tool events
still do not identify the role, and CLI/extension overrides can change the prompt.

The proposed ADR and tutorial record the chosen semantics. Regression tests cover
the generic route under two adapter ids, named omissions, missing delegation,
native-field refusal, deselection, changed definitions and ownership collisions.
Windows generated-artifact playback is captured; other platforms and startup
modes remain unprobed.

## Opt-in local LLM smoke

```sh
pnpm run bundle
node --experimental-strip-types .capture/pi-default-agent/local-smoke.mjs --run
node .capture/pi-default-agent/promote-local-smoke.mjs
```

This separate driver performs real inference with the already-installed
`qwen3.8:27b-128k` weights through local Ollama. It refuses cloud-backed entries
and forwards only that model to `127.0.0.1`, through a passive HTTP recorder.
It uses fresh project/home/agent directories, no ambient provider credentials,
no session persistence, a passive observer, and only the native `read` tool.
The model's output budget is 2048 tokens per request with thinking off.

Both sessions receive the same user request to read `probe.txt` and report its
contents. The file contains a random token. A portable primary definition is
excluded from the control target and selected as the default in the positive
target; both go through real core sync and verify. Only the definition's
instructions contain a second random role marker and the required JSON format.
The positive response must reproduce both markers in that format, and the
control must fail that same role condition. Native callbacks must show exactly
one successful read per session, and its result must reach the next model
request. Responses are generated by Qwen, with no scripted completions or calls.

Ignored `captured/local-smoke/<timestamp>/` keeps HTTP streams, requests, native
events, arguments, process results and reconciliation outcomes. The separate
promoter keeps all completed attempts, including failed ones, in a redacted
bounded summary at `evidence/local-smoke-<platform>.json`.
This is live-probe evidence of the tested role and read behavior, not a general
guarantee of model obedience, tool restrictions, delegation or agent identity.

### Windows Qwen result, 2026-10-17

[The evidence](evidence/local-smoke-win32.json) records Pi's reference build,
Ollama version, local weight digest and quantization, both exact user prompts,
generated instructions, random markers, final responses, native tool callbacks,
request counts, HTTP statuses, and assertions. The model was the requested local
`qwen3.8:27b-128k`, not the cloud-backed entry in the local inventory.

| Attempt | User request | Control | Default enabled | Overall |
| --- | --- | --- | --- | --- |
| Initial | Read the file and report its contents | One successful read, actual file token, no role marker | Returned the correct role marker but invented a file value without calling `read` | Failed |
| Explicit tool request | Use `read` exactly once; report actual contents without guessing | One successful read, actual file token, no role marker | One successful read; exact JSON with the correct role marker and actual file token | Passed |

The passing attempt made four real local model requests (two per session), all
HTTP 200. In the enabled session both requests carried the generated role at
developer level, and the second received the native read result. Neither user
prompt contained the role marker or file value. Core sync and verify passed in
both sessions; no `--agent`, CLI prompt injection, or prompt-mutating observer
supplied the role.

The initial failure is retained rather than treated as a transport failure: the
correct role marker shows that the role reached the model, while the invented
file value shows a model-compliance limit. The explicit-request success proves
the requested role/read path works in this run; it does not establish reliable
implicit tool use or general adherence. No production adapter behavior or
support level was changed to obtain the result. Delegation and agent-scoped hooks
remain unsupported.

## Upstream references

Documentation/source pointers are weaker provenance than the local probes:

- [Reference-build system prompts and CLI](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/README.md#system-prompt)
- [Reference-build settings](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/settings.md)
- [Upstream subagent extension example](https://github.com/earendil-works/pi/tree/v0.84.4/packages/coding-agent/examples/extensions/subagent)
