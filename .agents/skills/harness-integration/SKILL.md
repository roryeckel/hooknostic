---
name: harness-integration
description: Plan and land complete support for a new coding-agent harness, or a new delivery surface for one. Use when adding or auditing support for Cursor, Gemini CLI, Goose, GitHub Copilot CLI, or any other agent CLI; when creating `packages/adapter-<id>/`, `fixtures/<harness>/`, `.capture/<harness>/`, an adapter profile, a shim, an Agent Plugin projector, a project integrator, or a harness-watch lane; or when an adapter must grow hooks, skills, MCP, package/project delivery, playback, drift, or generated docs. Also use when a harness reads another harness's files (a compatibility mode: Copilot loading `.claude/settings.json` hooks, `.claude/skills` or a root `.mcp.json`), when one target's output runs under another harness, or when changing where a project integration writes. Start with `docs/adding-an-adapter.md` and the `harness-capture` skill; this skill is the planning, coverage, and completeness layer.
---

# Harness integration

Support is a matrix of evidence-backed answers, not a compiling adapter. A
harness is integrated when every surface it exposes is either implemented and
proven, or explicitly declined with a reason and a provenance record. "It
builds" and "the docs say so" are not completion criteria.

This skill is the orchestration and completeness layer. The implementation
mechanics live in `docs/adding-an-adapter.md`; capture technique lives in
`.agents/skills/harness-capture/SKILL.md`; vocabulary changes live in
`.agents/skills/extend-vocabulary/SKILL.md`.

## Required context

Read before planning:

- `AGENTS.md` and `CONTRIBUTING.md` — hard rules, scope, verification discipline.
- `docs/adding-an-adapter.md` — the authoritative adapter workflow.
- `docs/design.md` Appendix C — the definition of done.
- `docs/testing.md` — fixture replay, real-harness playback, pty and smoke layers.
- `docs/harness-watch.md` — scheduled verification, drift, record, merge lanes.
- Relevant ADRs in `docs/decisions/`: 0007 (tool shapes), 0008 (version facts),
  0009 (rolling playback record), 0010 (scenario coverage), 0011 (Agent Plugin
  projection), 0019 (deviations), 0020 (plugin root), 0021 (degradations),
  0022 (shortfall policy), 0026 (file shapes), 0027 (optional fields),
  0028 (skill directory), 0029 (shell dialect), 0030 (skill invocation policy),
  0031 (named omissions), 0032 (MCP identity).

## Phase 0 — Plan the integration

Build a surface matrix before writing code. The plan is a list of questions and
the evidence that will answer each one, not a list of files.

### Choose the reference truth

- Pick the harness id, binary or npm package, reference build, and fixture
  directory name. Record them in `harness.ts`; every test and range derives from
  that metadata.
- If an older release is known broken, set the recommended range to the proven
  boundary and propagate it to capability and projector profiles. Narrowing one
  component while another still claims the broken range ships silent failures.
- Record the platform matrix. A Windows-only capture does not establish Linux
  shell behavior, and a headless capture does not establish an interactive
  path. Plan a container or a second host where the harness ships one.
- Decide the delivery modes: package, project, or both. A harness can have a
  working package route and no project route, or the reverse. Do not assume one
  from the other.
- Decide whether the harness has a plugin/Agent Plugins format, an in-process
  extension model, or only command hooks. This determines the shim shape.

### Surface inventory

Copy this into the plan and fill every row with `capture`, `declined`, or `not
applicable`. A blank row is an unowned risk.

