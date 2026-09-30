# ADR-0028: Portable agent definitions are a Hooknostic component

**Status:** Proposed — 2026-09-29. It needs owner review before acceptance, and the
open questions below must be settled first. The decisions are implemented on the
branch that proposes them, so they can be reviewed as working code; the branch
merges only once this is accepted.

**In short:** Hooknostic should compile one portable definition of an agent into
each harness's native form:

- a Claude Code subagent, which Claude can also run as a session's own agent;
- a Codex custom agent;
- an OpenCode agent, in the `mode` the definition declares.

It would be a third component kind beside skills and MCP, in a format Hooknostic
owns ([Hooknostic Agent Definition 0.1](../spec/agents/0.1.md)). The format
stays provisional until a real standard exists, and it is built to be replaced by
one. A definition is a subagent by default. With `mode: primary` or `all` it is
also, or only, an agent a session runs as, which Claude and OpenCode support and
Codex does not. The capture spike (`.capture/agents`) found that the core — name,
description and instructions — reaches the child on all four harness families,
and reaches a session run as the agent on Claude and both OpenCode families. Tool
restrictions, turn caps and sandboxing do not port, so 0.1 leaves them out. A
project can also name one definition its default agent, which every session
starts as; Codex emulates that one through its project configuration.

## Context

Every targeted harness now lets a project define its own agents. The formats
differ: Markdown with YAML frontmatter for Claude and OpenCode, TOML for Codex, and
two incompatible OpenCode schemas (v1 and v2). An author who wants one reviewer
agent on three harnesses maintains four files. Existing converters translate
these files but claim nothing about what each harness actually honours. That
claim is Hooknostic's product (CONTRIBUTING.md, "What Hooknostic is").

Agent Plugins 1.0, the peer standard Hooknostic projects (ADR-0011), leaves
agents out deliberately: "commands, hooks, agents, rules, and LSP servers —
remain too client-specific for a stable portable contract and are outside the v1
format until their formats converge." This is the same gap Hooknostic already
fills for hooks. `docs/design.md` §20 already lists a formal Agent Plugins
proposal as deferred work.

A harness uses such an agent in one of two ways:

- **As a subagent.** The session's agent hands it a task, and it runs in a child
  session. All three harnesses do this.
- **As the session's own agent.** A user starts a session as the agent, or
  switches to it. Claude Code runs any agent file this way (`--agent`, or the
  `agent` setting). OpenCode calls these primary agents and decides per agent,
  through `mode`. Codex has no such route.

The machinery exists:

- **Kind-neutral output.** Generated artifacts, project files and keyed
  JSONC/TOML entries, the ownership manifest, and journalled reconciliation
  (ADR-0015).
- **Honest reporting.** Versioned component support profiles with
  `validatedOn` evidence, plus the shortfall classes ADR-0019 and ADR-0022
  define.
- **Two delivery routes.** Package projection (ADR-0011) and project delivery
  (ADR-0015).
- **Hooks already know about agents.** They carry `agent.start`/`agent.stop`
  and `correlation.agentId`.

What is closed to new kinds is the input and counting side:

- the `AGENT_PLUGIN_COMPONENT_IDS` tuple;
- `ProjectComponents`;
- the strict `components` schema;
- four duplicated discovery-count sites.

### Evidence

`.capture/agents` drove Claude Code 2.1.283, Codex CLI 0.156.1, OpenCode 1.18.31
and OpenCode 2.0.17, and each adapter's reference build (Claude 2.1.238, Codex
0.148.0, OpenCode 1.18.18). Each used a hand-written native agent, loopback
playback models, and a routing proxy that separates parent and child requests.
It was a live probe; no model spend.

