# Hooknostic — Implementation Plan and Technical Design

*Portable lifecycle hooks for coding-agent harnesses.*

> Converted from `crossharness_implementation_plan.docx` (baseline 2026-08-20) with the
> project renamed **hooknostic** (packages `@hooknostic/*`, CLI `hooknostic`, config
> `hooknostic.config.ts`, build report `hooknostic-build.json`, diagnostic codes
> `HN…`). Version-range examples have been updated to the actually-installed harness
> versions recorded in [baseline-2026-08-20.md](./baseline-2026-08-20.md).

| | |
| --- | --- |
| Baseline date | August 20, 2026 |
| Primary implementation | Node.js 22.13+ / TypeScript / ESM |
| Initial harness targets | Claude Code, OpenAI Codex, OpenCode |
| Companion standard | Agent Plugins 1.0 (optional integration) |

## 1. Executive summary

Hooknostic is a TypeScript SDK, compiler, and adapter runtime for authoring coding-agent
lifecycle hooks once and compiling them into harness-native integrations. It is not
another plugin packaging standard: Agent Plugins already provides a vendor-neutral
package floor for skills and MCP; Hooknostic fills the lifecycle-hook gap that remains
intentionally client-specific in Agent Plugins 1.0.

The central design rule is that **event availability and effect semantics are
separate**. A harness may expose a "before tool" event while differing in whether code
can block the call, ask for approval, rewrite input, add model-visible context, or merely
observe. Hooknostic makes those differences explicit through a semantic capability matrix
rather than hiding them behind optimistic adapters.

**Core contract:** author TypeScript hooks once. Hooknostic checks whether each
configured harness can implement the declared semantics, reports
exact/emulated/approximate/unsupported mappings, and emits the smallest native bridge for
every valid target.

## 2. Context and problem statement

### 2.1 The portability gap

Harnesses share portable extension mechanisms (Agent Skills, MCP), but lifecycle hooks
remain fragmented. Claude Code and Codex expose command-oriented hook protocols with JSON
payloads; OpenCode exposes JS/TS plugin callbacks with a different event vocabulary and
process model. Identical plugin behavior gets reimplemented three times.

Agent Plugins 1.0 is complementary: it standardizes a portable package and provides
client-extension namespaces/directories for non-portable data (including a
`hooks/hooks.json` extension example). Hooknostic uses that extension mechanism when
present; it never mutates or forks the Agent Plugins root schema.

### 2.2 Interoperability baseline

See [baseline-2026-08-20.md](./baseline-2026-08-20.md) for the primary-source snapshot
(Claude Code 2.1.238, Codex CLI 0.148.0, OpenCode 1.18.18).

**Important constraint:** native hook APIs are moving targets. Capability data is
versioned; decoders are tolerant of additive vendor fields. "Harness X supports Y" is
never a timeless boolean.

## 3. Product definition, goals, and non-goals

### 3.1 Product definition

A build-time compiler plus a small runtime dispatcher. Input: a TypeScript hook plugin
and target configuration. It builds a normalized IR, checks semantic portability, bundles
the portable implementation, and emits per-harness native artifacts. Usable standalone or
alongside Agent Plugins.

### 3.2 Goals

- Single-source hook logic for multiple harnesses.
- Explicit, inspectable capability semantics rather than silent degradation.
- Compile-time target selection and compatibility diagnostics.
- Self-contained native artifacts, independently distributable per target.
- An adapter contract allowing new harnesses without changing core SDK semantics.
- Normalized tool/action vocabulary retaining native names and raw payloads.
- Deterministic composition of multiple portable handlers in one native entry point.
- Versioned capability matrices and fixture-driven conformance tests.
- Optional, clean Agent Plugins 1.0 integration.

### 3.3 Non-goals for v0.1

| Non-goal | Reason |
| --- | --- |
| Policy engine / guardrail DSL | Interoperability layer, not a security product. |
| MCP abstraction | MCP is already portable. |
| Agent Skills abstraction | Skills define their own portable convention. |
| Custom tool abstraction | Separate problem. |
| Daemon / background service | Unjustified lifecycle/state/socket complexity. |
| Persistent state API | Portable process-lifetime semantics deferred (ADR-0002). |
| UI / marketplace / registry | Distribution is separate from compilation. |
| Perfect semantic parity | The capability model exists because parity is impossible. |

## 4. Design principles

