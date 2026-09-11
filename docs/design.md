# Hooknostic — Implementation Plan and Technical Design

*Portable lifecycle hooks for coding-agent harnesses.*

> This is the deep technical reference — the complete contracts, diagnostics, adapter
> interfaces, and milestones. For a gentler introduction to the same ideas, start with
> [Core concepts](concepts.md); for hands-on material, see
> [Getting started](getting-started.md) and the [tutorials](tutorials/).

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

Hooknostic is a TypeScript SDK and compiler for authoring coding-agent lifecycle hooks
once and compiling them into harness-native integrations. It can also project an
Agent Plugins 1.0 package into a harness-native plugin without redefining that peer
standard.

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
client-extension namespaces/directories for non-portable data. Hooknostic validates the
portable package and projects representable components into a separate native output;
it never mutates or forks the Agent Plugins root schema.

### 2.2 Interoperability baseline

See [harness-support.md](./harness-support.md) for the current validated versions
(generated from the adapter metadata), and
[baseline-2026-08-20.md](./baseline-2026-08-20.md) for the dated primary-source
snapshot.

**Important constraint:** native hook APIs are moving targets. Capability data is
versioned; decoders are tolerant of additive vendor fields. "Harness X supports Y" is
never a timeless boolean.

## 3. Product definition, goals, and non-goals

### 3.1 Product definition

A build-time compiler plus a small runtime dispatcher. Input is a TypeScript hook plugin,
an Agent Plugins package, or both, plus target configuration. Hook compilation and package
projection are independent phases composed into one atomic per-target output.

### 3.2 Goals

- Single-source hook logic for multiple harnesses.
- Explicit, inspectable capability semantics rather than silent degradation.
- Compile-time target selection and compatibility diagnostics.
- Self-contained native artifacts, independently distributable per target.
- An adapter contract allowing new harnesses without changing core SDK semantics.
- Normalized tool/action vocabulary retaining native names and raw payloads.
- Deterministic composition of multiple portable handlers in one native entry point.
- Versioned capability matrices and fixture-driven conformance tests.
- Versioned, inspectable Agent Plugins 1.0 projection into native plugin layouts.

### 3.3 Non-goals for v0.1

| Non-goal | Reason |
| --- | --- |
| Policy engine / guardrail DSL | Interoperability layer, not a security product. |
| MCP runtime abstraction | MCP is already portable; projectors only translate native configuration. |
| Agent Skills authoring abstraction | Skills define their own portable convention; projectors validate and copy them. |
| Custom tool abstraction | Separate problem. |
| Daemon / background service | Unjustified lifecycle/state/socket complexity. |
| Persistent state API | Portable process-lifetime semantics deferred ([ADR-0002](decisions/0002-invocation-stateless-contract.md)). |
| UI / marketplace / registry | Distribution is separate from compilation. |
| Perfect semantic parity | The capability model exists because parity is impossible. |

## 4. Design principles

