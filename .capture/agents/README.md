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
- Can the same agent run as the session's main (primary) agent instead, and
  what do the session and its hooks see then?

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
6. **Main-session cases.** The `primary-*`, `deny-flag` and OpenCode mode cases
   run the session itself as the agent, and the prompt asks it to read
   `seed.txt`. Every request of such a session carries the instruction nonce, so
   the child backend's script drives it, and the parent lane sees only requests
   that do not carry it. These cases pass no model flag, so the agent's own model
   can show. The `primary-hidden` and `all-listed` cases instead run the default
   agent and look at its delegation tool.

The agent in step 1 is defined like this:

| Harness | File | Tool restriction | Model | Turn cap |
| --- | --- | --- | --- | --- |
| Claude | `.claude/agents/hn-probe.md` | `tools: Read, Grep` | `model: hooknostic-playback-alt` | `maxTurns: 2` |
| Codex | `.codex/agents/hn-probe.toml` | `sandbox_mode = "read-only"` | `model`, and `model_reasoning_effort = "low"` | none (no field) |
| OpenCode v1 | `.opencode/agents/hn-probe.md` | `permission: {edit: deny, bash: deny}` | `mode: subagent`, `model: drift/<alt>` | `steps: 2` (the `maxsteps` case uses `maxSteps: 2`) |
| OpenCode v2 | `.opencode/agents/hn-probe.md` | `permissions` deny rules for `edit` and `shell` (`readonly` case) | `mode: subagent`, `model: playback/<alt>` | `steps: 2` |

The main-session cases drop the turn cap, and on OpenCode set the `mode` under
test. The OpenCode v2 mode agents set no permission rules.

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
  - **On 0.148.0 no hook fired inside the child.** The same `direct` drive, with
    session `-c` overrides and with an isolated `CODEX_HOME`, ran the child's
    shell command, which wrote its file. No `PreToolUse` fired for it, and no
    `SubagentStart` or `SubagentStop`. Both runs relied on
    `--dangerously-bypass-hook-trust`. Whether persisted hook trust changes this
    is not established. On this build, then, no hook is shown to cover what a
    subagent does.
- **OpenCode v1:** `tool.execute.before`/`after` fire in the child session, which
  has a distinct `sessionID`, but carry only `{tool, sessionID, callID}`. The
  child's `chat.message` carries `agent: "hn-probe"`.
- **OpenCode v2:** the child's `execute.before` carries `agent: "hn-probe"`, and
  the parent's carries `agent: "build"`.

### The agent as the main session

Every case below was run on Claude Code 2.1.283 and 2.1.238, OpenCode 1.18.31
and 1.18.18, and OpenCode 2.0.17, with the same result on each build of a family.

| | Claude | OpenCode v1 | OpenCode v2 |
| --- | --- | --- | --- |
| Start the session as the agent | `--agent hn-probe` (`primary-flag`), or `"agent": "hn-probe"` in the project's `.claude/settings.json` (`primary-setting`) | `run --agent hn-probe`, or `default_agent` in `opencode.json` (`default-agent`) | the same |
| Which agents run that way | any agent file: Claude has no mode | `mode: primary` or `all`. With `mode: subagent`, `--agent` printed `agent "hn-probe" is a subagent, not a primary agent. Falling back to default agent`, and the session ran as `build` | any, `mode: subagent` included |
| The session's prompt | the instructions replace the default system prompt, between the one-line SDK preamble and the environment section | the instructions replace the provider prompt | the same |
| Tool restriction | `tools: Read, Grep` was the session's exact tool set | the `permission` denies removed `bash`, `edit` and `write` | not probed |
| Model | the agent's | the agent's | **the configured `model`, not the agent's** |
| Offered to the default agent for delegation | always: see below | `subagent` and `all` in the `task` tool; `primary` not (`all-listed`, `primary-hidden`) | the same, in the `subagent` tool |
| Package route | a `--plugin-dir` plugin's agent ran through `--agent hn-plugin:hn-probe` or the bare `--agent hn-probe`; a plugin whose root `settings.json` sets `agent`, bare or qualified, started every session as it | a `config` hook's `config.agent["hn-probe"]` with `mode: "primary"` ran through `--agent`; a hook that also set `config.default_agent` started the session as it | an agent the transform `update`d with `mode: "primary"` ran through `--agent`; the editor's `default("hn-probe")` started the session as it |
| Identity on the session's own events | `agent_type: "hn-probe"` on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`, with no `agent_id`; a plugin agent reports `hn-plugin:hn-probe` | `chat.message` carries `agent: "hn-probe"`; tool events carry no agent | tool events carry `agent: "hn-probe"` |

- **Claude withholds an agent from delegation only by permission rule.** With
  `permissions.deny: ["Agent(hn-probe)"]` in the project settings (`deny`), the
  parent's request no longer listed the agent, and its scripted `Agent` call was
  refused: "Agent type 'hn-probe' has been denied by permission rule
  'Agent(hn-probe)' from projectSettings." With the same rule, `--agent hn-probe`
  still ran the session as the agent (`deny-flag`).
- **OpenCode v2 ignores the agent's model for a session running as it.** In an
  earlier run of `primary-flag` with no configured `model`, the session did not
  fall back to the agent's model either. It reached OpenCode's hosted default
  provider instead of the loopback server; OpenCode reported a cost of 0, and no
  credential was involved. The drive now always configures `model`, so no case
  leaves the loopback server.
- **The v2 editor's `default`** is `(id) => …default(id === undefined ? undefined : <id>)`.
  It returned nothing, and the next session started as the agent.