| Surface | Questions to answer | Evidence |
| --- | --- | --- |
| Process model | Command hook, in-process callback, imported module, long-lived server? What invokes it; what is stdin/stdout/argv; what is the timeout and failure mode? | Live harness session |
| Hook envelope | Event names in every spelling; session/cwd/timestamp/correlation fields; does the payload name its event? | Captured payload |
| Lifecycle | Session start/end, resume, source, model, cwd, worktree, trust, folder-open behavior | Passive capture |
| Prompt | User prompt before/after transformation, output channels, block/context delivery | Passive + effect capture |
| Tool before/after | Native names, argument keys, result shapes, errors, parallel/background calls, MCP names | Tool-shape capture |
| Effects | Block/deny, ask/approval, input rewrite, output rewrite, context injection, stop prevention, notification, session context | One effect-proof per channel |
| Shell | Every shell tool advertised on each host; command/cwd keys; interpreter identity and dialect | Payload + process identity |
| File tools | Read/write/edit/patch/search shapes; path key or patch grammar; read-side limits | Captured tool calls |
| Skills | Project and personal discovery; package discovery; body/path expansion; frontmatter; explicit vs implicit invocation; native gate true/false; plugin namespace; in-place sources | Interactive TUI + `-p` controls |
| MCP | stdio, Streamable HTTP, SSE; command/args/env/cwd; remote headers; placeholder expansion; startup; tool identity; runtime dependencies | Project and package probes |
| Agent Plugins/plugin | Manifest, namespace, hooks, commands, agents, rules, LSP, client extensions, runtime package, load/install/copy semantics, package root, authored files | Package install/load |
| Project integration | Hook file path, skill destination, MCP file, ownership/relocation, components-only projects, linked worktrees, root-checkout quirks | `sync`/`verify` on a scratch project |
| Foreign reads | Which other harnesses' project files does this harness load (hooks, skills, MCP, instructions), and in what form? Which other harnesses read this target's output? Is there an opt-out both sides honour? | A marker per location, both directions (ADR-0033) |
| Packaging | Output paths, artifact modes, runtime bundle, shim execution, npm name/publish, dependency install | Generated artifact + install |
| Detection | Binary name, version command, PATH/PATHEXT behavior, doctor output | `doctor` on each host |
| Automation | Playback driver, pty driver, MCP driver, compaction/subagent scenarios, drift driver, harness-watch lane | CI + local runs |
| Documentation | Baseline, capture record, fixture provenance, generated support page, installation/project/testing/watch docs | Review |

### Budget the probe effort

A one-session capture is not a harness integration. Plan for at least these
independent probes; combine only where one session genuinely decides several
questions:

1. A passive lifecycle session with every event wired to a tee, both native
   spellings where the harness accepts both.
2. A tool-shape session per advertised tool family, including a failure path and
   an MCP call.
3. One effect-proof per write channel: block/deny, input rewrite, output
   rewrite, context injection, stop prevention, notification, session context.
   Prove by a marker or a model-visible token, not by "no error".
4. One shell-dialect probe per host configuration that could change the
   interpreter, observed from the process that actually ran.
5. A skill-policy probe with gated, ungated, explicit-true and explicit-false
   controls; interactive slash invocation and headless prompt mode; project and
   package routes; in-place and owned sources.
6. MCP probes for every transport and both delivery routes, including
   placeholders, environment/header expansion, cwd and identity.
7. One package install/load and one project `sync`/`verify`, including a
   components-only build.
8. Negative controls: untrusted project, missing file, non-zero hook exit,
   unsupported flag, unsupported transport.
9. A foreign-read probe: put another harness's generated project output (for
   example Claude's `.claude/settings.json` hooks) in a scratch project and
   observe whether this harness runs it, and the reverse.
10. A version-boundary probe. Capture the exact build that supports a claim; do
   not extend the claim to older builds without evidence.

Use the cheapest transport that can decide the question. Loopback playback is
deterministic and free for tool calls; a pty is required when the harness has a
separate interactive path; a real model is justified only when model behavior
is the question. A structured session log is stronger than a terminal screen:
a prompt can echo a token, and a model can read a file directly. Assert the
structured event that proves the effect.

## Phase 1 — Capture reality

Follow `harness-capture` for the mechanics and provenance. The integration-level
rules:

- Label provenance with the repository's ladder (`captured`, `live-probe`,
  `router-log`, `schema-derived`, `type-derived`, `doc-derived`). Weaker evidence
  is allowed only when it is named; never let a constructed or doc-derived shape
  look captured.
- Capture the harness, not the documentation. The existing adapters found
  documented shapes that the binaries did not honor; docs are a hypothesis.
- Keep raw captures under ignored `captured/`; commit the drive scripts,
  redacted fixtures, and a README that records question, method, observation,
  consequence, and limits.
- Capture both a positive and a negative control for every semantic claim.
  "Gated skill" needs an ungated control; "explicit allow" needs an absent or
  false control; "block" needs an allowed call.
- Distinguish the model-facing tool from explicit user invocation. A `-p`
  prompt naming `/skill` is not an interactive slash command; a `skill()` call
  is not a user invocation. Use a pty for the interactive path and read the
  session event log for `skill.invoked`/tool-call results.
