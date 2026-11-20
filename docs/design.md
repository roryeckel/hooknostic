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
| Primary implementation | Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+ / TypeScript / ESM |
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
| Agent Skills authoring abstraction | Skills define their own portable convention; projectors validate and copy them, rewriting only the `${SKILL_DIR}` token ([ADR-0028](decisions/0028-skill-directory-token.md)) and OpenCode's names (ADR-0021). |
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
  | "model.request.before"
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

`model.request.before` is the one standing exception, and ADR-0016 records why: it is
named for a moment every harness *has* (assembling a request to the model) rather than
for a vendor feature, and only OpenCode currently exposes a hook at it. The alternative
was overloading `session.start`, whose once-per-session contract the channel does not
meet. Treat the exception as narrow: a one-harness event is admissible only when the
moment is universal and no existing event names it honestly.

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

  // Present when the harness exposes the split: parsed from a name that keeps
  // it (Claude, Codex), or stated outside the name (results of pi's own MCP
  // tools, ADR-0032).
  // Absent means fall back to `nativeName` and `raw`.
  mcp?: {
    server?: string;
    tool?: string;
  };

  // Normalized shell view, present when the adapter's shape table knows this
  // tool's argument keys and the input matches them; absent means uncaptured
  // or not matching -- fall back to `input`.
  // commandKey/cwdKey expose the native keys for hand-built replaceInput calls.
  // dialect is the grammar family the command runs in, where the adapter can
  // establish it (ADR-0029); absent means unknown, never POSIX by default.
  shell?: {
    command: string;
    cwd?: string;
    commandKey: string;
    cwdKey?: string;
    dialect?: "posix" | "powershell" | "cmd";
  };

  // Normalized file view (ADR-0026), present when the adapter's file shape
  // table knows this tool: every path the call targets, verbatim, plural
  // because one patch can touch several files. Read-only; absent means
  // uncaptured, not matching, a search or listing tool, or an unparseable
  // patch -- fall back to `input`.
  file?: {
    paths: string[];
    pathKey?: string; // the native argument naming one file
    patchKey?: string; // the native argument holding patch text
  };
}
```

Each adapter derives `shell` from a per-tool **shape table** (`ShellShapes`),
which also drives the inverse: `updateShell` is lowered through the same table,
so the normalized read and the portable write cannot skew (Decision 0007).

The view's `dialect` has two sources and no third (Decision 0029). A shape entry
declares one where the tool itself pins a grammar family, as Claude Code's
`Bash` and `PowerShell` do. Where the host's configuration picks the
interpreter, as on OpenCode, the shim listens for the shell the harness states
and the decoder attaches its family. Where neither exists, as on Codex, the
dialect is absent. An adapter never infers one from the host platform.

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
permission-bypass nuances. A handler may return one effect or an ordered list; a list
means exactly what consecutive handlers returning its elements would, and a terminal
effect must be its last element ([ADR-0025](decisions/0025-effect-lists.md)).

## 7. Capability semantics and compatibility analysis

### 7.1 Capability identifiers

Stable, event-scoped semantic strings:

```
tool.before.observe          tool.after.observe            session.start.observe
tool.before.block            tool.after.output.replace     session.start.context.add
tool.before.requestApproval  tool.after.blockContinuation
tool.before.input.replace                                  context.compact.before.observe
tool.before.context.add                                    context.compact.before.block