- **Codex has no route.** `codex --help` and `codex exec --help`, on 0.156.1 and
  0.148.0, offer `--profile`, which selects a configuration profile, and no option
  that runs a session as an agent. A custom agent is reachable only through
  `spawn_agent`.

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
  Agent Definition 0.1 file, synchronizes it into the scratch project with
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

- **The `scoped` case** (ADR-0028). It synchronizes the definition together with
  hooks scoped to the probe (`scoped-hooks.ts`, plus `scoped-lifecycle-hooks.ts`
  on Claude and Codex), built for the harness build it finds installed.
  - **The hooks.** A guard blocks the probe's first tool call (its read of
    `seed.txt`, or on Codex its shell write) and lets the second through. A guard
    scoped to `hn-nobody` would block anything it ran on. Scoped `tool.after`,
    `agent.start` and `agent.stop` hooks append what they see to a trace.
  - **Where the target can tell,** the guard blocked the probe's call and not
    the parent's delegation, the stray guard never ran, and the trace held only
    the probe's events. This held on Claude 2.1.283 and 2.1.238, Codex 0.156.1
    on both routes, and OpenCode 2.0.17. On Codex the guarded write never
    landed while the allowed one did.
  - **Where it cannot,** the build refused the scope with HN201. That covers
    OpenCode 1.18.31 and 1.18.18, and Codex 0.148.0, where no hook runs inside
    a subagent. The drive then delegates to a native agent instead, and the tee
    confirms the child's tool events still name no agent.

- **The `*-primary` cases** (ADR-0027, decision 9) deliver the same definition
  with `mode: primary`, and start the session as it rather than delegating.
  Codex has none: it has no agent a session runs as.
  - **`generated-primary`** synchronizes it through project delivery. On
    OpenCode v2 the build reports `opencode:primary-agent-model-ignored` for its
    native model, which the drive accepts.
  - **`packaged-primary`** builds it into the package beside `hn-plugin`, and
    names the agent the projection gives it: `hn-plugin:hn-probe` on Claude and
    `hn-plugin-hn-probe` on OpenCode.
  - **`scoped-primary`** synchronizes it with the `scoped` hooks.
  - **Results.** On Claude 2.1.283 and 2.1.238, OpenCode 1.18.31 and 1.18.18,
    and OpenCode 2.0.17, each session ran as the agent on its instructions, and
    its own events named it. Claude and OpenCode v1 ran it on its native model,
    and Claude on its native tool list. OpenCode v2 ran it on the configured
    model, as the degradation says. The scoped guard blocked the session's own
    guarded read on Claude and OpenCode v2, and the stray guard never ran. On
    OpenCode v1 the build refused the scope with HN201.

`packages/cli/test/agent-definition-playback.test.ts` runs the `generated` and
`packaged` cases, and outside Codex the `*-primary` cases, in CI's playback lanes
(`HOOKNOSTIC_PLAYBACK=<harness>`) and in the harness-watch verify lane, so this
evidence is re-established on every change and every new harness build. The
harness-playback suite's `agent-scope` scenario runs the `scoped` case in the
Claude, Codex and OpenCode v1 lanes, and `agent-definition-playback.test.ts` runs
it in the OpenCode v2 lane. Each package route was checked against a mutant that
breaks it: the Claude agents directory moved, the OpenCode v1 agent loop emptied
or its native fields dropped, the v2 transform removed. Each mutant failed the
test. So did a mode written as `subagent` whatever the definition said, in the
OpenCode v1 lane (v1 then refused to run the session as the agent), and a
Claude decoder that read `agent_type` only beside `agent_id`, which failed
`scoped-primary`.

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
  - A session running as an agent is named too: on every Claude event, with no
    `agent_id` (a subagent's events carry one), and on OpenCode v2 tool events.
    Scoping a hook to an agent therefore reaches it as the main agent as well.
- **Main-session use ports to Claude and OpenCode, and not to Codex.** Both
  OpenCode families and Claude ran a session as the agent from a project file
  and from a package, on its instructions. OpenCode's `mode` decides where an
  agent is offered; Claude has no mode, and offers every agent for delegation
  unless a project permission rule withholds it. OpenCode v1 refuses to run a
  `subagent` as the session; v2 and Claude run any agent they are named.
- **A native model does not reach an OpenCode v2 session running as the agent.**
  The configured `model` wins.
- **Making an agent the default is a separate, capturable step:** Claude's
  `agent` setting (a project's, or a plugin's root `settings.json`), OpenCode's
  `default_agent` (in `opencode.json`, or set by a v1 `config` hook), and the v2
  editor's `default(<id>)`.
- **Follow-ups for the existing hook adapters:**
  - The Codex `agent-subagent` playback scenario never calls `wait_agent`.
    0.156.1 dispatches both subagent lifecycle events once the parent waits, so
    its "inconclusive" record deserves a re-run with a wait turn.
  - `multi_agent_v1wait_agent` has no entry in `CODEX_TOOL_KINDS`.
  - Claude dispatches no `SubagentStop` when `maxTurns` ends a subagent.
- **Promoted fixtures.** `promote.mjs` turns reviewed captures into fixtures,
  with the account name redacted:
  - the Claude, Codex and OpenCode v2 in-child tool payloads carrying agent
    identity;
  - the Codex `SubagentStart`/`SubagentStop` payloads, the first captured ones
    beside the schema-derived 0.148 fixtures;
  - the Codex `wait_agent` payload;
  - Claude's `PreToolUse` and `SessionStart` from a session started with
    `--agent`, which name the agent without `agent_id`.

  It reads `claude/direct`, `claude/primary-flag`, `codex-home/direct` and
  `opencode-v2/direct`. The v2
  tee records the `directory` envelope Hooknostic's v2 shim hands its decoder,
  so its rows decode as they are.