| Principle | Consequence |
| --- | --- |
| Semantics over names | Normalize meaning, not vendor event strings. |
| Events ≠ effects | Observing a lifecycle point doesn't imply every control effect. |
| Degradation must be visible | Approximation/emulation recorded and surfaced; nothing silently dropped. |
| Raw data remains accessible | Every event keeps native payload + native identifiers. |
| One native dispatcher per lifecycle point | Hooknostic owns ordering/composition (ADR-0003). |
| Portable code is invocation-stateless | Module memory is not durable portable state (ADR-0002). |
| Tolerant readers, strict writers | Decode liberally, preserve unknowns, emit only validated outputs. |
| Reproducible builds | Versions, resolutions, diagnostics captured in the build report. |
| Agent Plugins is a peer | Use its extension mechanism; never redefine it (ADR-0004). |

## 5. System architecture

```
user TypeScript hooks
        │
        ▼
@hooknostic/sdk
        │
        ▼
normalized Plugin IR
        │
        ├── capability analysis ── diagnostics / build report
        │
        ▼
portable runtime bundle
        │
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
Claude adapter     Codex adapter   OpenCode adapter
        │              │              │
 hooks.json        hooks.json       JS/TS plugin
 command shim      command shim     in-process shim
```

The compiler is the authoritative place where portability is assessed. Adapters must not
silently drop an effect at emission time; incompatibility under the configured policy
produces a diagnostic **before** final artifacts are committed.

### Subsystems

| Subsystem | Responsibility |
| --- | --- |
| SDK (`@hooknostic/sdk`) | Authoring API; canonical event/effect/tool types; capability IDs; config helpers. |
| Core (`@hooknostic/core`) | Config/source loading, Plugin IR, target resolution, capability analysis, bundling + emission orchestration. |
| Runtime (`@hooknostic/runtime`) | Dispatch: adapter decode → portable handlers → effect composition → adapter encode/apply. |
| Adapters | Capability matrices, decoders/encoders, detection, artifact generation, validation. |
| CLI (`hooknostic`) | `check` / `build` / `doctor` / `inspect`, human + JSON diagnostics, target narrowing. |
| Testkit | Fixtures, fake adapters, contract tests, snapshot helpers. |

## 6. Canonical hook model

### 6.1 Event taxonomy

```ts
type HookEventName =
  | "session.start"
  | "session.end"
  | "prompt.before"
  | "tool.before"
  | "tool.after"
  | "tool.error"
  | "permission.request"
  | "context.compact.before"
  | "context.compact.after"
  | "agent.start"
  | "agent.stop"
  | "turn.stop";
```

Do not add a normalized event merely because one vendor exposes it. Worktree, task,
notification, file-watcher, message-display, setup, etc. remain vendor extension events
until at least two harnesses demonstrate a stable shared semantic need.

### 6.2 Canonical event envelope

```ts
interface BaseHookEvent {
  schemaVersion: 1;
  event: HookEventName;

  harness: {
    id: string;
    version?: string;
    nativeEvent: string;
  };

  session: {
    id?: string;
    cwd: string;
  };

  correlation: {
    turnId?: string;
    toolCallId?: string;
    agentId?: string;
    parentAgentId?: string;
  };

  raw: unknown;
}
```

Optional identifiers are intentional; adapters must not invent IDs the native harness
does not provide.

### 6.3 Tool invocation normalization

```ts
interface ToolInvocation {
  kind:
    | "shell"
    | "file.read"
    | "file.write"
    | "file.edit"
    | "web.fetch"
    | "web.search"
    | "agent"
    | "mcp"
    | "other";

  nativeName: string;
  input: unknown;

  mcp?: {
    server?: string;
    tool?: string;
  };
}
```

The category is best-effort classification for portable matching; `nativeName` and
`event.raw` remain available for intentional harness-specific behavior.

### 6.4 Effect model

Effects are semantic actions a hook asks the harness to perform; they are never assumed
to exist merely because the event exists. Initial family (event-scoped equivalents):

- Block/prevent the pending action — `block(reason)`
- Request/escalate approval — `requestApproval(reason)`
- Replace pending tool input — `replaceInput(input)`
- Add model-visible context — `addContext(text)`
- Replace/redact tool output — `replaceOutput(output)`
- Prevent agent/turn stop — `preventStop(reason)`
- Block continuation after a completed tool event — `blockContinuation(reason)`

