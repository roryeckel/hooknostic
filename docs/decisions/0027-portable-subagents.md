# ADR-0027: Portable subagent definitions are a Hooknostic component

**Status:** Proposed — 2026-09-29. It needs owner review before acceptance, and the
open questions below must be settled first. The decisions are implemented on the
branch that proposes them, so they can be reviewed as working code; the branch
merges only once this is accepted.

**In short:** Hooknostic should compile one portable definition of a subagent into
each harness's native form:

- a Claude Code subagent;
- a Codex custom agent;
- an OpenCode agent with `mode: subagent`.

It would be a third component kind beside skills and MCP, in a format Hooknostic
owns ([Hooknostic Subagent Definition 0.1](../spec/subagents/0.1.md)). The format
stays provisional until a real standard exists, and it is built to be replaced by
one. The capture spike (`.capture/agents`) found that the core — name, description
and instructions — reaches the child on all four harness families. Tool
restrictions, turn caps and sandboxing do not port, so 0.1 leaves them out.

## Context

Every targeted harness now lets a project define its own subagents. The formats
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
and OpenCode 2.0.17. Each used a hand-written native agent, loopback playback
models, and a routing proxy that separates parent and child requests. It was a
live probe; no model spend.

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

## Decision (proposed)

1. **The component is `subagents`.** The name is not "agents", which is already
   overloaded here: the `agent.*` events, the `agent` tool kind, `.agents/`
   directories, Agent Skills and Agent Plugins. Version 0.1 defines subagents
   only, which is also the accurate scope. Primary or main-agent use exists on
   Claude and OpenCode only.

2. **The format is [Hooknostic Subagent Definition 0.1](../spec/subagents/0.1.md).**
   - **File.** One Markdown file per subagent: YAML frontmatter, and the body as
     its instructions.
   - **Closed core.** Only `name` and `description` are core keys. `name` uses
     the Agent Skills name grammar and must equal the file stem. `description` is
     single-line routing text.
   - **Harness data.** Everything harness-specific goes under
     `native: { <harness>: {...} }`. It is emitted only to that harness, and keys
     the core owns are refused.
   - **Reserved keys.** `readOnly`, `tools`, `model`, `maxTurns`, `mode`,
     `skills`, `mcp` and `hooks` may not be used, so a later version can define
     them.

3. **The format must be replaceable.** Consumers parse the file into one model,
   `SubagentDefinition {name, description, instructions, native}`, and translate
   only from that model. A future standard then becomes a second parser plus a
   converter, not a rewrite. The file's field names deliberately match the
   vocabulary the harnesses already share.

4. **The source is Hooknostic input, like hook source.**
   - **Config.** `components.subagents: string[]` names directories of flat
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

5. **Project delivery is first.** One owned file per subagent:

   | Harness | File |
   | --- | --- |
   | Claude | `.claude/agents/<name>.md` |
   | Codex | `.codex/agents/<name>.toml` |
   | OpenCode v1 | `.opencode/agents/<name>.md` |
   | OpenCode v2 | `.opencode/agents/<name>.md` |

   - **Ownership.** Whole-file ownership through the existing manifest.
   - **OpenCode.** Always emit `mode: subagent`: v2 defaults to `primary`.
   - **Codex TOML.** Codex needs a deterministic TOML *file* writer. The existing
     TOML support edits keys only. The writer must never emit a key Codex does
     not know, since one unknown key removes the whole agent.

6. **Component ids are coarse and named for what reaches the harness:**
   - `subagents.definition`: the core contract in the spec's Semantics section.
   - `subagents.native`: passthrough.

   A field-level departure is a declared deviation or degradation, never a new
   id. The ids join a generalized `ComponentId` union. The published
   `AgentPluginComponentId` stays unchanged, because v0.2.0 made config keys and
   component ids public API. Every adapter declares explicit cells for the new
   ids in the same change.

   Proposed project-delivery levels:
   - **`subagents.definition` is `exact` on all four families.** The contract
     allows either prompt placement, and the rationale records which one each
     harness uses.
   - **`subagents.native` is `exact`.** Codex's rationale records its strict
     parsing.