| | Claude | Codex | OpenCode v1 | OpenCode v2 |
| --- | --- | --- | --- | --- |
| Project file discovered and advertised to the parent | yes | yes (adds `agent_type` to `spawn_agent`) | yes | yes |
| Instructions reach the child | replace base prompt | layered on base instructions | replace | replace |
| Native model override honoured | yes | yes (the effort must fit the model) | yes | yes |
| Native tool restriction honoured | exact allow-list | none exists; agent `sandbox_mode` ignored | permission deny removes tools | permission rules remove tools; `subagent`, `execute` remain |
| Native turn cap | stops partway, resumable, no `SubagentStop` | none | not enforced | hard stop |
| Package route | plugin `agents/`, qualified `plugin:name` | none (openai/codex#18988) | plugin `config` hook | `ctx.agent.transform` `update` upserts |
| Agent identity on child tool events | `agent_type` | `agent_type` | no (on `chat.message` only) | `agent` |
| Reads `.claude/agents/` or `.agents/agents/` | `.agents/`: no | no | no | no |

Codex rejects an agent file outright when it contains one unknown key, with only a
warning.

The same drive ran a session as the agent:

| | Claude | Codex | OpenCode v1 | OpenCode v2 |
| --- | --- | --- | --- | --- |
| Start a session as the agent | `--agent <name>`, or the project's `agent` setting | no option | `run --agent`, `default_agent` | `run --agent`, `default_agent` |
| Which agents | any agent file | — | `mode: primary` or `all`; a `subagent` falls back to the default agent | any |
| The session's prompt, tools, model | the instructions replace the default prompt; the tool list and model apply | — | the same | the instructions replace the provider prompt; the configured `model` wins over the agent's |
| Offered for delegation | every agent, unless a project permission rule `Agent(<name>)` withholds it | — | `subagent`, `all` | `subagent`, `all` |
| Package route | a plugin agent, as `<plugin>:<name>` or its bare name | none | a `config` hook agent with `mode: "primary"` | a transform `update` with `mode: "primary"` |
| Identity on the session's events | `agent_type` on every event, with no `agent_id` | — | on `chat.message` only | `agent` on tool events |

## Decision (proposed)

1. **The component is `agents`.** A definition is an agent the harness runs: as a
   subagent, as a session's own agent, or both (decision 9). Every targeted
   harness keeps such files in a directory called `agents` (`.claude/agents`,
   `.codex/agents`, `.opencode/agents`, a Claude plugin's `agents/`). The word is
   also used by the `agent.*` events, the `agent` tool kind, `.agents/`
   directories, Agent Skills and Agent Plugins, so the component is always
   written with its namespace: `components.agents`, `agents.definition`. An
   earlier draft of this ADR named it `subagents`, when it covered subagents
   only.

2. **The format is [Hooknostic Agent Definition 0.1](../spec/agents/0.1.md).**
   - **File.** One Markdown file per agent: YAML frontmatter, and the body as its
     instructions.
   - **Closed core.** Only `name`, `description` and `mode` are core keys. `name`
     uses the Agent Skills name grammar and must equal the file stem.
     `description` is single-line routing text. `mode` is optional and defaults to
     `subagent` (decision 9).
   - **Harness data.** Everything harness-specific goes under
     `native: { <harness>: {...} }`. It is emitted only to that harness, and keys
     the core owns are refused.
   - **Reserved keys.** `readOnly`, `tools`, `model`, `maxTurns`, `skills`, `mcp`
     and `hooks` may not be used, so a later version can define them.

3. **The format must be replaceable.** Consumers parse the file into one model,
   `AgentDefinition {name, description, mode, instructions, native}`, and
   translate only from that model. A future standard then becomes a second parser
   plus a converter, not a rewrite. The file's field names deliberately match the
   vocabulary the harnesses already share; `mode` and its values are OpenCode's,
   the one harness that has such a field.

4. **The source is Hooknostic input, like hook source.**
   - **Config.** `components.agents: string[]` names directories of flat
     `<name>.md` files. Its zod twin moves in the same edit (extend-vocabulary
     checklist).
   - **Beside a package.** It is accepted on its own, beside direct `skills` or
     `mcp` sources, or beside `components.root`. Beside a root, the definitions
     are not package content: each projector translates them into its native
     package, and project targets receive them as from a direct source.
   - **Overlap.** A source directory that overlaps any target's native agents
     directory is refused, so no harness reads the portable file in place.
   - **Inventory.** Configured source directories are excluded from package
     inventory, as the hook `entry` is. Copied verbatim, a definitions directory
     at `<root>/agents/` would otherwise land on the path its own Claude
     translation is emitted at.

5. **Project delivery is first.** One owned file per agent:

   | Harness | File |
   | --- | --- |
   | Claude | `.claude/agents/<name>.md` |
   | Codex | `.codex/agents/<name>.toml` |
   | OpenCode v1 | `.opencode/agents/<name>.md` |
   | OpenCode v2 | `.opencode/agents/<name>.md` |

   - **Ownership.** Whole-file ownership through the existing manifest.
   - **OpenCode.** Always emit the definition's `mode`. OpenCode's own default
     is not `subagent`: v2 defaults an agent to `primary`, which its `subagent`
     tool cannot select.
   - **Codex TOML.** Codex needs a deterministic TOML *file* writer. The existing
     TOML support edits keys only. The writer must never emit a key Codex does
     not know, since one unknown key removes the whole agent.

6. **Component ids are coarse and named for what reaches the harness:**
   - `agents.definition`: the core contract in the spec's Semantics section, for
     every definition, whatever its mode.
   - `agents.primary`: the main-session contract, for each definition whose mode
     is `primary` or `all` (decision 9).
   - `agents.native`: passthrough.
   - `agents.default`: `components.defaultAgent`, the agent every session of the
     project starts as (decision 10).

   A field-level departure is a declared deviation or degradation, never a new
   id. `agents.primary` is an id rather than a deviation because it is a second
   way to deliver an agent, with its own support: Codex delivers definitions and
   has no main-session route. The ids join a generalized `ComponentId` union.
   The published `AgentPluginComponentId` stays unchanged, because v0.2.0 made
   config keys and component ids public API. Every adapter declares explicit
   cells for the new ids in the same change.

   Proposed project-delivery levels:
   - **`agents.definition` is `exact` on all four families.** The contract
     allows either prompt placement, and the rationale records which one each
     harness uses.
   - **`agents.primary` is `exact` on Claude and both OpenCode families, and
     `unsupported` on Codex.** Claude's cell declares the deviation in decision 9.
   - **`agents.native` is `exact`.** Codex's rationale records its strict
     parsing, and OpenCode v2's declares the degradation in decision 9.

7. **Package delivery translates the definitions into each native package:**

   | Harness | Route | Name offered | `agents.definition` | `agents.primary` | `agents.native` |
   | --- | --- | --- | --- | --- | --- |
   | Claude | the plugin's `agents/<name>.md` | `<plugin>:<name>`, qualified by Claude | `exact` | `exact`, with a deviation | `exact`, with a degradation |
   | Codex | none (openai/codex#18988) | — | `unsupported` | `unsupported` | `unsupported` |
   | OpenCode v1 | the generated module's `config` hook assigns `config.agent` | `<plugin>-<name>` | `emulated`, with a degradation | `emulated` | `exact` |
   | OpenCode v2 | the generated module's `ctx.agent.transform` upserts through `update` | `<plugin>-<name>` | `emulated`, with a degradation | `emulated` | `unsupported` |

   - **Claude.** A package file at a generated agent's path, including one an
     overlay hoists there, is a fatal collision (case-folded); nothing is merged.
     Claude ignores `permissionMode` in a plugin's agent file, where a project
     agent honours it. The field is still written and reported as the
     `claude:plugin-agent-field-ignored` degradation.
   - **OpenCode naming.** Neither OpenCode route qualifies names by plugin, so the
     projection names each agent `<plugin>-<name>`, as ADR-0021 does for skills. A
     name that cannot be qualified keeps its bare form and is reported as
     `opencode:agent-name-unqualified`. A session is started as the agent under
     the same name, which is why `agents.primary` is `emulated` there too.
   - **OpenCode v2.** The plugin API takes OpenCode's internal agent shape, of
     which only `id`, `description`, `mode` and `system` were observed. It needs
     the definition's `mode` just as the project file does. `native.opencode` is
     omitted and reported.
   - **Reserved native keys.** They are refused on package targets as on project
     targets, rather than dropped by a projector.
   - **Codex.** Each definition is reported as an omission. The build fails
     unless `onUnsupported: "warn"`.

8. **A consumer must never silently drop a definition.** An undeliverable
   definition goes through the existing shortfall classes and policies.

9. **A definition declares where it is offered: `mode`.**
   - **The values.** `subagent`, the default, offers the agent to the session's
     agent for delegation. `primary` offers it to the user as an agent a session
     runs as, and not for delegation. `all` does both.
   - **Where a mode cannot be delivered.** Codex has no main-session route, so
     `agents.primary` is `unsupported` there on both routes. A `primary`
     definition is not delivered to Codex at all; an `all` definition is
     delivered as a custom agent. Both are reported through `agents.primary` and
     fail the build unless `onUnsupported: "warn"`. Configuration profiles cannot
     stand in for one (decision 10), though the project's default agent can.
   - **Claude has no mode.** Every agent file can be run as the session and is
     offered for delegation, so one file serves all three modes. For a `primary`
     definition the delegation is extra, and Claude's `agents.primary` cells
     declare it as the deviation `claude:primary-agent-delegable`, reported per
     definition. Only a project permission rule, `Agent(<name>)` in
     `permissions.deny`, withholds an agent, and it leaves `--agent` working
     (`.capture/agents`). Generating it is open question 9.
   - **OpenCode writes the mode.** Project files, the v1 `config` hook and the v2
     transform all carry the definition's `mode`, which OpenCode enforces: a
     `primary` agent is absent from the delegation tool, and v1 refuses to run a
     `subagent` as the session.
   - **A native model on OpenCode v2.** v2 runs a session started as the agent on
     the configured `model`, not on the agent's own. The v2 project cell of
     `agents.native` declares this as the degradation
     `opencode:primary-agent-model-ignored`, reported for a `primary` or `all`
     definition that sets `native.opencode.model`. As a subagent, the model
     applies.
   - **Not the default agent by itself.** A `mode` only makes the agent
     available. Which agent a session starts as changes only when the project
     names one (decision 10).
   - **Hooks.** A session running as the agent names it on its events: every
     Claude event, and OpenCode v2 tool events. ADR-0029's agent scoping
     therefore reaches the agent as the session's agent as well.

10. **A project can name its default agent: `components.defaultAgent`.** Owner
    decision, 2026-09-29: an optional configuration.
    - **What it names.** A loaded definition whose mode is `primary` or `all`.
      Any other name is refused (HN503), since no harness should start a
      session as a subagent-only agent.
    - **Project delivery writes each harness's own default:**

      | Harness | Written | `agents.default` |
      | --- | --- | --- |
      | Claude | the `agent` key of the project's `.claude/settings.json` | `exact` |
      | OpenCode v1 | `default_agent`, set by the project's components plugin from its `config` hook | `exact` |
      | OpenCode v2 | the agent editor's `default(<name>)`, called by the same plugin | `exact` |
      | Codex | `developer_instructions`, and a native `model` and `model_reasoning_effort`, at the top of the project's `.codex/config.toml` | `emulated` |

      OpenCode's default is set from the plugin rather than written into
      `opencode.json` or `opencode.jsonc`, as project MCP already is; sync
      refuses a project whose own configuration names a `default_agent`.
    - **Codex, emulated.** Codex has no agent a session runs as, but a trusted
      project's configuration applies those three keys to every session in it
      (`.capture/agents`, 0.148.0 and 0.156.1). That is a default agent, with
      differences the rationale records: the instructions follow Codex's base
      instructions, as a spawned custom agent's do; the session's hook payloads
      carry no `agent_type`, so a hook scoped to the agent does not run for it;
      and without project trust the instructions applied while the model did
      not. No other native key is written there, because at the top level it
      would reconfigure the whole project: a `sandbox_mode` the agent file
      ignores would loosen every session. For a `primary` default, which gets
      no agent file on Codex, those keys are reported as not delivered.
    - **The default already runs as the session.** On a target without
      `agents.primary` it is not counted there, so a `primary` default does not
      fail a Codex build.
    - **Not a named primary agent on Codex.** Configuration profiles could have
      offered several, but a project's `[profiles.*]` table is ignored, and
      0.156.1 reads `--profile` only from a user-level `<name>.config.toml`,
      which Hooknostic does not write.
    - **Not from a package.** Every harness with main-session agents could do it
      from a plugin (a Claude plugin's `settings.json`, a v1 `config` hook, the
      v2 editor), but a package that did would start every session of every
      user who enables it as that agent. `agents.default` is `unsupported` on
      every package target, and reported like any unsupported component.

## Open questions for acceptance

1. **Scope wording.** CONTRIBUTING.md "What Hooknostic is" gains portable agent
   definitions as an input. Hooknostic would then own a provisional format, which
   the "not an Agent Plugins or Agent Skills authoring framework" line does not
   cover. The proposed addition: "Where no standard exists for a component
   (hooks, agents), Hooknostic defines the smallest portable form and states how
   it will yield to one."
2. **Package-borne agents.** There are two ways:
   - **Allow `components.agents` beside `components.root`.** The definitions stay
     Hooknostic input, exactly as hook source does, and are compiled into the
     native package. No namespace is needed. This is recommended, and it is what
     decisions 4 and 7 implement; the owner confirms or reverses it.
   - **Ship them inside the Agent Plugins package under a namespaced extension
     directory.** This is self-contained, but the reverse-domain namespace
     becomes permanent public contract.
3. **How a file declares its version.** In 0.1 the version is a property of the
   configured source, and the recommendation is to keep it so. The alternative is
   an optional frontmatter marker.
4. **When a read-only posture arrives.** It is the leading candidate for 0.2.
   - Claude: exact, through a tool allow-list with no shell or `Agent`.
   - OpenCode: permission rules. v2 must also deny `subagent` and `execute`,
     because a v2 subagent keeps its own permissions and could otherwise escalate.
   - Codex: unsupported natively. A generated agent-scoped `tool.before` could
     declare it `emulated`, since every child tool event carries `agent_type`.
     That would be behaviour shaping, not a security boundary (CONTRIBUTING.md).
5. **Canonical location of the spec and schema.** Their stable URL and whether
   they move to a published package.
6. **One `native.opencode` for two families.** A harness key is an adapter id, and
   the `opencode` adapter serves v1 and v2, whose agent fields differ: v1 has a
   `permission` map, v2 `permissions` rules. A configuration building both families
   sends the same block to each. The options are a family-qualified key such as
   `opencode-v2`, or leaving the block family-agnostic and documenting it.
7. **Per-target shortfall policy.** A package that targets Codex as well cannot ship
   its agents to the other harnesses without `onUnsupported: "warn"`, which
   relaxes every component, not just the agents. That is today's rule for any
   unsupported component, such as an SSE server on Codex. Agent definitions make
   the combination more common, and a `primary` definition makes it certain for a
   Codex target, which may justify a narrower policy.
8. **A default agent from a package.** Decision 10 refuses it on every package
   target, though each harness with main-session agents could deliver it. A later
   explicit opt-in could allow it for packages that are meant to take over a
   session.
9. **Withholding a `primary` definition from delegation on Claude.** The project
   rule `Agent(<name>)` does it exactly, but every such rule shares one
   `permissions.deny` array, and the ownership manifest can own only one element
   per key. Owning several needs a manifest change; a plugin cannot set
   permissions at all. Until then the deviation stands.

## Consequences

- **Maintenance.** Four harness families across up to two routes, on the
  youngest native surfaces in all three harnesses. Codex's own documentation
  already lists renamed `[agents]` keys. Keeping the levels honest requires:
  - component profiles with rolling `validatedOn` records (an ADR-0009
    amendment). Not done on this branch: it concerns every component, skills
    and MCP included, which have no rolling records either. Until then a new
    build is checked by the playback below, which fails on a change, but its
    pass is not recorded;
  - playback per family, in which the child request carries the instruction
    nonce and the configured model. `packages/cli/test/agent-definition-playback.test.ts`
    does this for what project delivery synchronizes and, except on Codex, for
    a built package, in CI's playback lanes and the harness-watch verify lane.
    On every family with main-session agents it also starts a session as a
    `primary` definition, synchronized or packaged, and runs a scoped hook
    inside such a session;
  - drift coverage for the delegation tool's shape.
- **Model overrides on Codex are a hazard.** A Codex child inherits the parent's
  reasoning effort, and a different model can reject it. A translation that sets
  a Codex model should also set its effort.
- **Findings for the hook adapters**, and where each went:
  - Codex 0.156.1 dispatches `SubagentStart`/`SubagentStop` once the parent
    waits; 0.148.0 dispatched no hook inside a subagent at all. The captured
    payloads are now fixtures, and the `agent-subagent` scenario's Codex
    inconclusive says why. The `agent-scope` scenario observes both events from
    0.156.1.
  - `multi_agent_v1wait_agent` is now listed in `CODEX_TOOL_KINDS`, as `other`.
  - Claude dispatches no `SubagentStop` when `maxTurns` ends a subagent. This is
    open: ADR-0029 leaves `agent.stop.observe`'s level to the owner.
  - Per-event agent identity makes agent-scoped hooks feasible without
    cross-invocation state (ADR-0002). ADR-0029 proposes and implements them,
    for subagents and for a session running as the agent.
- **Existing Claude packages.** A package that ships its own `agents/*.md` still
  reaches a Claude plugin through the verbatim copy, unreported. Such a file
  is Claude's format, not a portable definition. `components.agents` is the
  reported route, and a verbatim file at one of its paths is a fatal collision.

## Rejected alternatives

- **Accept Claude Code's agent file as the portable input.** It is the most
  widely read format, but it is vendor-shaped: its `tools` names are Claude's,
  and Codex reads only TOML. `docs/design.md` §21 warns against letting the first
  vendor surface dictate the abstraction.
- **A TypeScript `defineAgent()` as the primary surface.** The package loader is
  offline and never evaluates code, and instructions are long prose. A typed
  helper may later produce the same model, but it is never a second format.
- **Publish a cross-vendor standard now.** Agent Plugins is explicitly waiting for
  convergence. The captured matrix is better offered to it as evidence than
  competed with.
- **Portable `model`, `maxTurns` or tool lists in 0.1.** The captures show those
  fields diverge, or are absent, on at least one family.
- **Main-session agents as a component of their own.** An `all` agent would need
  two files, and OpenCode's single `mode` field would be split across them.
- **A Codex primary agent through configuration profiles.** A project cannot
  define profiles, and user-level configuration is not Hooknostic's to write.
- **Keep the name `subagents`.** It would describe a `primary` definition as a
  subagent, in a public config key.