Every helper maps to an event-scoped capability. A generic `allow()` helper is
intentionally omitted: returning no effect means continue, avoiding vendor-specific
permission-bypass nuances.

## 7. Capability semantics and compatibility analysis

### 7.1 Capability identifiers

Stable, event-scoped semantic strings:

```
tool.before.observe          tool.after.observe            session.start.observe
tool.before.block            tool.after.output.replace     session.start.context.add
tool.before.requestApproval  tool.after.blockContinuation
tool.before.input.replace                                  context.compact.before.observe
tool.before.context.add                                    context.compact.before.block

turn.stop.observe
turn.stop.prevent
```

Using an event implicitly requires its `observe` capability; additional effects are
explicitly declared.

### 7.2 Support levels

| Level | Definition | Compiler meaning |
| --- | --- | --- |
| `exact` | Native behavior matches the semantic contract. | No degradation diagnostic. |
| `emulated` | Different native mechanism, equivalent observable behavior. | Acceptable under default policy; recorded. |
| `approximate` | Useful behavior exists; semantics differ materially. | Warning or error per configured minimum fidelity. |
| `unsupported` | Adapter cannot implement the capability. | Error for required; informational for optional. |

### 7.3 Hook capability declaration

```ts
hook("tool.before", {
  id: "protect-shell",

  capabilities: {
    "tool.before.block": "required",
    "tool.before.input.replace": "optional",
  },

  async run(event, ctx) {
    // portable implementation
  },
});
```

The map is both the compiler's static capability manifest and the definition of which
effect helpers the hook may return. TypeScript generics make undeclared effects a
compile-time error where practical; runtime validation remains mandatory.

### 7.4 Required versus optional

| Declaration | Meaning | Build behavior |
| --- | --- | --- |
| `required` | Behavior depends on the capability. | Must meet the target's compatibility policy or the target fails. |
| `optional` | Hook can operate without it; feature-detect at runtime. | Never blocks the build; recorded as info/metadata. |

```ts
if (ctx.capabilities.has("tool.before.input.replace")) {
  return replaceInput(rewritten);
}
return; // continue without the optional enhancement
```

An unavailable optional capability does **not** permit returning its effect anyway; doing
so is a hook runtime error (HN401) handled per the configured hook-error policy.

### 7.5 Compatibility policy

```ts
compatibility: {
  minimum: "emulated",
  onBelowMinimum: "error",
  optionalUnavailable: "info",
}

targets: {
  opencode: {
    compatibility: { minimum: "approximate", onBelowMinimum: "warn" },
  },
}
```

Fidelity order: `exact > emulated > approximate > unsupported`. Project default:
`minimum: "emulated"; onBelowMinimum: "error"`. Per-target overrides allow intentional
degradation.

### 7.6 Target-scoped hooks

```ts
hook("session.start", {
  id: "claude-codex-bootstrap",
  targets: { include: ["claude", "codex"] },
  async run(event) { /* ... */ },
});
```

Intentional scoping is not a portability failure and emits no warnings.

### 7.7 Capability analysis algorithm

1. Resolve configured build targets, requested modes, and version ranges.
2. Load each adapter's versioned capability matrix for the range.
3. For each hook included in a target, require the implicit `<event>.observe`.
4. Evaluate every declared required/optional capability against adapter support.
5. Compare support level to the target's minimum-fidelity policy.
6. Emit stable diagnostics with hook ID, capability, target, requested/available
   fidelity, and adapter rationale.
7. If any fatal diagnostic exists, do not commit final artifacts (stage to a temp dir).
8. Record all capability resolutions (including optional misses) in
   `hooknostic-build.json`.

## 8. Build system and target selection

### 8.1 Configuration

```ts
// hooknostic.config.ts
import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  entry: "./src/hooks.ts",

  compatibility: {
    minimum: "emulated",
    onBelowMinimum: "error",
    optionalUnavailable: "info",
  },

  targets: {
    claude:   { version: ">=2.1 <3",  mode: "plugin", output: "./dist/claude" },
    codex:    { version: ">=0.148 <1", mode: "local",  output: "./dist/codex" },
    opencode: { version: ">=1.18 <2", mode: "local",  output: "./dist/opencode" },
  },

  agentPlugin: { root: "." },
});
```

Version ranges are examples; adapters derive and document tested ranges from real
fixtures and releases.

### 8.2 CLI target narrowing

Config defines the allowed target set; CLI flags only narrow it:

```
hooknostic build
hooknostic build --target claude
hooknostic build --target claude,codex
hooknostic check --target opencode
```

### 8.3 Compiler pipeline

```
load config
    ↓
load + bundle-safe evaluate source metadata
    ↓
build normalized Plugin IR
    ↓
resolve selected targets + version ranges
    ↓
capability analysis
    ↓
ERROR/WARN/INFO diagnostics
    ↓ (only if target set is buildable)
bundle portable runtime once
    ↓
compile per-target shims + manifests
    ↓
validate generated artifacts
    ↓
write hooknostic-build.json
    ↓
atomically commit dist outputs
```

The capability pass precedes final emission; semantic incompatibility is never discovered
after artifacts are partially written.

### 8.4 Self-contained target outputs

Each target directory is independently distributable; the small bundled runtime is
duplicated per target.

```
dist/
├── claude/
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json
│   └── runtime/hooknostic.mjs
├── codex/
│   ├── .codex-plugin/plugin.json
│   ├── hooks/hooks.json
│   └── runtime/hooknostic.mjs
├── opencode/
│   └── .opencode/plugins/hooknostic.mjs
└── hooknostic-build.json
```

OpenCode ships local-file mode first; npm-package mode can follow.

### 8.5 Build report

```json
{
  "schemaVersion": 1,
  "hooknosticVersion": "0.1.0",
  "source": "./src/hooks.ts",
  "targets": {
    "claude": {
      "status": "success",
      "adapter": "@hooknostic/adapter-claude@0.1.0",
      "requestedVersion": ">=2.1 <3",
      "capabilities": { "exact": 11, "emulated": 1, "approximate": 0, "unsupported": 0 }
    }
  },
  "diagnostics": []
}
```

The report schema is versioned so CI tooling can consume it without parsing terminal
text.

## 9. Diagnostics and developer experience

### 9.1 Compiler-style diagnostics

Each diagnostic: stable code, severity, hook ID, source location when available, target,
capability, adapter/version context, remediation hint.

```
HN201 capability unsupported

  src/hooks.ts:18
  hook "approve-database"

  requires: tool.before.requestApproval
  target:   codex
  support:  unsupported

  The Codex adapter can observe and block at this lifecycle point,
  but cannot reproduce Hooknostic requestApproval semantics for
  the configured target range.

  Remediation: make the capability optional, add a target-specific
  fallback, exclude codex from this hook, or narrow the build target.
```

| Family | Meaning |
| --- | --- |
| HN1xx | Degradation/informational compatibility diagnostics. |
| HN2xx | Required capability/event/version incompatibilities. |
| HN3xx | Adapter generation or artifact validation failures. |
| HN4xx | Runtime contract violations (undeclared/unsupported effects). |
| HN5xx | Configuration or source-model errors. |

Initial codes: **HN101** degraded capability, **HN102** optional capability unavailable,
**HN201** required capability unsupported, **HN202** event unavailable, **HN203** target
version outside adapter data, **HN301** adapter generation failure, **HN401** unsupported
effect returned at runtime, **HN501** invalid configuration.

### 9.2 Distinct commands

| Command | Question answered |
| --- | --- |
| `hooknostic check` | Can the source satisfy the configured targets? (no artifacts) |
| `hooknostic build` | Check + bundle + emit target artifacts. |
| `hooknostic doctor` | Are installed harness versions detected and within validated ranges? |
| `hooknostic inspect <target>` | Why does this adapter map a capability/event the way it does? |

## 10. Runtime and handler composition

### 10.1 One native hook dispatcher

One native entry point per lifecycle event/matcher group; portable handlers dispatched
internally (ADR-0003).

```
native lifecycle event
        ↓ adapter.decode(native)
normalized event
        ↓ handler A → apply mutation/context
handler B sees updated event
        ↓ handler C
composed HookResult
        ↓ adapter.encode/apply(result)
```

### 10.2 Composition rules (v0.1)

1. Sequential execution in declaration order after matcher filtering.
2. Input replacements apply immediately; later handlers see updated input.
3. Context additions accumulate in declaration order; conservative configurable size
   cap.
4. `block` is terminal.
5. `requestApproval` is terminal.
6. Post-tool: output replacements apply immediately; `blockContinuation` is terminal.
7. No effect = continue unchanged.
8. First terminal effect in declaration order wins; the runtime records the terminator.

### 10.3 Error and timeout policy