- Do not infer a shell dialect from the platform, a tool name, or a payload.
  Observe the process that ran.
- Do not infer MCP identity from a separator if either segment may contain that
  separator, and do not split a lossy name. Use a stated identity or leave it
  absent.
- Capture declined surfaces too. An event with no portable meaning gets an
  explicit declined input record and a sentence saying why; it is evidence of a
  deliberate omission, not missing work.
- Record a `validatedOn` record for every claim: exact version, date, method,
  evidence path, and what the session established. A capture that skips this is
  invisible to `inspect`, `doctor`, the generated support page, and the contract
  suite.
- No credential belongs in a capture. Use an isolated home and a disposable
  scratch project; redact the capturing account path to `user` before committing
  fixtures. Keep raw protocol traffic under ignored `captured/`.
- An event you cannot induce is **unmeasured**, not supported. Record the failed
  procedure and do not advertise the event or add a capability cell until a real
  payload exists. A decoder branch without a fixture is a latent path, not
  evidence.
- If a stop/prevent hook can loop without the documented guard, capture the
  guard behavior and rate the cell `approximate` with the observed loop bound.
  Do not infer a guard from the docs.

## Phase 2 — Decide support honestly

- Rate every capability and optional field. Absence means `unsupported`.
- `exact` — the native mechanism matches the portable contract.
- `emulated` — Hooknostic supplies the behavior the harness lacks, faithfully.
- `approximate` — a useful native mechanism exists but its semantics differ.
- `unsupported` — no honest translation; name the omission and the evidence.
- Non-exact cells need a rationale. A partial mechanism is not silently
  promoted; an unsupported cell with an honest reason is worth more than an
  optimistic emulation.
- Use a **deviation** when the harness departs from the specification for some
  instances, a **degradation** when the projection cannot apply its own
  translation to some items, and a **named omission** when the component cannot
  reach the harness at all. Declare each with evidence from the profile.
- Split profiles at the version where the evidence changes. Anchor the split to
  the validation record, **not** `referenceVersion`: advancing the harness
  metadata must not silently invalidate the build that was captured. A broad
  target range resolves to the least-capable intersection; state that users may
  need to narrow a range to keep a gate.
- Every advertised event needs a fixture; every fixture needs an advertised
  event. Every field a canonical fixture carries needs a rating, and every
  rating needs a fixture. Every capability cell needs a scenario. Every shell
  or file shape needs a fixture.
- For skill invocation policy, decide all of: implicit selection, explicit
  native invocation, interactive vs headless, package namespace, in-place
  sources, and the native allow/deny field. `false` must withhold implicit
  selection **and** retain explicit user invocation; if a native flag does only
  one half, approximate or unsupported is the honest rating. Name the acceptance
  id for the shortfall. If a broad version range is not covered, keep the older
  range unsupported rather than inheriting a newer claim.

## Phase 3 — Build every surface

Work through the adapter contract in `docs/adding-an-adapter.md`. The
integration-specific checklist:

### Core adapter

- `harness.ts`: display name, recommended range, fixture directory, reference
  version.
- `profile.ts`: fields, capability matrix, rationale, validation records,
  version splits, deviations/degradations/omissions.
- `decode.ts`: tolerant reader, raw payload preserved, both native spellings,
  no invented correlation ids, `DecodeError` for unmapped events.
- `apply.ts`: strict writer; preserve native block distinctions and terminal
  precedence; do not lower to a channel the harness ignores.
- `toolmap.ts`: captured shell and file shapes only; a `ToolKind` entry for
  every advertised tool; no guessed keys.
- `shellCodec` / `fileCodec` / `classifyTool`: one table drives both directions;
  pass the codecs into `dispatch()` so rewrites do not leave a stale view;
  declare `shellDialect` and `mcpIdentity` with the evidence that supports them.
- `generate.ts` / `shim.ts`: command or module execution, argv/stdin/stdout,
  timeout, fail-open behavior, `shimEntry`, `shimAliases`, `shimExecution`.
  Shim value imports stay on SDK/runtime; never value-import core.
- `detect()`: `detectCommandVersion` for PATH/PATHEXT-safe version lookup.
- `validateArtifacts()`: final-tree validation; throw means HN301, never a crash.
- `hookRuntimePath()` and the projector's `packageRoot`: agree with the actual
  output; the contract suite checks it.

### Project delivery