7. **Package delivery translates the definitions into each native package:**

   | Harness | Route | Name offered | `subagents.definition` | `subagents.native` |
   | --- | --- | --- | --- | --- |
   | Claude | the plugin's `agents/<name>.md` | `<plugin>:<name>`, qualified by Claude | `exact` | `exact`, with a degradation |
   | Codex | none (openai/codex#18988) | — | `unsupported` | `unsupported` |
   | OpenCode v1 | the generated module's `config` hook assigns `config.agent` | `<plugin>-<name>` | `emulated`, with a degradation | `exact` |
   | OpenCode v2 | the generated module's `ctx.agent.transform` upserts through `update` | `<plugin>-<name>` | `emulated`, with a degradation | `unsupported` |

   - **Claude.** A package file at a generated agent's path, including one an
     overlay hoists there, is a fatal collision (case-folded); nothing is merged.
     Claude ignores `permissionMode` in a plugin's agent file, where a project
     agent honours it. The field is still written and reported as the
     `claude:plugin-agent-field-ignored` degradation.
   - **OpenCode naming.** Neither OpenCode route qualifies names by plugin, so the
     projection names each agent `<plugin>-<name>`, as ADR-0021 does for skills. A
     name that cannot be qualified keeps its bare form and is reported as
     `opencode:subagent-name-unqualified`.
   - **OpenCode v2.** The plugin API takes OpenCode's internal agent shape, of
     which only `id`, `description`, `mode` and `system` were observed. It needs
     `mode: subagent` just as the project file does. `native.opencode` is omitted
     and reported.
   - **Reserved native keys.** They are refused on package targets as on project
     targets, rather than dropped by a projector.
   - **Codex.** Each definition is reported as an omission. The build fails
     unless `onUnsupported: "warn"`.

8. **A consumer must never silently drop a definition.** An undeliverable
   definition goes through the existing shortfall classes and policies.

## Open questions for acceptance

1. **Scope wording.** CONTRIBUTING.md "What Hooknostic is" gains portable
   subagent definitions as an input. Hooknostic would then own a provisional
   format, which the "not an Agent Plugins or Agent Skills authoring framework"
   line does not cover. The proposed addition: "Where no standard exists for a
   component (hooks, subagents), Hooknostic defines the smallest portable form
   and states how it will yield to one."
2. **Package-borne subagents.** There are two ways:
   - **Allow `components.subagents` beside `components.root`.** The definitions
     stay Hooknostic input, exactly as hook source does, and are compiled into
     the native package. No namespace is needed. This is recommended, and it is
     what decisions 4 and 7 implement; the owner confirms or reverses it.
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

## Consequences

- **Maintenance.** Four harness families across up to two routes, on the
  youngest native surfaces in all three harnesses. Codex's own documentation
  already lists renamed `[agents]` keys. Keeping the levels honest requires:
  - component profiles with rolling `validatedOn` records (an ADR-0009
    amendment);
  - playback per family, in which the child request carries the instruction
    nonce and the configured model. `packages/cli/test/subagent-playback.test.ts`
    does this for what project delivery synchronizes and, except on Codex, for
    a built package, in CI's playback lanes and the harness-watch verify lane;
  - drift coverage for the delegation tool's shape.
- **Model overrides on Codex are a hazard.** A Codex child inherits the parent's
  reasoning effort, and a different model can reject it. A translation that sets
  a Codex model should also set its effort.
- **Findings for the hook adapters** (outside this ADR, recorded so they are not
  lost):
  - Codex 0.156.1 dispatches `SubagentStart`/`SubagentStop` once the parent
    waits. The `agent-subagent` playback never waits, so its Codex "inconclusive"
    deserves a re-run with a `wait_agent` turn.
  - `multi_agent_v1wait_agent` is unclassified in `CODEX_TOOL_KINDS`.
  - Claude dispatches no `SubagentStop` when `maxTurns` ends a subagent.
  - Per-event agent identity (Claude and Codex `agent_type`, OpenCode v2
    `agent`) makes agent-scoped hooks feasible without cross-invocation state
    (ADR-0002). That is a separate normalization decision.
- **Existing Claude packages.** A package that ships its own `agents/*.md` still
  reaches a Claude plugin through the verbatim copy, unreported. Such a file
  is Claude's format, not a portable definition. `components.subagents` is the
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