```ts
runtime: {
  onHookError: "continue",   // default for a general SDK
  timeoutMs: 5_000,
}
```

Fail-open by default; security-sensitive users may opt into `onHookError: "block"` only
for events where the adapter can reliably block. The runtime provides an `AbortSignal`
and translates the timeout to native hook timeout settings where possible.

### 10.4 Process lifetime and state

Portable hooks are invocation-stateless (ADR-0002). v0.1 has no persistence
abstraction.

## 11. Adapter contract

### 11.1 Responsibilities

Declare ID + tested native version ranges; expose versioned capability matrices with
rationale; decode native events to canonical; encode/apply canonical effects to native
outputs; compile manifests/shims; detect installed versions for `doctor`; validate
generated artifacts; provide fixtures for every supported event/effect combination.

### 11.2 Interface

```ts
export interface HarnessAdapter {
  readonly id: string;
  readonly adapterVersion: string;

  supportedHarnessVersions(): VersionRange[];
  capabilities(target: TargetSpec): CapabilityMatrix;
  detect?(): Promise<DetectionResult>;

  compile(
    plugin: PluginIR,
    target: TargetSpec,
    bundle: RuntimeBundle,
  ): Promise<GeneratedArtifact[]>;

  validateArtifacts?(
    artifacts: GeneratedArtifact[],
    target: TargetSpec,
  ): Promise<Diagnostic[]>;

  runtime: RuntimeAdapter;
}

export interface RuntimeAdapter {
  decode(nativeEvent: unknown, invocation: InvocationContext): Promise<HookEvent>;
  apply(
    result: HookResult,
    nativeEvent: unknown,
    invocation: InvocationContext,
  ): Promise<NativeHookResult>;
}
```

### 11.3 Tolerant decoding

Validate only the fields needed; retain unknown native fields in `event.raw`; canonical
objects and generated native outputs are strict. Never invent missing correlation IDs or
reinterpret unsupported control semantics.

### 11.4 Versioned capability data

```ts
const capabilityProfiles = [
  { range: ">=0.140 <0.150", matrix: codex0148Capabilities },
];
```

When a requested range overlaps incompatible profiles, resolve the least-capable
guaranteed intersection or require the user to narrow the range. Never assume the newest
profile for a broad range.

## 12. Initial target adapters

### 12.1 Claude Code

Plugin mode: `hooks/hooks.json` invoking the bundled Node runtime via plugin-root
placeholders, plus `.claude-plugin/plugin.json` for standalone artifacts. Prefer exec
form (`command` + `args`). JSON stdin → decode → dispatch → structured JSON/exit
behavior. Preserve event-specific blocking distinctions; never use exit 2 as a generic
deny where Claude does not honor it.

### 12.2 Codex

Local mode: repo-level `.codex/hooks.json` invoking the bundled runtime under
`.codex/hooknostic/`. Codex loads these hooks only for trusted projects and requires
per-hook trust (or an explicit trust bypass); generation never modifies trust state.
Some tool paths bypass hooks, so `tool.before.observe` is documented as tool-path
coverage, not a security boundary.

### 12.3 OpenCode

Local mode: bundled JS module under `.opencode/plugins/`. The module returns native
callbacks (`tool.execute.before/after`, permission/session events), normalizes each
event, invokes the same portable runtime, and applies effects by mutating callback output
or throwing per OpenCode semantics. Persistent module memory is never exposed as a
feature.

### 12.4 Capability matrices are adapter-owned

Matrices are built from current docs + verified fixture behavior, with rationale and
source/date metadata for every non-exact mapping. The CLI renders matrices from
adapter-owned facts; this document is not normative truth for any cell.

## 13. Agent Plugins integration

Hooknostic consumes/augments an Agent Plugins package (ADR-0004). With `plugin.json`
present it may reuse metadata and generate client extension directories; it never adds
unknown root-level manifest fields. Standalone mode (config + source only) is
first-class.

```
my-plugin/
├── plugin.json
├── skills/
├── mcp.json
├── hooknostic.config.ts
├── src/hooks.ts
├── com.anthropic.claude-code/hooks/hooks.json
├── com.openai.codex/hooks/hooks.json
└── <opencode-extension-namespace>/plugin.mjs
```

Namespace names must be confirmed against client conventions before the integration is
declared stable.

## 14. Repository and package structure

pnpm TypeScript monorepo; adapters are internal workspace packages; only the SDK and CLI
are published until the adapter API stabilizes.