session.start.notify

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
    block: "required", // tool.before.block
    "input.replace": "optional", // tool.before.input.replace
  },

  async run(event, ctx) {
    // portable implementation; ctx.capabilities.has("input.replace")
  },
});
```

The map is both the compiler's static capability manifest and the definition of which
effect helpers the hook may return. TypeScript generics make undeclared effects a
compile-time error where practical; runtime validation remains mandatory.

Keys may be written relative to the hook's event (`block`) or as full ids
(`tool.before.block`); `hook()` stores the full id, so the IR, build reports and every
diagnostic print full ids, and declaring one capability under both spellings throws.
`ctx.capabilities.has()`/`level()` accept exactly the declared capabilities, in either
spelling: probing an undeclared one could only ever answer for an effect the hook may
not return, so it is a compile error rather than a silent `false`.

### 7.4 Required versus optional

| Declaration | Meaning | Build behavior |
| --- | --- | --- |
| `required` | Behavior depends on the capability. | Must meet the target's compatibility policy or the target fails. |
| `optional` | Hook can operate without it; feature-detect at runtime. | Never blocks the build; recorded as info/metadata. |

```ts
if (ctx.capabilities.has("input.replace")) {
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
degradation. The same policy applies to every discovered Agent Plugin component, in
package projection and project delivery alike. A supported component below the minimum
is an HN206 at `onBelowMinimum`, and it is still emitted when that is `"warn"`. An
`unsupported` component follows `components.onUnsupported` instead. A deviation
(ADR-0019) is not a level, so this policy never acts on one: `components.onDeviation`
does. Nor is a degradation, an item the projection cannot deliver at its component's
level, which `components.onDegraded` governs (ADR-0022).

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
An adapter may declare a named omission on an unsupported component; accepting
its qualified ID in `components.accept` reports HN205 as information while
retaining unsupported support and skipped counts (ADR-0031). This does not
accept invalid input, missing projectors, or required hook capabilities.

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
hooknostic.config.ts
hooknostic-build.json                   ← the build report, beside the config
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
└── opencode/                           ← delivery: "package"
    ├── package.json          ← exports["./server"]
    ├── index.js             ← the only module OpenCode loads
    ├── hooknostic.js
    ├── hooknostic-agent-plugin.js
    └── package/…
```

A target's package and its hooks share one `output`. A projection replaces that
output wholesale, so the projected package is necessarily the harness's hook
channel: Claude reads `hooks/hooks.json`, Codex its native manifest's `hooks`
key, OpenCode the module its `exports["./server"]` names. Core verifies this
rather than trusting it — every compiled hook artifact path must appear in the
returned plan, and a projection that drops one fails the target with HN301. A
projector may rewrite an artifact's contents (Claude merges its own hooks
document into the generated one); dropping the path would install a package that
looks complete and runs nothing, which nothing else in the build would notice.

OpenCode supports both project-file delivery (`.opencode/plugins/`) and package
delivery (`package.json` plus `exports["./server"]`); the emitted shape follows
`target.delivery`.

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

Schema version 2 also permits `authorExclusions` on package and project target
reports: `patterns` lists the target's configured rules, and `matches` records
source `path`, `status` (`omitted` or `exposed`), and identifiable `component` and
`name`. Exposure records include `nativePath`, `reader`, and `writer` (or
`authored`). These records are separate from unsupported `omissions`. Target
`sourceFiles` lists retained source input; top-level `components.sourceFiles`
remains the aggregate inventory. Target `mcpServers` identifies retained MCP
commands. Project-command JSON includes these target reports. See ADR-0038.

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
Plugin component unsupported, **HN206** Agent Plugin component below the minimum fidelity
(still emitted under `onBelowMinimum: "warn"`), **HN301** adapter
generation failure, **HN302** output commit failure, **HN401** unsupported effect returned
at runtime, **HN501** invalid configuration or hook source, including a config or
hook source that fails while it loads (§10.3), **HN502** bundled CLI entry point,
**HN503** invalid Agent Plugin input, unsafe path, or unmergeable overlay,
**HN504** Yarn Plug'n'Play install outside Yarn's runtime.
A config or hook source that fails to bundle because it imports from
`@hooknostic/sdk` a name that `@hooknostic/sdk/schemas` exports, a schema that
moved there in 0.13.0, gets an HN501 remediation naming the subpath, the import
to write instead, and the upgrade guide. A name missing from the SDK's schemas
entry itself gets none: that import already names the subpath. For a config the
hint replaces the generic remediation, which follows it only when the bundle
failed for another reason too. `check`, `build` and `inspect --config` print it
with the diagnostic. `dispatch`, which bundles the hook source itself, prints the
same text as an indented `Remediation:` line under its `failed to bundle entry`
error (#247).
**HN103** an effect was truncated or dropped by a runtime budget.
**HN104** a declared executable mode cannot apply to a skill the target discovers
in place. **HN105** a declared MCP environment names a server that cannot receive
it -- one `mcp.json` does not declare, or a remote server with no child to
receive a value -- so nothing is forwarded for that name. **HN106** an emitted
Agent Plugin component instance that the target harness treats differently from
the specification. Each is a deviation declared on the adapter's profile, and it
is fatal under `components.onDeviation: "error"` (ADR-0019). **HN107** project
wiring was written into a linked git worktree at a path the harness reads from the
root checkout instead, currently Codex's `.codex/hooks.json`. It is a warning, and
the message names the root checkout (ADR-0015). **HN108** a hook declares an optional
event field (`fields`) that the target produces below exact: an error where the field
is never produced, the `onBelowMinimum` severity where its level is below
`compatibility.minimum`, information otherwise or when accepted by id in
`compatibility.accept` (ADR-0027). **HN109** the zod package the SDK's `zod/v4`
import reaches (the first on its `node_modules` path, whether or not it provides
`zod/v4`) is outside the SDK's `zod` peer range, or has no readable version, so
the runtime bundles Hooknostic's own Zod instead. It is a warning, reported once
per build, and it names the version and path found, the range, and the copy
bundled. It names each Zod's path as HN110 names the SDK's: relative to the
configuration's directory when inside it, and saying so, and absolute
otherwise, as for a CLI installed outside the project, whose own Zod's path
may name a home directory. In a Plug'n'Play project, a Zod served from Yarn's
install, inside a zip archive or behind a virtual folder, is named
`from Yarn's Plug'n'Play install` instead of by its machine-specific cache
path: the project's Zod under Yarn's runtime, and Hooknostic's own under
`yarn hooknostic` (#256). Every other Zod is named by its path, relative or
absolute as above. A project with no reachable Zod gets Hooknostic's copy
without one.
User code that imports Zod still bundles the project's copy (ADR-0040).
**HN110** the CLI running a build and the project's `@hooknostic/sdk` are on
different releases, so the build would mix one release's SDK with another
release's compiler and shims. The CLI's version is the one it stamps into the
build report as `hooknosticVersion`; the SDK's is the `version` in the manifest
of the SDK package the build resolves, the one it bundles. Any difference in
version counts, prereleases included, because the two are released in
lockstep; build metadata (`+local.1`) is ignored, as semver orders it. The
message names the SDK's directory relative to the configuration's directory
when it is inside it, and says so:
`at node_modules/@hooknostic/sdk (relative to the config's directory)`. A
committed build report then names no machine's path. In a Plug'n'Play project,
an SDK served from Yarn's install, inside a zip archive or behind a virtual
folder (`__virtual__`, Yarn 2's `$$virtual`), is named by that install instead:
`@hooknostic/sdk from Yarn's Plug'n'Play install is 0.11.9` (#225). Its path is
unreadable, and usually machine-specific: it runs through `__virtual__` into
Yarn's global cache, whose hash, depth and folder differ by machine. It is a
warning, reported at most once per run, even when the configuration fails to
load, so `check`, `build`, `sync` and `verify` all report it beside a load
failure that the skew may cause, and so does `recover`, which reports it only
beside a load failure.
It never changes an exit code: `check` and `build` print it, and `sync` and
`verify` list it with their other build diagnostics. It is silent when no SDK
resolves, when either version is not valid semver, and in this repository's
workspace, whose examples resolve `packages/sdk` at the CLI's own version. It
is also silent under another install's Plug'n'Play runtime, as under
`yarn dlx` in a Plug'n'Play project: looking up the project's SDK there would
load its runtime beside dlx's and break the build (#216). Add
`hooknostic` to the project's devDependencies at the same version as its
`@hooknostic/sdk`, and run that CLI from the project directory:
`npx hooknostic`, or `pnpm exec hooknostic` in a pnpm project (a project made
by pnpm 12's `pnpm init` names pnpm in `devEngines`, so `npx` refuses to run
there), or `yarn hooknostic` under Yarn Plug'n'Play. Without a local install,
and always under Plug'n'Play, `npx` fetches the registry's latest instead.
Outside Plug'n'Play, `npx` and `pnpm exec` are both named rather than
detecting the package manager.
**HN504** a build under a Yarn Plug'n'Play manifest needs a module from Yarn's
install that this process cannot read, because Hooknostic is running without
Yarn's PnP runtime: under plain `node`, `npx`, a global install or `pnpm dlx`.
esbuild reads Yarn's zip archives itself, but what Hooknostic reads beside a
module -- the SDK's manifest, licence notices -- would come back missing, so
the build fails instead of bundling around it. `yarn dlx` loads a runtime, but
not the project's, so a build that needs Hooknostic's own Zod fails the same
way. It is an error, reported once per build, naming the module and the PnP
manifest, or under `yarn dlx` where Hooknostic's own Zod failed to resolve.
Under `yarn hooknostic` itself, where the CLI is in the project's install, a
failure to resolve Hooknostic's own Zod keeps esbuild's error instead. On
Linux with Node 22, `yarn dlx` sharing Yarn's global cache with the project
fails with HN501 "controlled by multiple pnpapi instances", whatever the Zod
(#190). Run
Hooknostic through Yarn from the project, `yarn hooknostic`, with
`hooknostic` as a devDependency (ADR-0040; supporting the other invocations
is #190).

#### HN502 — bundled CLI entry point

A hook source is *bundled*, not executed as a program, so the idiomatic ESM
main-module guard behaves differently than it does in the source tree:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

After bundling, both sides of that comparison name the **generated artifact**,
so a guard that was dormant in the source becomes unconditionally true and its
command-line body runs on every hook dispatch. A command shim reads the event
payload before it loads the hook source, so the body finds stdin already
consumed. Whatever else it does still runs inside the hook. The command shim's
process guard (§10.3) keeps it from deciding the call. A body that throws
synchronously, or calls `process.exit`, while the hook source loads is reported
as an internal error, and the call proceeds without the hooks. An async
`main()` that rejects, or exits, later is reported once, and the hooks still
decide. Before the guard, both ended the process with a non-zero code and no
reply, and a non-zero exit can block: Copilot's `preToolUse` denies the call on
any, and on Claude Code exit 2 blocks a prompt or a compaction. The body's side
effects still happen on every dispatch, so HN502 still warns.

This only happens where the harness **executes** the artifact. An adapter
declares which it is via `shimExecution`: `"command"` (Claude, Codex, Copilot — spawned
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
| `hooknostic check` | Would `build` succeed? Runs analysis, bundling, projection, and artifact validation in memory; writes no target artifacts. Trusted materializers still run and may use network or persistent caches. |
| `hooknostic build` | Check + stage + atomically commit target artifacts. |
| `hooknostic doctor` | Are installed harness versions detected and within validated ranges? Which hooknostic, project `@hooknostic/sdk` and Node.js versions are these? |
| `hooknostic inspect <target>` | Why does this adapter map a capability/event the way it does? |
| `hooknostic dispatch --target <id>` | What do these hooks decide for this portable event on this target, and what native reply follows? Runs the source in process (ADR-0023). |

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
7. No effect = continue unchanged. A returned list applies element by element under
   rules 1–6, each element validated on its own; a terminal effect before the end of
   the list rejects the whole list as HN401 (ADR-0025).
8. First terminal effect in declaration order wins; the runtime records the terminator.

### 10.3 Error and timeout policy

```ts
runtime: {
  onHookError: "continue",     // default for a general SDK
  timeoutMs: 5_000,
  processAllowanceMs: 5_000,   // build-time: time for the harness to start the process
  contextCharLimit: 16_000,    // accumulated model-visible context per dispatch
  notifyCharLimit: 2_000,      // accumulated user-visible notification text
}
```

Fail-open by default; security-sensitive users may opt into `onHookError: "block"` only
for events where the adapter can reliably block. The runtime provides an `AbortSignal`
and translates the timeout to native hook timeout settings where possible.

Shims also fail open on their own internal errors: a defect in Hooknostic, such as a
rewrite the host object will not take, must not become a block. A deliberate block is
the one exception. The OpenCode shims, where a block is a throw, tell the two apart by
throwing blocks as a dedicated class. Every shim asks its block and decode-error class
checks through the runtime's `isInstance`, which answers false where `instanceof` would
throw, as it does on a revoked proxy.
`onHookError: "block"` governs hook failures only, not internal errors.

Every shim reports what it fails open over, as
`hooknostic internal [<native hook>]: <message>`, with the stack on the following lines
under `HOOKNOSTIC_DEBUG`. The in-process shims (OpenCode v1 and v2, Pi) report through
the runtime's `reportInternalError` on `console.error`. The command shims (Claude Code,
Codex, Copilot) write `formatInternalError` and a newline to stderr, and still exit 0.
The report carries no HN code, because those name problems a hook author can act on,
and it is not deduplicated, like handler errors. Two things are never reported: a
deliberate block, and a payload the decoder says is not ours. The second stays silent,
apart from the command shims' `HOOKNOSTIC_DEBUG` "ignored payload" trace. Best-effort
posts, such as notifications, toasts, permission replies and stop-prevention messages,
keep their own silent catches, as their capability rationales state.

A command shim shares its process with the hook source, so it also guards that process
against code outside any handler (#186). The runtime's `guardCommandShim` is the first
thing each command shim installs, and it stays for the life of the process:

- **Async failures.** `unhandledRejection` and `uncaughtException` listeners report each
  error object once, in the internal-error format, and the shim carries on. Before the decision
  the hooks still decide. After it, nothing more is written to stdout. A rejection that
  `--unhandled-rejections=strict` raises as an uncaught exception first is reported once,
  from the rejection. Node warns against continuing after an uncaught exception; the
  shim continues anyway, because the alternative is an exit the harness may read as a
  block. Each `process.exit` throws a new error, so those are reported once per exit
  code.
- **`process.exit`.** The hook source's `process.exit` throws a `HookSourceExitError`
  (`the hook source called process.exit(<code>)`). At load it is a load error; inside a
  handler it is that handler's error, so `onHookError` applies and an intentional
  `process.exit(2)` no longer blocks on Claude Code. `onHookError: "block"` is the
  portable replacement. Where a throw cannot unwind (inside an `uncaughtException`
  emit, in a `beforeExit` loop, during `exit`, or once the shim finishes), it reports
  synchronously and leaves with the decided code, or 0 before one.
  - The guard learns it is inside an `uncaughtException` emit from
    `uncaughtExceptionMonitor`, which Node emits before every `uncaughtException`
    listener, including one the hook source prepends.
  - It resets that flag with a tick queued from the monitor, ahead of any tick a
    listener queues. So a listener's `process.nextTick(() => process.exit(1))` throws,
    is reported, and the hooks still decide.
  - Before the decision, `beforeExit` means the shim's own await can never settle.
  - An exit whose throw already reached `uncaughtException` and comes again with the
    same code means the hook source is looping on it. That happens with a listener
    that stays registered and exits again on the guard's own error, or with a
    `beforeExit` listener the hook source prepends ahead of the guard's. The second
    call leaves instead of throwing, so the loop ends on its second round.
  - A named `import { exit } from "node:process"` is caught too, because the guard
    syncs the builtin module's exports.

  The shim's own exits use the original function.
- **Exit-code pin.** An `exit` listener sets the exit code to the decided code, or 0
  before one, over a `process.exitCode` the hook source set and over Node's 13 for an
  unsettled top-level await. It is registered twice. One copy stays where the guard
  installed it, ahead of every `exit` listener the hook source adds, so a listener that
  throws, which makes Node skip the listeners after it, cannot skip that one. The other
  moves to the end of the `exit` listeners on every path into an exit the guard sees
  coming: finishing, the stub leaving, and `beforeExit`, which covers a loop that empties
  before the shim finishes, as under a top-level await that never settles. So a hook
  source's listener that resets the code runs before it. The forced exit after finishing
  uses the code decided by the time it fires, so a stray failure after finishing that
  raised it still counts. If that exit throws, because an `exit` listener of the hook
  source's threw, the shim calls it again; Node is leaving by then and skips the
  listeners.
- **Keep the decided exit code.** Each command shim records the decided code as soon as
  `apply` produces it, before it writes the reply. From then on a stray failure keeps
  the decided exit code, so it neither adds a block nor removes one: Claude Code's exit
  2 stays 2. The guard's writer uncorks a stderr a handler left corked, and a report
  starts on a line of its own after a block reason that did not end in a newline.
- **Not necessarily the reply.** An exit that cannot unwind and lands while the reply is
  still flushing leaves at once, with the decided code. So the reply itself can be cut
  short: Claude Code's block reason can be lost while stderr is slow, and on POSIX,
  where pipes are asynchronous, a JSON reply could be truncated. This is not a
  regression; before the guard such an exit ended the process with its own code.

Every shape the guard covers then ends on exit 0 or the decided code, the two exits each
harness's captured evidence covers. The guard targets accidental failures in the hook
source. A hook source that deliberately rearranges Node's process listeners can defeat
it, because the hook source runs as trusted code: Hooknostic is not a sandbox. It does
not cover these:

- `process.reallyExit`, which `signal-exit` wraps and the guard leaves alone;
  `process.kill(process.pid)`; `process.abort()`; or an `exit` listener added after the
  pin last moved to the end, such as one a `beforeExit` listener adds, or one added after
  the shim finishes when the forced exit ends it.
- An `exit` listener that throws while the process leaves from an exit the guard could
  not unwind inside an `uncaughtException` listener: Node exits 7. Elsewhere the pin
  ahead of it still sets the code, and the decided code stands; on a forced exit after
  finishing, the throw goes unreported.
- A listener of the hook source's own on `uncaughtException` or
  `uncaughtExceptionMonitor` that throws, or that exits ahead of the guard. For
  example, `(e) => { throw e }`, or a monitor listener prepended to call
  `process.exit(1)`: Node exits 7.
- `process.setUncaughtExceptionCaptureCallback(...)`, which makes Node skip the
  `uncaughtException` listeners: an uncaught exception is swallowed, with exit 0 and no
  report.
- `process.removeAllListeners("uncaughtException")`, which takes the guard's listeners
  with it: the next uncaught exception crashes the process the way Node does by
  default, with no reply and no report. The exit-code pin, an `exit` listener, still
  exits 0, or the decided code.
- `process.removeAllListeners()` with no argument, which removes the monitor, `beforeExit`
  and `exit` listeners as well. `finish()` restores only the exit-code pin, so an
  uncaught exception before then crashes with Node's own exit code, with no reply and
  no report.
- `process.removeAllListeners("unhandledRejection")` under
  `--unhandled-rejections=warn` or `warn-with-error-code`. Node then prints its own
  warning and raises nothing, so there is no Hooknostic report, and the pin exits 0.
  Under the default and `strict` modes Node raises the rejection as an uncaught
  exception, and the guard reports it from there.
- A line the hook source leaves unterminated on stdout or stderr. The guard tracks only
  what it writes itself, so a report that follows such a line is glued onto it.

The in-process shims leave the process to their host. `hooknostic dispatch` runs the
source in the CLI's own process and guards it (#189):

- It installs the guard once per run, since the guard owns process listeners, before it
  claims stdout. As each event starts it calls `scope()`, so a failure that recurs is
  reported against every event it reaches, and an exit that escaped in one event throws
  again in the next. Each event waits one zero-delay timer before the next starts, so a
  0 ms tail or a microtask rejection is labelled `[event N]`; that label is best effort.
- It decides 1 up front: until every result is written, a process the hook source ends
  is a failure, with some or all result lines missing, since they are written at the end.
  The two pins keep an `exit` listener the hook source added from resetting that 1 or
  skipping it by throwing. One added after the pin last moved can still change it, and
  a throwing one still ends an exit from inside an `uncaughtException` listener with 7,
  as listed above. The run then exits 1 if anything was reported outside a handler, and
  a report after the last result moves a 0 to 1. Dispatch's own 2 takes precedence, and
  handler errors stay 0. If dispatch itself throws, the CLI still releases stdout and
  finishes with 2, so a leaked handle cannot hold it open. A run that ends early skips dispatch's own cleanup, so the CLI also
  removes the staged hooks' temp directory from an `exit` listener.
- On a module target, whose shim does not intercept `process.exit`, the guard's `onExit`
  queues each exit code once per event. If the guard reports that exit, its line gets a
  note that the adapter's shim does not intercept it; otherwise the note gets its own
  line at the end of the event. Either way the run exits 1, and one exit is never two
  lines.
- A load that never settles is a load failure, and the run exits 2 with no results
  (#201). The config loads in a window, as for the other commands below: a
  `process.exit`, a rejection or a timer throw while it loads, or an event loop that
  empties under it, is its **HN501**, with the config's wording, and its staged
  directory is removed from an `exit` listener too. Every load of the hook source,
  including the fresh instance a command target takes for each event, gets a stall
  check only: a `beforeExit` listener that fails it as `failed to dispatch through
  entry <entry>: its top-level await never settles`, or `its default export is a
  thenable that never settles`. There is no window around the hook source, so a
  rejection or a timer throw while it loads stays a stray labelled `[event N]`, as
  above.
- `--unguarded` skips the guard and keeps the earlier behaviour. Only the
  `hooknostic` command installs it, claims stdout, removes staged hooks from an
  `exit` listener, or forces an exit. `dispatchEvents()` and the exported `runCli`,
  with or without an injected `io`, never do: they share the caller's process.

Every other command that evaluates the config or the hook source in the CLI's own
process (`check`, `build`, `sync`, `verify`, `recover`, `doctor`, and `inspect
--config`) runs that evaluation under the same guard (#193):

- It installs the guard on the first evaluation and keeps it for the life of the
  process. A command that evaluates nothing runs as before.
- Each load is a window: the `import()`, adopting the default export, and one
  zero-delay timer, so a microtask rejection or a 0 ms tail belongs to it. Each
  window starts with `scope()`, so an exit code that escaped earlier throws again
  there.
- A `process.exit`, a rejection or a timer throw inside a window fails that load,
  and so does an event loop that empties under it. The command reports it as
  **HN501**: `failed to load config|entry <path>: <message>`. A config's exit reads
  `the config called process.exit(<code>)`; the entry's keeps the runtime's
  `the hook source called process.exit(<code>)`. A load that can never settle
  reads `its top-level await never settles` or `its default export is a thenable
  that never settles`. The command exits 2.
- A throw while reading the entry's default export, from a getter or a proxy, is
  HN501 as well: `invalid plugin source: reading the default export threw:
  <message>`.
- The guard decides 2 up front: until the command finishes, a process that user
  code ends is a failure. An exit the guard cannot unwind, such as one from the
  source's own `uncaughtException` listener, leaves with 2 and a `hooknostic
  internal` line.
- A failure outside every window is a stray. It is reported as a `hooknostic
  internal` line, with its stack under `HOOKNOSTIC_DEBUG`, and the exit code
  becomes at least 2, so verify's drift exit of 1 becomes 2.
- The command leaves through the guard's `finish`, after flushing stdout and
  stderr, so a handle that user code leaked cannot hold it open. A consumer that
  closes stdout early does not fail the command. A run that ends early skips the
  load's own cleanup, so the CLI also removes each staged module's temp directory
  from an `exit` listener.

The limits:

- A stray does not hold back what the command writes. `build` or `sync` may
  already have written its output by the time a stray fails the command.
- Attribution is best effort. A failure after the window's zero-delay timer is a
  stray, even if the load scheduled it, and one inside a window is that load's,
  even if a module loaded earlier scheduled it. Two failures inside a window are
  strays instead: a second one in a window whose load already failed, and a
  rejection that comes before a synchronous throw from the same module
  (`Promise.reject(a); throw b`), since a load whose `import()` itself rejects
  gets no zero-delay drain. Either way the command exits 2.
- A stray is not attributed to a module, so one that the config's own
  `process.exit` causes keeps the runtime's wording, `hooknostic internal: the
  hook source called process.exit(<code>)`. Only a load failure names the config.
- A load that never settles while a handle it leaked keeps the loop alive still
  hangs, under `dispatch` too: the loop never empties, so there is no stall to
  detect. A load removes its staged module once its import resolves, so a run
  killed while it waits on a thenable default export leaves nothing behind. One
  killed before its import resolves, as under a top-level `await` that never
  settles, keeps its staged directory: a kill runs no `exit` listener.
- Only the `hooknostic` command installs the guard. `buildProject()`,
  `runProject()`, `loadConfig()`, the `run*` command functions, `dispatchEvents()`
  and the exported `runCli`, with or without an injected `io`, never do, and never
  replace `process.exit`, add process listeners, take over stdout, or force an
  exit. User code they evaluate runs in the caller's process as any module it
  imports would: a `process.exit` there ends the caller's process, and a handle it
  leaks keeps it alive.

Each native deadline is `ceil((sum of the event's handler budgets + processAllowanceMs) / 1000)`
seconds: the handler budgets bound what the dispatcher runs, and the allowance covers what
is not a handler — process start, stdin, decode and stdout flush. A harness that caps an
event's timeout gets as much of the allowance as fits, never less than zero, so only the
handler budgets themselves can make a build refuse (ADR-0039). The allowance is build-time;
the bundled dispatcher does not read it.

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
throwing, or posting back into the session (v1 `client.session.promptAsync`, v2
`session.synthetic`: the only channel for stop prevention and notification) per OpenCode semantics. Persistent module memory is never exposed as a
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
default; `onInvalid: "warn"` restores the loader's lenient skip-and-continue. An emitted
component the harness treats differently from the specification is an HN106 deviation:
a warning by default, and fatal under `onDeviation: "error"`. Nothing is omitted either
way (ADR-0019). An emitted item the projection cannot translate, such as an OpenCode skill
it cannot name for its plugin, or a skill whose text keeps a reference the target shows
the model as written (ADR-0028), is an HN101 degradation: fatal by default, and a warning
under `onDegraded: "warn"`. Any deviation or degradation id listed in `components.accept`
ships whatever the policy says, and is still reported, as information (ADR-0022).

A skill's optional `metadata["hooknostic/allow-implicit-invocation"]` accepts only
the strings `"true"` and `"false"`. It normalizes to `SkillPolicy.allowImplicitInvocation`
on both source records and introduces the separate component capability
`agent-plugin.skills.invocation-policy`. Canonical policy projects after native
overlays; absence preserves authored native behavior. An unavailable gate fails,
or the whole skill is omitted under `onUnsupported: "warn"`. Named acceptance of
`<adapter>:skill-implicit-invocation-unenforced` permits ungated emission with an
informational HN101 and the actual support level retained. In-place authored
sources require the separate `<adapter>:skill-policy-in-place` acceptance to be
left unchanged. Neither acceptance relaxes other shortfalls or ownership checks.
Invalid portable policy remains fatal under `onInvalid: "warn"`. Shared native
destinations compose all readers' edits and omissions before emission (ADR-0030).

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
(runtime inlined, SDK root and `/schemas` external — the build aliases both to the user
project's copy so an artifact carries exactly one SDK/zod copy, the SDK's schemas taking
Zod from the project when it installs one in the SDK's peer range and from the CLI's own dependency otherwise,
[ADR-0040](decisions/0040-sdk-schemas-subpath.md)); and the emitted declarations import
nothing but `@hooknostic/sdk`. `packages/cli/src/package.test.ts` proves the
registry-install story offline. Publishing `@hooknostic/core` and `@hooknostic/testkit` for
third-party adapters is a post-stabilization step that reuses the SDK's dist pattern.

The SDK has two entries. The root, `@hooknostic/sdk`, is the authoring API and
canonical types in plain TypeScript; it loads no Zod at runtime and names none in its
declarations, so authors install no Zod. `@hooknostic/sdk/schemas` holds the Zod 4
runtime schemas and needs the SDK's `zod` peer.

```
hooknostic/
├── packages/{agent-plugin,sdk,core,runtime,cli,adapter-claude,adapter-codex,adapter-opencode,testkit}/
├── fixtures/{claude,codex,opencode}/
├── examples/{basic,rewrite-shell,context-injection,agent-plugin}/
├── package.json / pnpm-workspace.yaml / tsconfig.json
```

| Package | Public? | Purpose |
| --- | --- | --- |
| `@hooknostic/sdk` | Yes | Authoring API and public types; Zod runtime schemas at `@hooknostic/sdk/schemas`. |
| `@hooknostic/agent-plugin` | Yes | Agent Plugins 1.0 loader, schemas, and projection contracts. |
| `hooknostic` | Yes | CLI binary. |
| `@hooknostic/core` | Not initially | Compiler/IR/capability analysis. |
| `@hooknostic/runtime` | Not initially | Dispatcher/runtime. |
| `@hooknostic/adapter-*` | Not initially | Harness adapters. |
| `@hooknostic/testkit` | Maybe later | For external adapter authors post-stabilization. |

**Build technology:** Node `^22.22.2 || ^24.15.0 || >=26.0.0`, TypeScript, ESM; pnpm workspaces; esbuild for the
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

The package version has one carrier in the CLI, `HOOKNOSTIC_VERSION`, which
`set-versions.mjs` rewrites and `versions.test.ts` pins to the CLI's manifest. It is
what `hooknostic --version` prints, alone, what HN110 calls "this hooknostic", and the
build report's `hooknosticVersion`. `doctor` reports it beside the project's
`@hooknostic/sdk` version, looked up from the config's directory, as HN110 does (and,
like HN110, never under another install's Plug'n'Play runtime), and Node.js's (#246).

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
      // Relative keys: "block" is tool.before.block, the id reports print.
      capabilities: { block: "required", "input.replace": "optional" },
      run({ tool }, ctx) {
        // Undefined for an uncaptured shape or an input that does not match
        // it; a guard refuses what it cannot read. Past this line tool.shell
        // is defined, which is also what makes updateShell legal below.
        const command = tool.shell?.command;
        if (command === undefined) return block(`Unrecognized ${tool.nativeName} input`);
        if (command.includes("rm -rf /")) {
          return block("Refusing destructive root deletion");
        }

        if (ctx.capabilities.has("input.replace") && command.startsWith("npm ")) {
          // Portable write-back: the rewrite lands under whichever key this
          // harness's captured shape names, with every sibling input field
          // (OpenCode v2's `workdir`, say) preserved.
          return updateShell({ command: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),

    hook("session.start", {
      id: "repo-context",
      capabilities: { "context.add": "optional" },
      run(event, ctx) {
        if (!ctx.capabilities.has("context.add")) return;
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
