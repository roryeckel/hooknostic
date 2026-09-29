# Tutorial 5 — One agent, every harness

**Example:** [`examples/local-project`](../../examples/local-project/) ·
**You'll learn:** writing a portable agent definition, what each harness makes of it
as a subagent or as the agent a session runs as, and which parts stay
harness-specific.

A harness runs a defined agent in one of two ways. As a **subagent**, the main agent
hands it a task, and it works with its own instructions and often its own tools and
model. Claude Code calls these subagents, Codex calls them custom agents, and OpenCode
calls them agents with `mode: subagent`. As a **primary** agent, a session itself runs
as the agent: Claude Code does this with `claude --agent <name>`, and OpenCode with
agents in `mode: primary`. Codex has no primary agents. Each harness has its own file
format, and OpenCode has two. No standard covers them: Agent Plugins 1.0 leaves agents
out on purpose. So Hooknostic defines a small, provisional
[format](../spec/agents/0.1.md) and compiles it into each harness's own
([ADR-0027](../decisions/0027-portable-agents.md), proposed).

## The definition

[`agents/reviewer.md`](../../examples/local-project/agents/reviewer.md) is the whole
source:

```markdown
---
name: reviewer
description: Reviews a change for correctness and missing tests. Use after editing code, before reporting the work as done.
native:
  claude:
    tools: [Read, Grep, Glob]
  opencode:
    permission:
      edit: deny
      bash: deny
---
You review the change you are given. You do not edit files.
...
```

- `name` follows the Agent Skills name rules and must match the file name.
- `description` is what the main agent reads when it decides whether to delegate, so
  say **when** to use the agent, not just what it is.
