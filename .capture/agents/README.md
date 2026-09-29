# Custom agent (subagent) definitions

Evidence class: **live-probe** over a constructed transport. The harness binaries
are real, and the model is the loopback playback server. Hook payloads in the tee
output are **captured**; the model's replies and every argument value are scripted.
Tested on Windows on 2026-09-29 with Claude Code **2.1.283**, Codex CLI **0.156.1**,
OpenCode **1.18.31** (`opencode-ai`, the v1 family) and OpenCode **2.0.17**
(`@opencode/cli`, the v2 family). No model credits were spent, and no user
configuration was edited.

## Question

Hooknostic may gain a portable custom-agent component (the owner's spike for
ADR-0027). Before anything claims a support level, each harness has to answer
these questions about a native agent file:

- Where does the harness discover it, and is it advertised to the parent?
- How does the parent select it?
- Do the agent's instructions reach the child? Do they replace the harness's
  base prompt, or add to it?
- Are the agent's tool restriction, model and turn cap honoured?
- Can a plugin or package deliver the agent?
- What do hooks see inside the child?

## Provenance boundary

The playback transport is constructed, as in
[`../harness-playback/README.md`](../harness-playback/README.md). What the
harness sent to the model is observed live. That covers the delegation tool's
live schema, the child's system/developer text, its tool declarations and its
`model` field. The agent files are hand-written in each harness's native format,
except in the `generated` and `packaged` cases, which deliver a portable
definition through Hooknostic's own build
([below](#reference-builds-generated-definitions-and-packages)).

Every claim below comes from one run of a drive. A different build is a new
question.

## Method

```sh
node --experimental-strip-types .capture/agents/drive.mjs claude
node --experimental-strip-types .capture/agents/drive.mjs codex
node --experimental-strip-types .capture/agents/drive.mjs codex-home
# OpenCode v1 is not the globally installed opencode; put a 1.18 build first on PATH:
npm install --prefix <scratch>/opencode-v1 opencode-ai@1.18.31
PATH=<scratch>/opencode-v1/node_modules/.bin:$PATH HOOKNOSTIC_PLAYBACK_VERSION=1.18.31 \
  node --experimental-strip-types .capture/agents/drive.mjs opencode-v1
node --experimental-strip-types .capture/agents/drive.mjs opencode-v2
```

Each case runs one session in a fresh scratch project, with the committed tee
templates attached (`.capture/claude`, `.capture/codex-capture`,
`.capture/opencode-capture`, plus a v2 tee written by the drive).

1. **Seed the agent.** The scratch project gets an agent named `hn-probe` with
   three per-run nonces:
   - `HKN-DESC-*` in its description only, which proves the parent was told
     about it;
   - `HKN-SUBAGENT-*` in its instructions only, which proves they reached the
     child;
   - `HKN-CHILD-TASK-*` in the delegated task only, which identifies the
     child's first user message.
2. **Script the parent.** It delegates by name through the harness's own tool.
   The task's argument keys come from the live schemas.
3. **Route by nonce.** A routing proxy sits in front of two playback backends.
   A request carrying the instruction nonce at system/developer level, or the
   task nonce in a user message, goes to the child backend. Parent and child
   therefore keep separate scripts. The Codex drive completes its scripted
   `wait_agent` call with the `agent_id` that `spawn_agent` returned.
4. **Script the child.** It reads `seed.txt` three times, then answers. On Codex
   it makes one shell call that writes a file, then answers.
5. **Run controls.** A negative control puts the same file under
   `<native dir>-off/`. The `neutral` and `cross` cases put it only under
   `.agents/agents/` or `.claude/agents/`.

The agent in step 1 is defined like this:

| Harness | File | Tool restriction | Model | Turn cap |
| --- | --- | --- | --- | --- |
| Claude | `.claude/agents/hn-probe.md` | `tools: Read, Grep` | `model: hooknostic-playback-alt` | `maxTurns: 2` |
| Codex | `.codex/agents/hn-probe.toml` | `sandbox_mode = "read-only"` | `model`, and `model_reasoning_effort = "low"` | none (no field) |
| OpenCode v1 | `.opencode/agents/hn-probe.md` | `permission: {edit: deny, bash: deny}` | `mode: subagent`, `model: drift/<alt>` | `steps: 2` (the `maxsteps` case uses `maxSteps: 2`) |
| OpenCode v2 | `.opencode/agents/hn-probe.md` | `permissions` deny rules for `edit` and `shell` (`readonly` case) | `mode: subagent`, `model: playback/<alt>` | `steps: 2` |

`captured/<harness>/<case>/` is gitignored. Each case writes:

- `summary.json`: the observations;
- `requests.json`: every model request, with its lane;
- `drive.json`: the exit code and output tail;
- `tee/`: the hook payloads.

## Observations

### Discovery and selection

| | Claude 2.1.283 | Codex 0.156.1 | OpenCode 1.18.31 | OpenCode 2.0.17 |
| --- | --- | --- | --- | --- |
| Project file discovered | `.claude/agents/` | `.codex/agents/` | `.opencode/agents/` and `.opencode/agent/` | `.opencode/agents/` |
| Where the parent sees it | A system-reminder line: `- hn-probe: <description> (Tools: Read, Grep)` | The `spawn_agent` `agent_type` description lists it under "Available roles", with "This role's model is set to `…` and cannot be changed" | The `task` tool's description | The `subagent` tool's description |
| Selection call | `Agent {subagent_type}` | `spawn_agent {agent_type, message}`; then `wait_agent {targets: [agent_id]}` | `task {subagent_type}` | `subagent {agent}` |
| Negative control `<dir>-off/` | not discovered | not discovered | not discovered | not discovered |
| `.agents/agents/` | not read | not read (`.toml` or `.md`) | not read | not read |
| `.claude/agents/` | — | not read | not read | not read |

Notes:

- **Codex adds `agent_type` only when a custom agent exists.** With no custom
  agent, `multi_agent_v1.spawn_agent` declares no `agent_type` at all
  (`fork_context, items, message, model, reasoning_effort`), so the built-in
  roles cannot be selected. That explains the key's absence from the
  `.capture/file-tools` discovery.
- **Codex's spawn result** is `{"agent_id": "…", "nickname": "…"}`.
- **Codex's guidance tells the model not to spawn** unless the user or
  AGENTS.md/skill instructions ask for it.

### Instructions, tools, model, turn cap

| | Claude | Codex | OpenCode v1 | OpenCode v2 |
| --- | --- | --- | --- | --- |
| Instructions reach the child | yes | yes | yes | yes |
| Base prompt | **replaced**: a one-line SDK preamble, then the instructions, then Claude's short subagent notes. The parent's 5,819-char interactive prompt is absent; the child's system is 1,567 chars | **layered**: `instructions` keep the model's base instructions; the agent's text follows as a developer message | **replaced**: the instructions come first, then the model line, environment and skills | **replaced**: same shape as v1 |
| Tool restriction | child declares exactly `Read, Grep` | no per-agent tool list; the child declares the full set. `sandbox_mode` is not honoured (below) | child declares `glob, grep, read, skill, webfetch` (no `edit`, `write`, `bash`) | child declares `glob, grep, question, read, skill, subagent, webfetch, websearch, execute` (no `edit`, `write`, `shell`) |
| Model override | child `model` = the override | the override | the override | the override |
| Turn cap | 2 child requests. The parent is told "this agent stopped at its 2-turn limit before finishing … Send the agent a message (SendMessage) to let it continue". **No `SubagentStop`** | no field | **not enforced**: `steps: 2` and `maxSteps: 2` each let the child run 4 tool-bearing turns | 2 child requests; the parent gets "Subagent completed without a text response." |
| Child result returned to parent | yes (uncapped `complete` case) | yes, via `wait_agent` | yes | yes (uncapped `inject` case) |

### Codex-specific findings

- **`sandbox_mode` in an agent file does not change the child's policy.** The
  child's prompt states its effective `sandbox_mode`, and it was the session's
  in every run:

  | Session policy | Agent `sandbox_mode` | Child reports | Scripted write |
  | --- | --- | --- | --- |
  | `danger-full-access` | `read-only` | `danger-full-access` | landed |
  | `workspace-write` | `read-only` | `workspace-write` | — |
  | `workspace-write` | `danger-full-access` | `workspace-write` | — |

  "—" means enforcement under `workspace-write` is not established. The child's
  shell call did not finish within the 60 s wait, because Codex refused to
  create its sandbox helper binaries under a temporary `CODEX_HOME`.
- **An unrecognised field rejects the whole file.** The only sign is a warning:
  "Ignoring malformed agent role definition: failed to deserialize agent role
  file …: unknown field `hooknostic_unknown_key`". The agent is then absent.
- **The child inherits the parent's reasoning effort.** With the user config at
  `xhigh`, `spawn_agent` failed: "Reasoning effort `xhigh` is not supported for
  model `hooknostic-playback-alt`". Setting `model_reasoning_effort = "low"` in
  the agent file fixed the spawn.
- **Trust gating is not demonstrated.** With no project trust entry in an
  isolated `CODEX_HOME`, `codex exec --dangerously-bypass-hook-trust` still
  discovered the project agent. This result is inconclusive.

### Package and plugin routes

- **Claude:** `--plugin-dir` with `agents/hn-probe.md` lists the agent as
  `hn-plugin:hn-probe`. Delegating by the qualified name delivered the
  instructions, tool list and model.
  - **A plugin agent ignores `permissionMode`.** The `plan-*` cases give the
    agent no tool list and `permissionMode: plan`, and run the parent without
    `--dangerously-skip-permissions`, since a bypassing parent overrides a
    subagent's mode. As a project agent, the child's tools included
    `ExitPlanMode`. As a plugin agent, with the same file, they did not.
- **OpenCode v1:** a plugin whose `config` hook assigns
  `config.agent["hn-probe"]` produced a discovered, delegable agent with its
  instructions and model.
- **OpenCode v2:**
  - `ctx.agent` exposes `get, list, reload, transform`.
  - The transform editor exposes `default, get, list, remove, update`. There is
    no `add`.
  - `update("hn-probe", (agent) => Object.assign(agent, definition))` on an
    unknown id **upserts**: the agent is listed, discovered and delegated with
    its instructions.
  - Built-in ids: `build, general, explore, compaction, title, summary, plan`.
- **Codex:** not probed. Upstream openai/codex#18988 (open) says plugins cannot
  bundle agents.

### Hooks inside the child

- **Claude:** the child's `PreToolUse`/`PostToolUse` carry `agent_id` and
  `agent_type: "hn-probe"`, and the parent's own events carry neither.
  `SubagentStart` carries both. `SubagentStop` carries both plus
  `last_assistant_message`, but only when the child finished normally.
- **Codex:**
  - The child's `Bash` `PreToolUse`/`PostToolUse` carry `agent_id` and
    `agent_type: "hn-probe"`.
  - `SubagentStart` and `SubagentStop` fired and reached the tee in both the
    `-c`-override run and the isolated-home run, with the parent waiting on the
    child. openai/codex#33097's lost hook-trust bypass (observed on 0.151.0) did
    not reproduce here.
  - The parent's wait call reaches hooks as `tool_name: "multi_agent_v1wait_agent"`,
    while `spawn_agent` is unprefixed.
- **OpenCode v1:** `tool.execute.before`/`after` fire in the child session, which
  has a distinct `sessionID`, but carry only `{tool, sessionID, callID}`. The
  child's `chat.message` carries `agent: "hn-probe"`.
- **OpenCode v2:** the child's `execute.before` carries `agent: "hn-probe"`, and
  the parent's carries `agent: "build"`.

### Reference builds, generated definitions and packages

The drive was re-run at each adapter's reference build, the version CI's
playback lanes install: Claude Code **2.1.238**, Codex CLI **0.148.0**, OpenCode
**1.18.18** and **2.0.17**. Set `HKN_CAPTURE_LABEL` to keep such runs apart in
`captured/`.

- **Reference builds behave the same.** Claude's project and plugin agents, and
  OpenCode's project and `config`-injected agents, behaved as on the newer
  builds. On 0.148.0, Codex's `spawn_agent` also gained `agent_type` (beside a
  `service_tier` key) once a project agent existed.
- **The `generated` case.** It writes the same agent as a portable Hooknostic
  Subagent Definition 0.1 file, synchronizes it into the scratch project with
  Hooknostic's own project delivery, and then drives the harness exactly as
  `direct` does. On every family and build above, the synchronized definition
  was advertised to the parent, delegated to, and ran on its instructions and
  native model; on Claude it also ran on its native tool list, and its result
  came back.
- **The `packaged` case** (Claude and both OpenCode families; Codex has no
  package route). It configures the same definition beside a minimal Agent
  Plugins package, `hn-plugin`, builds that for package delivery outside the
  project, and loads the built package: Claude through `--plugin-dir`, OpenCode
  by naming its directory in `opencode.json` (`plugin` on v1, `plugins` on v2).
  On every build above, the parent was offered the agent under the name the
  projection gives it, `hn-plugin:hn-probe` on Claude and `hn-plugin-hn-probe`
  on OpenCode; delegated to, it ran on its instructions and its result came
  back. On Claude and OpenCode v1 it also ran on its native model (and on
  Claude its native tool list). OpenCode v2's package route carries no native
  fields, so there it ran on the parent's model, and the definition is written
  without them.
- **OpenCode v2 needs `mode: subagent`, on both routes.** A mutant emitting the
  v2 file without it failed: v2's `subagent` tool could not select the agent,
  which confirms the documented `primary` default. A mutant registering the
  packaged agent through the agent transform without it failed the same way.

`packages/cli/test/subagent-playback.test.ts` runs the `generated` and `packaged`
cases in CI's playback lanes (`HOOKNOSTIC_PLAYBACK=<harness>`) and in the
harness-watch verify lane, so this evidence is re-established on every change
and every new harness build. Each package route was checked against a mutant
that breaks it: the Claude agents directory moved, the OpenCode v1 agent loop
emptied or its native fields dropped, the v2 transform removed. Each mutant
failed the test.

## Consequences

- **The core ports everywhere.** Every family delivered a named, described
  agent whose instructions reach the child, from a native project file. The
  design review's kill criterion (fewer than two harnesses can deliver the
  core) does not trigger.
