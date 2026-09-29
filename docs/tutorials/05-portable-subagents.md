# Tutorial 5 — One subagent, every harness

**Example:** [`examples/local-project`](../../examples/local-project/) ·
**You'll learn:** writing a portable subagent definition, what each harness makes of
it, and which parts stay harness-specific.

A subagent is an agent the main agent can hand a task to, with its own instructions and
often its own tools and model. Claude Code calls them subagents, Codex calls them custom
agents, and OpenCode calls them agents with `mode: subagent`. Each harness has its own
file format, and OpenCode has two. No standard covers them: Agent Plugins 1.0 leaves
agents out on purpose. So Hooknostic defines a small, provisional
[format](../spec/subagents/0.1.md) and compiles it into each harness's own
([ADR-0027](../decisions/0027-portable-subagents.md), proposed).

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
  say **when** to use the subagent, not just what it is.
- The body is the subagent's instructions.
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
components: { skills: ["./skills"], mcp: "./mcp.json", subagents: ["./agents"] },
```

`sync` writes one owned file per harness:

```text
.claude/agents/reviewer.md       # frontmatter + body, native.claude merged in
.codex/agents/reviewer.toml      # developer_instructions holds the body
.opencode/agents/reviewer.md     # always mode: subagent; native.opencode merged in
```

The OpenCode file serves both families. It always says `mode: subagent`, because
OpenCode v2 otherwise makes a new agent primary and its `subagent` tool cannot select
it. Each directory also gets a generated `.gitattributes`, which keeps the files'
bytes as generated. Like every synchronized file, they are recorded in
`.hooknostic/integration.json`, so `verify` catches a hand edit and `sync` repairs it.

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
hooknostic inspect codex --delivery project --component subagents.native --config hooknostic.config.ts
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
name, description or instructions. Claude and Codex also refuse per-agent hooks and
MCP servers, which belong to their own components.

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

## Shipping subagents in a package

The same directory works beside an Agent Plugins package root:

```ts
components: { root: "./portable", subagents: ["./agents"] },
```

The definitions are not package files. Each projector builds its harness's own
subagent into the package:

| Target | In the package | The main agent sees |
| --- | --- | --- |
| Claude | `agents/reviewer.md` in the plugin | `<plugin>:reviewer`, named by Claude |
| OpenCode v1 | registered by the generated module | `<plugin>-reviewer` |
| OpenCode v2 | registered by the generated module, without `native` fields | `<plugin>-reviewer` |
| Codex | nothing: a Codex plugin cannot bundle agents | — |

OpenCode keeps every agent in one flat namespace, so the projection adds the plugin
name itself, as it does for skills. On a Codex package target the subagent is
unsupported. With the default policy, the build fails. To ship the package to Codex
anyway, set `onUnsupported: "warn"`, and deliver subagents to Codex users through a
project target instead.

## Where the claims come from

Each level in the [support table](../harness-support.md) cites its evidence.
`.capture/agents` drove every harness family against a local playback model and
recorded what reached the child. The recorded fields are its instructions, its tool
declarations and its model. `packages/cli/test/subagent-playback.test.ts` repeats this
in CI for a synchronized definition and a built package, so a harness release that
changes the behavior fails a test.