- The body is the agent's instructions.
- `mode` is absent, so the reviewer is a subagent. [Below](#an-agent-a-session-runs-as)
  are the other modes.
- `native` holds fields only one harness understands. Each block reaches only its own
  harness, verbatim.

The format has no other keys. It does not accept `tools`, `model` or `maxTurns` at
the top level, although every harness has something like them. The captures behind
ADR-0027 show that they behave differently on each harness. A model id only means
something to one provider. A turn cap stops a Claude child partway and lets it resume,
stops an OpenCode v2 child hard, and is ignored by OpenCode v1. Codex has no per-agent
tool list at all. A portable field that behaves differently everywhere would promise
something it cannot keep, so these stay in `native` until they converge.

## Configure and sync

[`hooknostic.config.ts`](../../examples/local-project/hooknostic.config.ts) adds one
line beside the example's skills and MCP server:

```ts
components: { skills: ["./skills"], mcp: "./mcp.json", agents: ["./agents"] },
```

`sync` writes one owned file per harness:

```text
.claude/agents/reviewer.md       # frontmatter + body, native.claude merged in
.codex/agents/reviewer.toml      # developer_instructions holds the body
.opencode/agents/reviewer.md     # the agent's mode; native.opencode merged in
```

The OpenCode file serves both families. It always states the definition's mode,
`subagent` here, because OpenCode v2 otherwise makes a new agent primary and its
`subagent` tool cannot select it. Each directory also gets a generated
`.gitattributes`, which keeps the files' bytes as generated. Like every synchronized
file, they are recorded in `.hooknostic/integration.json`, so `verify` catches a hand
edit and `sync` repairs it.

## What each harness does with it

Every harness offers the subagent to the main agent with its description. The child
receives the instructions. The main agent then gets the result. After that, they
differ:

| | Claude Code | Codex | OpenCode v1 (this example) |
| --- | --- | --- | --- |
| Main agent is told | in a system reminder | in `spawn_agent`'s `agent_type` description | in the `task` tool's description |
| Instructions | Replace the base prompt | Follow Codex's base instructions | Replace the base prompt |
| This example's `native` | Tools limited to `Read, Grep, Glob` | — | Edit and shell tools removed |

Write instructions that stand alone. On Claude and OpenCode, they take the base
prompt's place. On Codex, Codex's own instructions come first. Codex's guidance also
tells its model not to spawn a subagent unless it is asked to, so expect to request
the reviewer by name there.

The example's `native` blocks make the reviewer read-only on Claude and OpenCode. Codex
has no equivalent per-agent setting. An agent file's `sandbox_mode` was captured having
no effect on the child, so on Codex the reviewer keeps the session's tools and
sandbox. Its instructions say not to edit, but that is a request, not an enforced
limit.

`inspect` shows the recorded evidence for any target:

```sh
hooknostic inspect codex --delivery project --component agents.native --config hooknostic.config.ts
```

A few `native` details are worth knowing:

- **Codex parses agent files strictly.** A single key it does not know makes it ignore
  the whole file, with only a warning. Keep `native.codex` to documented keys.
- **A Codex model needs an effort.** A child inherits the parent's reasoning effort,
  which a different model can refuse. When `native.codex` sets `model`, also set
  `model_reasoning_effort`. `sync` reminds you if you don't.

- **`native.opencode` serves both OpenCode families**, whose agent fields differ: this
  example's `permission` map is v1's spelling, and v2 uses `permissions` rules. Keep
  one family per configuration when `native.opencode` sets permissions.

Each harness refuses (HN503) a `native` key that would override the portable core: its
name, description or instructions, and on OpenCode its mode. Claude and Codex also
refuse per-agent hooks and MCP servers, which belong to their own components.

## An agent a session runs as

`mode` says where an agent is offered. The default, `subagent`, offers it to the main
agent for delegation. `primary` offers it to you, as the agent a session runs as, and
not for delegation. `all` does both:

```markdown
---
name: planner
description: Plans a change before any code is written. Use at the start of a task.
mode: primary
---
You plan changes. You list the files to touch and the tests to add, and you do not
edit anything.
```

After `sync`, start a session as the planner:

| | Start a session as the agent | A `primary` agent is offered for delegation |
| --- | --- | --- |
| Claude Code | `claude --agent planner`, or `"agent": "planner"` in your settings | yes, see below |
| OpenCode v1 and v2 | `opencode run --agent planner`, or `default_agent` in `opencode.json` | no |
| Codex | not possible | — |

The session runs on the agent's instructions, in place of the harness's own prompt.
A few differences are worth knowing:

- **Claude has no mode.** It offers every agent it knows for delegation, a `primary`
  one included. The build reports that as a warning, the deviation
  `claude:primary-agent-delegable` (HN106). To withhold the agent, add
  `"Agent(planner)"` to `permissions.deny` in your own `.claude/settings.json`;
  `claude --agent planner` still works.
- **OpenCode enforces the mode.** A `primary` agent is absent from the delegation tool.
  OpenCode v1 refuses to run a `subagent` as a session and falls back to its default
  agent; v2 runs any agent it is named.
- **OpenCode v2 ignores a native model there.** A session started as the agent runs on
  the `model` your OpenCode configuration selects, not on `native.opencode.model`,
  which applies only when the agent runs as a subagent. The build reports such a
  definition as the degradation `opencode:primary-agent-model-ignored` (HN101), which
  fails it unless you accept that id in `components.accept`.
- **Codex cannot do it.** A `primary` agent is not written for Codex, and an `all` agent
  is written as a custom agent only. Both are reported as unsupported (HN205), which
  fails the build unless `onUnsupported: "warn"`.

Hooknostic makes a primary agent available; it does not make it the agent every
session starts as. That stays your setting.

## Guarding the subagent with a hook

A hook can run only inside named agents ([ADR-0028](../decisions/0028-agent-scoped-hooks.md),
proposed). This is how the reviewer becomes read-only on Codex, where no agent setting
does it:

```ts
hook("tool.before", {
  id: "reviewer-read-only",
  agents: { include: ["reviewer"] },
  match: { kind: ["shell", "file.write", "file.edit"] },
  capabilities: { block: "required" },
  run: () => block("the reviewer does not change files"),
});
```

The hook runs for the reviewer's tool calls and never for the main agent's. The harness
has to say which agent a tool call belongs to, and not every one does:

| Target | Can scope tool hooks to an agent |
| --- | --- |
| Claude Code | yes |
| Codex 0.156.1 and later | yes; target a range such as `>=0.156.1 <1` |
| Codex before 0.156.1 | no: no hook was seen to run inside a subagent at all |
| OpenCode v2 | yes |
| OpenCode v1 | no: its tool events do not name the agent |

Where it cannot, the build fails with HN201 instead of shipping a guard that never
runs. The name to list is the one the harness reports: `reviewer` for a project
agent, the qualified name for one a package delivered (`<plugin>:reviewer` on Claude,
`<plugin>-reviewer` on OpenCode). Inside the handler, `event.correlation.agentType`
holds it.

A session running as a primary agent is named the same way on Claude and OpenCode v2,
so `agents: { include: ["planner"] }` scopes a hook to planner sessions there.

## Shipping agents in a package

The same directory works beside an Agent Plugins package root:

```ts
components: { root: "./portable", agents: ["./agents"] },
```

The definitions are not package files. Each projector builds its harness's own
agent into the package:

| Target | In the package | The main agent sees | Start a session as it |
| --- | --- | --- | --- |
| Claude | `agents/reviewer.md` in the plugin | `<plugin>:reviewer`, named by Claude | `claude --agent <plugin>:reviewer` |
| OpenCode v1 | registered by the generated module | `<plugin>-reviewer` | `opencode run --agent <plugin>-reviewer` |
| OpenCode v2 | registered by the generated module, without `native` fields | `<plugin>-reviewer` | `opencode run --agent <plugin>-reviewer` |
| Codex | nothing: a Codex plugin cannot bundle agents | — | — |

OpenCode keeps every agent in one flat namespace, so the projection adds the plugin
name itself, as it does for skills. On a Codex package target the agents are
unsupported. With the default policy, the build fails. To ship the package to Codex
anyway, set `onUnsupported: "warn"`, and deliver subagents to Codex users through a
project target instead.

## Where the claims come from

Each level in the [support table](../harness-support.md) cites its evidence.
`.capture/agents` drove every harness family against a local playback model and
recorded what reached the child, or the session run as the agent. The recorded fields
are its instructions, its tool declarations and its model.
`packages/cli/test/agent-definition-playback.test.ts` repeats this in CI for a
synchronized definition and a built package, so a harness release that changes the
behavior fails a test.