- **A package can deliver the core on Claude, OpenCode v1 and OpenCode v2.**
  Codex has no package route.
- **The instructions contract must allow both placements.** Claude and OpenCode
  replace the base prompt; Codex layers on top of it. Text that assumes a
  harness's default guidance is present is harness-specific.
- **A model override is honoured by all four** as native text. A Codex model
  can invalidate an inherited reasoning effort, so a Codex translation that
  sets `model` should also set `model_reasoning_effort`.
- **A turn cap is not portable:**
  - Claude stops the child partway, and it can be resumed.
  - OpenCode v1 ignores the cap.
  - OpenCode v2 stops the child hard.
  - Codex has no field.
- **The read-only posture differs by harness:**
  - Claude: exact, through a tool allow-list with no shell and no `Agent`.
  - OpenCode v1: `edit`/`bash` deny removes the tools from the child's
    declarations.
  - OpenCode v2: the same, except `subagent` and `execute` remain. A read-only
    agent can still delegate to an agent with its own permissions, so they must
    be denied too.
  - Codex: agent-level `sandbox_mode` is not honoured, so there is no native
    route. Every child tool event carries `agent_type`, so an agent-scoped
    `tool.before` hook could emulate it.
- **Codex parses strictly.** Native passthrough must never emit an unknown key:
  one unknown key silently removes the whole agent.
- **Agent identity per event:**
  - Available on Claude, Codex 0.156.1 and OpenCode v2 tool events, which makes
    agent-scoped hooks feasible there without cross-invocation state (ADR-0002).
  - OpenCode v1 exposes it only on `chat.message`.
- **Follow-ups for the existing hook adapters:**
  - The Codex `agent-subagent` playback scenario never calls `wait_agent`.
    0.156.1 dispatches both subagent lifecycle events once the parent waits, so
    its "inconclusive" record deserves a re-run with a wait turn.
  - `multi_agent_v1wait_agent` has no entry in `CODEX_TOOL_KINDS`.
  - Claude dispatches no `SubagentStop` when `maxTurns` ends a subagent.
- **Candidates for fixture promotion** (not done in this spike):
  - the Claude, Codex and OpenCode v2 in-child tool payloads carrying agent
    identity;
  - the Codex `SubagentStart`/`SubagentStop` payloads, which would upgrade
    today's schema-derived Codex subagent fixtures to captured.