```
hooknostic/
├── packages/{sdk,core,runtime,cli,adapter-claude,adapter-codex,adapter-opencode,testkit}/
├── fixtures/{claude,codex,opencode}/
├── examples/{basic,rewrite-shell,context-injection,agent-plugin}/
├── package.json / pnpm-workspace.yaml / tsconfig.json
```

| Package | Public? | Purpose |
| --- | --- | --- |
| `@hooknostic/sdk` | Yes | Authoring API and public types. |
| `hooknostic` | Yes | CLI binary. |
| `@hooknostic/core` | Not initially | Compiler/IR/capability analysis. |
| `@hooknostic/runtime` | Not initially | Dispatcher/runtime. |
| `@hooknostic/adapter-*` | Not initially | Harness adapters. |
| `@hooknostic/testkit` | Maybe later | For external adapter authors post-stabilization. |

**Build technology:** Node 22.13+, TypeScript, ESM; pnpm workspaces; esbuild for the
dependency-free per-target runtime `.mjs`; Zod internally (measure size/cold-start before
shipping it inside hook bundles); no daemon; explicit Windows path/executable support.

## 15. Test strategy

### 15.1 Fixture corpus

Native input/output examples stored by harness version; prefer fixtures captured from
real harness executions.

```
fixtures/codex/0.148/
├── pre-tool-bash.input.json
├── pre-tool-bash.canonical.json
├── pre-tool-block.output.json
├── pre-tool-rewrite.output.json
├── session-start.input.json
└── post-tool.input.json
```

### 15.2 Layers

| Layer | Proves |
| --- | --- |
| SDK type tests | Invalid event/effect/capability combos fail type-checking. |
| Canonical schema tests | IR/events/effects/report validate deterministically. |
| Capability analysis tests | Policies produce stable diagnostics. |
| Adapter decode tests | Native → canonical is correct and additive-tolerant. |
| Adapter apply tests | Canonical effect → native output matches fixtures. |
| Generation snapshot tests | Manifests/hooks/plugins are stable and valid. |
| Runtime composition tests | Ordering, mutation, terminal effects, errors, timeouts. |
| Smoke tests | Generated artifacts load in installed harnesses. |

### 15.3 Golden round-trip

```
native fixture → adapter.decode → canonical fixture → handlers → canonical HookResult
→ adapter.apply → expected native result
```

### 15.4 CI matrix

Unit/fixture tests on Linux/macOS/Windows. Harness smoke tests may move to
scheduled/release CI. No claimed support without fixture coverage + recent smoke
validation.

## 16. Versioning

Three separate version kinds: Hooknostic package version (API behavior), canonical schema
version (serialized events/effects/report), and harness capability profile ranges. A new
harness release normally means a profile/fixture update, not a canonical schema change.
`doctor` warns when a detected harness is newer than the validated range; `build` uses
configured ranges (reproducibility), never the locally installed version. Avoid `latest`
in reproducible configs.

## 17. Operational and trust considerations

- Hooks execute code in the developer environment; Hooknostic is not a sandbox.
- Preserve each harness's trust/review mechanisms; never auto-bypass trust prompts.
- Never describe pre-tool hooks as a complete security boundary.
- Generated command hooks use exec/argument-array forms; never interpolate untrusted
  payload into shell strings.
- Runtime diagnostics avoid dumping secrets from raw tool input by default.
- v0.1 `build` is pure artifact generation; nothing mutates user/global harness config.

## 18. Milestones

- **M0** Repo + ADRs + baseline doc.
- **M1** Canonical SDK and schemas.
- **M2** Capability compiler (fake adapters prove the model first).
- **M3** Runtime dispatcher (bundled, cold-start validated).
- **M4** Claude adapter (profile, fixtures, generation, smoke).
- **M5** Codex adapter.
- **M6** OpenCode adapter.
- **M7** build/report/doctor/inspect UX; atomic writes.
- **M8** Agent Plugins integration + examples.
- **M9** Hardening: cross-platform tests, fixture audit, docs, API review, RC.

## 19. v0.1 acceptance criteria