- `projectPaths`, `projectIntegration`, `projectComponents`,
  `projectComponentProfiles`.
- Hook file location, skill destination, MCP file, generated file ownership,
  relocation/relinquish behavior, components-only projects, linked worktrees,
  root-checkout paths.
- `skillInvocationPolicy`: destination, alternate discovery directories, native
  file projector, in-place detection, shared-directory composition.
- Canonicalize symlink/junction paths before deciding whether a skill is in
  place. A source inside a native discovery directory is authored input: leave
  it untouched and report `skill-policy-in-place`; never copy it onto itself or
  claim its gate. A shared destination composes every reader's edits and
  omissions, including readers whose `components.targets` excluded them.
- Test `sync`, `verify`, components-only, authored files, and an existing copy.
- Fence every foreign read (ADR-0033). A harness runs only its own target's
  output: opt the reader out of another target's location with a mechanism
  captured on both harnesses, or write somewhere it does not read, and pin it
  with a cross-adapter test against the reader's captured rules. Never treat a
  compatibility read as a delivery route. A shared standard location every
  reader treats as its own (`.agents/skills`) is composed instead (ADR-0030).

### Package / Agent Plugin projection

- `namespace`, `packageRoot`, profiles, `project`, `summary.components`,
  `copiedPaths`, authored-hook merge, runtime package, artifact validation.
- Carry every hook artifact through; a projection replaces the output.
- Emit the harness's native format, not a portable document beside its
  replacement.
- Preserve authored hooks/commands/agents/rules/extensions; merge them when the
  harness reads one document; error on a runtime-path collision.
- Re-probe placeholders, package roots, data directories, install/copy semantics,
  and remote headers on the package route; a project fact is not package
  evidence.
- Apply skill policy after native overlays; preserve unrelated YAML, comments,
  modes and body bytes; leave in-place sources untouched and report it.
- `unsupported` means the component must not reach the harness, not merely that
  it will be ignored. Drop it and record the omission.

### Registration and automation

- Register the adapter in `defaultAdapterRegistry()`.
- Add the shim to `SHIMS` in `packages/cli/scripts/bundle.mjs`.
- Add the adapter to `SUBJECTS` in `packages/cli/src/coverage.test.ts`.
- Add the harness lane to `scripts/harness-lanes.mjs`, the harness-watch workflow
  matrix/install/bootstrap cases, the playback driver, the drift driver, and
  expected variants. Keep the default lane free and model-free; a paid/LLM path
  is opt-in and must say what it establishes.
- Add `HOOKNOSTIC_PLAYBACK=<id>` scenarios for lifecycle, effects, MCP, pty,
  compaction/subagent where applicable, and the package/project install. Use
  `HOOKNOSTIC_PLAYBACK_VERSION` to verify a newer build without moving the
  reference.
- Add an opt-in `HOOKNOSTIC_SMOKE=<id>` test that proves one blocking and one
  mutating effect with a real model; never run it in normal CI.
- Update `docs/harness-watch.md` with the lane's cost and any install/bootstrap
  quirk.
- Automated watch records playback; it never moves `referenceVersion`,
  `recommendedRange`, `fixtureDir`, or a profile range. Range extension is a
  human decision backed by a real capture.

## Phase 4 — Verify like the claim is false

- Fixture decode/canonical/apply/golden round-trip.
- Generation determinism, artifact validation, detection and package tests.
- `describeAdapterContract`: events, fields, capabilities, shapes, scenarios,
  profile metadata, provenance evidence.
- Project `sync`/`verify`, package projection, skill policy, MCP identity.
- Real-harness playback with loopback: artifact discovery, block/rewrite
  markers, lifecycle, context, MCP, pty, package/project. A skipped scenario is
  inconclusive, not passing coverage.
- Drift playback against committed fixture shapes.
- Mutation-verify every new test: revert the fix or apply a mutant, watch the
  test fail, restore. This repository has shipped tests that passed against
  their own defect.
- Full gates with explicit exit codes: `pnpm lint`, `pnpm format:check`,
  `pnpm build`, `pnpm test`, `HOOKNOSTIC_PLAYBACK=<id> pnpm test`,
  `node scripts/check-version-literals.mjs`.
- Run `HOOKNOSTIC_SMOKE=<id>` only when the owner asks: it spends model credits
  and can create harness trust entries. A green smoke run is evidence, not a
  substitute for the free playback lane.