| Principle | Consequence |
| --- | --- |
| Semantics over names | Normalize meaning, not vendor event strings. |
| Events ≠ effects | Observing a lifecycle point doesn't imply every control effect. |
| Degradation must be visible | Approximation/emulation recorded and surfaced; nothing silently dropped. |
| Raw data remains accessible | Every event keeps native payload + native identifiers. |
| One native dispatcher per lifecycle point | Hooknostic owns ordering/composition ([ADR-0003](decisions/0003-one-dispatcher-composition.md)). |
| Portable code is invocation-stateless | Module memory is not durable portable state ([ADR-0002](decisions/0002-invocation-stateless-contract.md)). |
| Tolerant readers, strict writers | Decode liberally, preserve unknowns, emit only validated outputs. |
| Reproducible builds | Versions, resolutions, diagnostics captured in the build report. |
| Agent Plugins is a peer | Project its package model; never redefine or mutate it ([ADR-0011](decisions/0011-agent-plugin-native-projection.md)). |

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
| Testkit | Fixtures, fake adapters, and `describeAdapterContract` — the obligations every adapter must meet, as tests a third-party adapter can run. |

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

  // Normalized shell view, present when the adapter's shape table knows this
  // tool's argument keys; absent means uncaptured -- fall back to `input`.
  // commandKey/cwdKey expose the native keys for hand-built replaceInput calls.
  shell?: {
    command: string;
    cwd?: string;
    commandKey: string;
    cwdKey?: string;
  };
}
```

Each adapter derives `shell` from a per-tool **shape table** (`ShellShapes`),
which also drives the inverse: `updateShell` is lowered through the same table,
so the normalized read and the portable write cannot skew (Decision 0007).

The category is best-effort classification for portable matching; `nativeName` and
`event.raw` remain available for intentional harness-specific behavior.

### 6.4 Effect model

Effects are semantic actions a hook asks the harness to perform; they are never assumed
to exist merely because the event exists. Initial family (event-scoped equivalents):

- Block/prevent the pending action — `block(reason)`
- Request/escalate approval — `requestApproval(reason)`
- Replace pending tool input — `replaceInput(input)`
- Rewrite the shell command portably — `updateShell({ command })` (lowered per
  target to a `replaceInput` under the tool's own native key; legal only where
  `event.tool.shell` is defined)
- Add model-visible context — `addContext(text)`
- Replace/redact tool output — `replaceOutput(output)`
- Prevent agent/turn stop — `preventStop(reason)`
- Block continuation after a completed tool event — `blockContinuation(reason)`
- Show the user a message without changing control flow — `notify(message)`

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
turn.stop.notify
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
  project: { root: "." },
  entry: "./src/hooks.ts",

  compatibility: {
    minimum: "emulated",
    onBelowMinimum: "error",
    optionalUnavailable: "info",
  },

  targets: {
    claude:   { version: ">=2.1 <3",  delivery: "package", output: "./dist/claude" },
    codex:    { version: ">=0.153 <1", delivery: "package", output: "./dist/codex" },
    opencode: { version: ">=1.18 <2", delivery: "package",  output: "./dist/opencode" },
  },

  components: {
    root: ".",
    targets: ["claude", "codex"],
    runtimePackage: {
      manifest: "./runtime.package.json",
      lockfile: "./runtime.package-lock.json",
    },
  },
});
```

Version ranges are examples; adapters derive and document tested ranges from real
fixtures and releases. A mode can narrow one: Codex `delivery: "package"` requires
`>=0.153 <1`, where its local hooks build from `>=0.148 <1`, because hook delivery
from an installed plugin is only established from 0.153.

`runtimePackage` is an optional projection input for an agent-plugin component
whose runtime imports npm dependencies. Each projector defines how, or whether,
it can materialize that package. Claude projects the selected npm manifest and
lockfile to its plugin root; see [ADR-0012](decisions/0012-claude-plugin-runtime-dependencies.md).
Because Claude's install skips lifecycle scripts, a lockfile entry declaring
`hasInstallScript` fails the build unless its name appears in the optional
`runtimePackage.allowInstallScripts` — which records the author's judgement that
the package runs without its script, and never causes the script to run.
It is the only route to that root pair: a `package.json` or `package-lock.json`
in the package root or in the Claude client-extension overlay is omitted, since
Claude would install it without the validation `runtimePackage` inputs receive.
The root name is matched case-insensitively, like inventory exclusions. Omitting
a declared overlay file degrades the client-extension component, so it follows
`onUnsupported`: an HN205 error by default, a recorded omission under `"warn"`.