| Area | Criterion |
| --- | --- |
| Authoring | One TS hook source + one config serves Claude, Codex, OpenCode. |
| Capability safety | Every used capability statically declared and resolved per target pre-emission. |
| Diagnostics | Unsupported required behavior → deterministic error with target, hook, capability, remediation. |
| Degradation | Approximate/emulated mappings explicit and policy-surfaced. |
| Artifacts | Each target output self-contained and independently distributable. |
| Runtime | Deterministic declaration-order execution with documented terminal/mutation semantics. |
| Escape hatch | Native event/tool names and raw payload accessible from the normalized API. |
| Versioning | Build report records adapter version, ranges, resolutions, diagnostics. |
| Testing | All advertised capabilities fixture-covered; critical outputs smoke-validated. |
| Agent Plugins | Combined packages use only formal extension mechanisms. |

## 20. Deferred work

Persistent storage API; fallback graphs (`requestApproval → block`); third-party adapter
SDK; OpenCode npm output mode; more adapters (Cursor, Gemini CLI, Copilot CLI, Goose,
Qwen Code); fixture recording command; persistent-runtime performance mode; additional
normalized events; formal Agent Plugins proposal.

## 21. Implementation sequence

Prove the semantic compiler before native adapters — never let the first vendor surface
dictate the core abstraction.

| PR | Deliverable | Exit condition |
| --- | --- | --- |
| 1 | Monorepo + ADR skeleton | Build/test/lint green. |
| 2 | Canonical types | Type tests + runtime schema tests pass. |
| 3 | Config + Plugin IR | Example source → deterministic IR. |
| 4 | Capability resolver + fake adapters | Expected HN diagnostics for all cases. |
| 5 | CLI `check` + JSON | CI passes/fails from semantic analysis alone. |
| 6 | Runtime dispatcher | Composition/mutation/terminal/error/timeout covered. |
| 7 | Claude adapter | Artifact + fixtures + smoke. |
| 8 | Codex adapter | Artifact + fixtures + smoke. |
| 9 | OpenCode adapter | Local plugin + fixtures + smoke. |
| 10 | build/report/doctor + Agent Plugins example | End-to-end three-target example. |

**Priority rule:** under schedule pressure, shrink the normalized event surface before
weakening capability semantics.

## Appendix A — authoring example

```ts
// src/hooks.ts
import { definePlugin, hook, block, replaceInput, addContext } from "@hooknostic/sdk";

export default definePlugin({
  name: "portable-repo-hooks",

  hooks: [
    hook("tool.before", {
      id: "protect-and-normalize-shell",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        const input = event.tool.input as { command?: string };
        const command = input.command ?? "";

        if (command.includes("rm -rf /")) {
          return block("Refusing destructive root deletion");
        }

        if (ctx.capabilities.has("tool.before.input.replace") && command.startsWith("npm ")) {
          return replaceInput({ ...input, command: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),

    hook("session.start", {
      id: "repo-context",
      capabilities: { "session.start.context.add": "optional" },
      async run(event, ctx) {
        if (!ctx.capabilities.has("session.start.context.add")) return;
        return addContext(`Working directory: ${event.session.cwd}`);
      },
    }),
  ],
});
```

## Appendix B — build configuration example

```ts
// hooknostic.config.ts
import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  entry: "./src/hooks.ts",
  compatibility: { minimum: "emulated", onBelowMinimum: "error", optionalUnavailable: "info" },
  runtime: { onHookError: "continue", timeoutMs: 5_000 },
  targets: {
    claude:   { version: ">=2.1 <3",   mode: "plugin", output: "./dist/claude" },
    codex:    { version: ">=0.148 <1", mode: "local",  output: "./dist/codex" },
    opencode: {
      version: ">=1.18 <2", mode: "local", output: "./dist/opencode",
      compatibility: { minimum: "approximate", onBelowMinimum: "warn" },
    },
  },
  agentPlugin: { root: "." },
});
```

## Appendix C — definition of done for a new adapter

- Adapter ID, native version ranges, source-date metadata documented.
- Every advertised normalized event has ≥1 native input fixture.
- Every advertised non-observe effect has an expected native output/apply fixture.
- Every matrix cell has a support level + rationale for non-exact values.
- Decode retains native event/tool names and raw payload.
- Unknown additive native fields do not break decoding.
- Generated artifacts pass native schema/config validation where available.
- `check`/`build` produce deterministic diagnostics for unsupported required
  capabilities.
- `doctor` detects the version or explicitly reports detection unavailable.
- ≥1 end-to-end smoke test loads a generated plugin in a real harness within the claimed
  range.
- Windows path/command behavior tested if the harness supports Windows.
- Adapter-specific behavior does not leak new concepts into the canonical core without an
  established cross-harness case.