- Rebuild committed example artifacts from the repository root if any source
  affects them; otherwise state they are unaffected.
- Regenerate `docs/harness-support.md` from the registry, never hand-edit it.

## Phase 5 — Document and review

- Baseline: the verified native surface and its sources.
- Capture README: questions, method, observations, declined inputs, limits.
- Fixture README: provenance per case and the redaction note.
- Generated support page: regenerated.
- Installation, project-integration, testing and harness-watch docs: update the
  new harness's commands and limits.
- ADRs: write or extend one only for a semantic-model, distribution or
  normalization decision. Do not hide a policy change in code.
- Review the diff independently. Fix concrete findings, re-run the gates, and
  repeat until the remaining findings are explicitly accepted. A clean review
  is not a substitute for a capture.

## Definition of done

Do not call the integration complete until all of these are true:

- [ ] Every advertised event has a captured fixture; every fixture maps to an
      advertised event; declined events are recorded.
- [ ] Every field and capability is rated; non-exact cells have rationale and
      evidence; every cell maps to a scenario.
- [ ] Every shell/file shape entry has a captured fixture; a tool without
      evidence stays absent from the table. MCP identity is stated or absent.
- [ ] Every advertised write/block/context/stop/notify channel is proven by
      effect, with negative controls and terminal precedence.
- [ ] Every foreign read is probed in both directions and fenced or reported
      (ADR-0033); no target's output runs under another harness.
- [ ] Both delivery routes, components-only, authored files, runtime paths and
      package/project install are tested, explicitly unsupported, or not
      applicable with a reason.
- [ ] Skill policy is decided for implicit, explicit, interactive, headless,
      package, project and in-place paths; acceptance ids name every shortfall.
- [ ] Version splits are anchored to validation records; a broad range's
      least-capable behavior is documented; `validatedOn` records exist.
- [ ] Playback, drift, harness-watch and smoke coverage are wired; a skipped
      scenario is marked inconclusive, not counted as evidence.
- [ ] Full gates pass with their own exit codes; generated docs and examples are
      rebuilt; no generated file was hand-edited.
- [ ] No downstream consumer is named; nothing is published; local distribution
      remains `pnpm pack`.

## Failure modes worth re-reading

- **Docs are not the binary.** Every shipped adapter found a documented shape
  the harness did not honor. Capture before implementing.
- **`-p` is not interactive.** A prompt naming `/skill` is text; the model-facing
  `skill()` tool is not user invocation. Use a pty and session logs for the
  interactive path. The same split applies to permission prompts: a headless
  session cannot ask a user.
- **A native flag may enforce half a policy.** Capture explicit true/false and
  implicit behavior separately; rate the half that is missing.
- **The harness may report success for a skipped hook.** A missing error is not
  evidence; observe the marker, rewrite, context injection, or model-visible
  token.
- **A prompt can echo the answer.** A terminal token check can pass without
  loading the skill. Assert `skill.invoked`, a transformed skill-context
  message, a tool-call result, or a marker file.
- **A boundary tied to `referenceVersion` moves when metadata advances.**
  Anchor a support split to the validation record that proved it.
- **A known-broken older release is a range boundary.** Narrow the harness
  range, capability profiles and projector profiles together; a package that
  installs hooks which silently never run is worse than an honest unsupported
  target.
- **A package skill may be namespaced in the slash picker.** Capture the real
  command, not the project skill name.
- **A projection replaces the output.** Carry every hook artifact and merge
  authored files; do not silently drop hooks or commands.
- **A live plugin loader may copy nothing.** A package runtime dependency does not
  appear by itself; bundle it or state the limitation.
- **Harnesses read each other's files.** Copilot ran Claude's generated
  `.claude/settings.json` hook as a bare `node` and failed closed on every
  shell call, in any project with Claude hooks. A target's tests pass alone;
  probe the other harnesses in the same project.
- **Placeholders differ by route.** A project MCP fact is not package evidence;
  expansion in args, env, cwd and headers must be captured per route.
- **Windows detection is PATHEXT, not `spawn`.** Use `detectCommandVersion`.
- **Shims must not value-import core.** It drags esbuild into every artifact.
- **A profile is a `Partial` record.** A typo in a capability id silently rates
  nothing; the contract suite is the guard.
- **Generated output is byte-gated.** Rebuild docs and examples from the repo
  root; never hand-edit them.