The same reasoning reserves the rest of Claude's native configuration against
the package root. `.mcp.json`, `hooks/hooks.json`, and anything under
`.claude-plugin/` are projector output, merged from the portable components and
the Claude client extension. A package-root file at one of those paths is
neither input, so it is a fatal HN503 rather than being copied there — it would
otherwise become the native overlay without passing the validation the portable
components receive. Move such a file under `com.anthropic.claude-code/` to
declare it as a Claude client extension. Unlike an omitted overlay file this is
not governed by `onUnsupported`: it is a package claiming the projector's own
output paths, not a valid component Claude cannot represent.

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
├── claude/                          ← package and hooks in one plugin
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json
│   └── runtime/hooknostic.mjs
├── codex/                           ← package and hooks in one plugin
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── skills/…
│   ├── hooks.json
│   └── hooknostic/hooknostic.mjs
├── opencode/
│   └── .opencode/plugins/hooknostic.js
└── hooknostic-build.json
```

A target's package and its hooks share one `output`. A projection replaces that
output wholesale, so the projected package is necessarily the harness's hook
channel: Claude reads `hooks/hooks.json`, Codex its native manifest's `hooks`
key, OpenCode the generated module in `.opencode/plugins/`. Core verifies this
rather than trusting it — every compiled hook artifact path must appear in the
returned plan, and a projection that drops one fails the target with HN301. A
projector may rewrite an artifact's contents (Claude merges its own hooks
document into the generated one); dropping the path would install a package that
looks complete and runs nothing, which nothing else in the build would notice.

OpenCode ships local-file mode first; npm-package mode can follow.

### 8.5 Build report

```json
{
  "schemaVersion": 2,
  "hooknosticVersion": "0.1.0",
  "source": "./src/hooks.ts",
  "targets": {
    "claude": {
      "status": "success",
      "adapter": "@hooknostic/adapter-claude@0.1.0",
      "requestedVersion": ">=2.1 <3",
      "capabilities": { "exact": 11, "emulated": 1, "approximate": 0, "unsupported": 0 },
      "projection": {
        "status": "success",
        "copiedFileCount": 4,
        "contentDigest": "sha256:…",
        "components": {
          "agent-plugin.skills": { "support": "exact", "discovered": 1, "emitted": 1, "skipped": 0 }
        },
        "omissions": []
      }
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
version outside adapter data, **HN204** artifact mode unsupported, **HN205** valid Agent
Plugin component unsupported, **HN301** adapter
generation failure, **HN302** output commit failure, **HN401** unsupported effect returned
at runtime, **HN501** invalid configuration, **HN502** bundled CLI entry point,
**HN503** invalid Agent Plugin input, unsafe path, or unmergeable overlay.
**HN103** an effect was truncated or dropped by a runtime budget.

#### HN502 — bundled CLI entry point

A hook source is *bundled*, not executed as a program, so the idiomatic ESM
main-module guard behaves differently than it does in the source tree:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

After bundling, both sides of that comparison name the **generated artifact**,
so a guard that was dormant in the source becomes unconditionally true and its
command-line body runs on every hook dispatch — typically consuming the
harness's stdin before the dispatcher can read the event payload, which
presents as a hook that silently receives nothing.

This only happens where the harness **executes** the artifact. An adapter
declares which it is via `shimExecution`: `"command"` (Claude, Codex — spawned
as `node <artifact>`, so `process.argv[1]` *is* the artifact) or `"module"`
(OpenCode — imported in-process, so `process.argv[1]` stays the harness's own
entry and the guard remains false). Adapters that declare neither are treated
as unknown and never reported.

HN502 is therefore raised once per build, naming the command-executed targets it
affects. Keep the command-line entry point in a module the hook source does not
import, or gate it on an explicit environment variable.

Detection is a bounded regex over the bundle that requires an actual comparison
between `import.meta.url` and `process.argv[1]` — reading both values for
unrelated reasons is not reported. It is a warning, not an error, because no JS
parser is available to the published CLI to make the check structural.

### 9.2 Distinct commands

| Command | Question answered |
| --- | --- |
| `hooknostic check` | Would `build` succeed? Runs analysis, bundling, projection, and artifact validation in memory; writes nothing. |
| `hooknostic build` | Check + stage + atomically commit target artifacts. |
| `hooknostic doctor` | Are installed harness versions detected and within validated ranges? |
| `hooknostic inspect <target>` | Why does this adapter map a capability/event the way it does? |

## 10. Runtime and handler composition

### 10.1 One native hook dispatcher

One native entry point per lifecycle event/matcher group; portable handlers dispatched
internally ([ADR-0003](decisions/0003-one-dispatcher-composition.md)).

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
3. Context additions and notifications accumulate in declaration order, each under
   its own conservative configurable size cap.
4. `block`, `requestApproval`, `preventStop` and `blockContinuation` are terminal;
   `replaceInput`, `replaceOutput`, `updateShell`, `addContext` and `notify` are not. An effect is
   terminal iff applying it makes every later handler's decision unsound
   (ADR-0005, superseding the earlier rules 4-6).
5. Post-tool: output replacements apply immediately.
6. Reserved (folded into rule 4 by ADR-0005).
7. No effect = continue unchanged.
8. First terminal effect in declaration order wins; the runtime records the terminator.

### 10.3 Error and timeout policy

```ts
runtime: {
  onHookError: "continue",     // default for a general SDK
  timeoutMs: 5_000,
  contextCharLimit: 16_000,    // accumulated model-visible context per dispatch
  notifyCharLimit: 2_000,      // accumulated user-visible notification text
}
```

Fail-open by default; security-sensitive users may opt into `onHookError: "block"` only
for events where the adapter can reliably block. The runtime provides an `AbortSignal`
and translates the timeout to native hook timeout settings where possible.

### 10.4 Process lifetime and state

Portable hooks are invocation-stateless
([ADR-0002](decisions/0002-invocation-stateless-contract.md)). v0.1 has no persistence
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
// Illustrative -- a fake harness; real profiles live in
// packages/adapter-*/src/profile.ts and docs/harness-support.md.
const capabilityProfiles = [
  { range: ">=1.0 <1.5", matrix: fooV1Capabilities },
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
event, invokes the same portable runtime, and applies effects by mutating callback output,
throwing, or posting back into the session with `client.session.promptAsync` (the only
channel for stop prevention and notification) per OpenCode semantics. Persistent module memory is never exposed as a
feature.

### 12.4 Capability matrices are adapter-owned

Matrices are built from current docs + verified fixture behavior, with rationale and
source/date metadata for every non-exact mapping. The CLI renders matrices from
adapter-owned facts; this document is not normative truth for any cell.

## 13. Agent Plugins projection

Hooknostic treats Agent Plugins as a peer and read-only source format
([ADR-0011](decisions/0011-agent-plugin-native-projection.md)). The public
`@hooknostic/agent-plugin` package validates Agent Plugins 1.0, inventories its complete
file tree safely, and defines a target-neutral projector contract. Projectors belong to
adapters and carry versioned component support profiles.

```
my-plugin/
├── plugin.json
├── skills/
├── mcp.json
├── hooknostic.config.ts
├── src/hooks.ts
└── dist/claude/
    ├── .claude-plugin/plugin.json
    ├── skills/
    ├── .mcp.json
    └── hooks/hooks.json         # only when hook source is present
```

`entry` is optional for package-only builds. Client-extension directories are consumed
as overlays, never generated beside the source. Valid but unrepresentable components
produce HN205; invalid or unsafe input and unmergeable overlays produce HN503. A target
listed under `components.targets` whose adapter has no projector is an HN205 error
regardless of `onUnsupported`: that policy degrades individual components, never a
whole projection, so a build can never commit an empty package as a success. An invalid
component the loader would skip (a malformed skill or MCP server) is an HN503 error by
default; `onInvalid: "warn"` restores the loader's lenient skip-and-continue.

Inventory is deny-listed, never allow-listed. The loader always omits `.git`,
`node_modules`, `.env`, `.env.*`, and `.npmrc` at any depth; core additionally omits the
config file, the hook `entry`, every target output, the build report, and staging
directories. `components.exclude` globs add to that set and apply before component
discovery: excluding `mcp.json`, a skill directory, or its `SKILL.md` removes that
component, while `plugin.json` cannot be excluded. The build report lists every
inventoried file under `components.sourceFiles`; the source content digest covers
those files' paths, bytes, and modes. Claude
projection retains existing package directories used as portable MCP working
directories, even when they are empty; these appear in the target projection's
`directories` list and content digest. Staging validates their paths and file
collisions before creating them, just as it does for files. Any
non-excluded symlink escaping the package root rejects the package before component
contents are parsed.

## 14. Repository and package structure

pnpm TypeScript monorepo; adapters are internal workspace packages. The SDK, Agent Plugin
loader/contracts, and CLI are published. The published CLI is therefore
self-contained (`packages/cli/scripts/bundle.mjs`): core and the adapters are inlined into
`dist/index.js`; each adapter's runtime shim is prebundled into `dist/shims/<id>.mjs`
(runtime inlined, SDK external — the build aliases `@hooknostic/sdk` to the user project's
copy so an artifact carries exactly one SDK/zod copy); and the emitted declarations import
nothing but `@hooknostic/sdk`. `packages/cli/src/package.test.ts` proves the
registry-install story offline. Publishing `@hooknostic/core` and `@hooknostic/testkit` for
third-party adapters is a post-stabilization step that reuses the SDK's dist pattern.

```
hooknostic/
├── packages/{agent-plugin,sdk,core,runtime,cli,adapter-claude,adapter-codex,adapter-opencode,testkit}/
├── fixtures/{claude,codex,opencode}/
├── examples/{basic,rewrite-shell,context-injection,agent-plugin}/
├── package.json / pnpm-workspace.yaml / tsconfig.json
```

| Package | Public? | Purpose |
| --- | --- | --- |
| `@hooknostic/sdk` | Yes | Authoring API and public types. |
| `@hooknostic/agent-plugin` | Yes | Agent Plugins 1.0 loader, schemas, and projection contracts. |
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

- **M0** Repo + decision records + baseline doc.
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
SDK; OpenCode npm delivery scope; more adapters (Cursor, Gemini CLI, Copilot CLI, Goose,
Qwen Code); fixture recording command; persistent-runtime performance mode; additional
normalized events; formal Agent Plugins proposal.

## 21. Implementation sequence

Prove the semantic compiler before native adapters — never let the first vendor surface
dictate the core abstraction.

| PR | Deliverable | Exit condition |
| --- | --- | --- |
| 1 | Monorepo + decision-record skeleton | Build/test/lint green. |
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
import { definePlugin, hook, block, updateShell, addContext } from "@hooknostic/sdk";

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
        // Normalized read with a raw fallback: where the shape is uncaptured
        // (`shell` undefined), a guard must not fail open on an empty string.
        const raw = (event.tool.input as { command?: unknown }).command;
        const command = event.tool.shell?.command ?? (typeof raw === "string" ? raw : "");
        if (command.includes("rm -rf /")) {
          return block("Refusing destructive root deletion");
        }

        if (
          ctx.capabilities.has("tool.before.input.replace") &&
          event.tool.shell !== undefined &&
          command.startsWith("npm ")
        ) {
          // Portable write-back: the rewrite lands under whichever key this
          // harness uses (`command` on Claude/OpenCode, `cmd` on Codex's
          // exec_command), with every sibling input field preserved.
          return updateShell({ command: command.replace(/^npm /, "pnpm ") });
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
  project: { root: "." },
  entry: "./src/hooks.ts",
  compatibility: { minimum: "emulated", onBelowMinimum: "error", optionalUnavailable: "info" },
  runtime: { onHookError: "continue", timeoutMs: 5_000 },
  targets: {
    claude:   { version: ">=2.1 <3",   delivery: "package", output: "./dist/claude" },
    codex:    { version: ">=0.148 <1", delivery: "project",  output: "./dist/codex" },
    opencode: {
      version: ">=1.18 <2", delivery: "project", output: "./dist/opencode",
      compatibility: { minimum: "approximate", onBelowMinimum: "warn" },
    },
  },
  components: {
    root: ".",
    targets: ["claude"],
    runtimePackage: {
      manifest: "./runtime.package.json",
      lockfile: "./runtime.package-lock.json",
    },
  },
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
- Generated artifact paths are unique POSIX-style relative paths (no absolute paths, no
  `.`/`..`/empty segments, no backslashes); `executable` is honored on POSIX; `compile()`
  and `validateArtifacts()` failures surface as HN301, never as crashes.
- The adapter's shim is prebundled into the CLI (`packages/cli/scripts/bundle.mjs`) and
  routed by `defaultAdapterRegistry()`; the simulated registry-install test passes.
