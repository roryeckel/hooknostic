# Model-free harness playback

Procedure and provenance for `packages/cli/test/harness-playback.test.ts`.

## Question

Can an exact reference harness discover a generated Hooknostic artifact and
honour shell rewrites and blocks without sending a request to a paid model?

## Provenance boundary

The playback transport is **constructed**, not captured. The test points the
harness at a loopback HTTP server, inspects the tool declarations in each live
model request, and emits a minimal scripted response in the configured protocol.
The Anthropic Messages, OpenAI Responses, and OpenAI-compatible Chat streaming
envelopes in `packages/cli/test/harness-playback.ts` are test inputs assembled
for this procedure. They are not verbatim harness payload fixtures and do not
upgrade any fixture or adapter claim to captured provenance.

The request-side `tools` declaration is observed live during each run but is not
committed as a capture. The playback code accepts the protocol variants it needs
to locate a shell-like tool and its `command` or `cmd` property. Those defensive
branches describe what the test server can consume; they are not additions to an
adapter's hook-boundary `ShellShapes` table. In particular, a Codex model-router
shape must not be treated as evidence for the translated payload delivered to a
Codex hook.

## Method

For one harness at a time, CI:

1. Derives the exact npm version from the adapter's
   `harness.referenceVersion` and installs that build.
2. Bundles the SDK and CLI, then generates a production-format artifact in a
   scratch project.
3. Replays the committed native hook fixtures through that artifact.
4. Starts a server bound to `127.0.0.1`, removes model credentials from the
   harness environment, and configures the harness model transport to use the
   server.
5. Returns the per-scenario scripted turns (tool calls and completions) from
   `packages/testkit/src/scenarios.ts` — one scenario per capability family.
6. Uses marker files, the recorded model requests, and the generated hook trace
   to discriminate rewrite, block, failure, context-injection, stop-prevention,
   notify, and lifecycle outcomes.
7. For the pty-approval driver, runs the interactive TUI under `node-pty`,
   walks the first-run dialogs by polling for their screen markers, and lets
   the generated hook answer the native approval prompt.
8. For Claude Agent Plugin projection, builds a portable skill plus stdio,
   Streamable HTTP, and SSE MCP
   package, projects it together with the production hook artifact, validates
   it strictly, and loads it through `--plugin-dir`. The model request must
   contain the skill marker, the stdio process records resolved root/data
   variables, both remote transports must complete initialization requests,
   and the hook trace must contain `prompt.before`.

For OpenCode, the driver also redirects `XDG_CONFIG_HOME` into the scratch
project and preinstalls the harness-matched `@opencode-ai/plugin` dependency
in both `.opencode/` and the redirected config directory. This is constructed
playback bootstrap, not hook-payload evidence, and it never writes the user's
global OpenCode installation or config.

OpenCode's serve-backed scenarios start the main turn through the documented
`POST /session/:id/prompt_async` endpoint and require its `204` acceptance
response within a finite timeout. Because acceptance precedes completion, the
driver then polls bounded observable model and transcript state; transient
transcript timeouts are retried. This HTTP drive is constructed. The hook-side
`client.session.promptAsync` behavior is captured in `.capture/opencode-client`;
the playback responses themselves remain constructed test inputs.

Run the same probe locally after installing the exact reference harness:

```bash
pnpm --filter @hooknostic/sdk run bundle
pnpm --filter hooknostic run bundle
HOOKNOSTIC_PLAYBACK=codex pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

Use `claude`, `codex`, or `opencode` for `HOOKNOSTIC_PLAYBACK`, and
`HOOKNOSTIC_PLAYBACK_VERSION=<build>` to verify a newer build than
`referenceVersion` (see `docs/testing.md`).

Scenario-to-driver mapping and the coverage policy live in ADR-0010 and
`docs/testing.md`. The loopback suite does not have a real-model mode: a
scenario whose driver cannot establish the claim is recorded as an explicit
inconclusive outcome in harness-watch, then requires its own captured live
procedure to become decisive.

Every scenario in the registry (`packages/testkit/src/scenarios.ts`) has an
executable drive registered in `harness-playback.test.ts`; a gate test fails
when a registry entry has no drive, so placeholder entries or deleted drives
cannot report phantom coverage.

## What a passing run establishes

A successful run is a **live-probe** for only the installed version and harness:

- the harness discovers the generated artifact through its real loader;
- the common lifecycle events asserted by the test reach the artifact;
- a shell rewrite reaches process execution, proven by rewritten marker content;
- a blocked shell call does not execute, proven by the absent marker;
- context injected by a hook reaches the model side, proven by the marker
  inside the scripted server's recorded requests;
- a prevented stop produces a second model turn, proven by the served turn
  count — the loop terminator is the harness's own `stop_hook_active` flag
  read through the raw-event escape hatch, exactly as a portable hook must;
- for Claude, an interactive permission prompt reaches the hook (pty lane) and
  a denied command does not execute;
- for Claude, a nonzero shell exit reaches `tool.error`;
- for Claude, a `requestApproval` surfaces the native approval prompt and an
  approved command executes (pty lane);
- a blocked continuation surfaces its reason to the model, which decides
  whether to stop;
- a spawned subagent dispatches `agent.start`/`agent.stop` (Claude `Agent`,
  Codex `spawn_agent`); and
- a stop-time notification reaches the harness's user-facing channel where
  claimed (Claude stream-json system notice), and stays inert where
  explicitly unsupported (Codex).
- on Claude 2.1.260, a projected skill is discovered; projected stdio,
  Streamable HTTP, and SSE MCP servers initialize; the stdio process receives
  Claude's plugin-root/plugin-data values translated into the Agent Plugin
  environment contract; and Hooknostic hooks still execute in the combined
  plugin.

The committed fixture replay remains the evidence for hook payload shapes. The
scripted model responses remain constructed even when a harness accepts them.

## Recording a completed validation

Do not add a profile `validatedOn` record merely because this procedure exists.
After a confirmed run, append a `live-probe` record to the relevant adapter
profile with the exact harness version and date, use this directory as its
`artifact`, state which marker and lifecycle assertions passed, and regenerate
`docs/harness-support.md`. If exact request or response bodies become adapter
evidence, capture them verbatim in a versioned fixture location and record their
own provenance instead of citing this constructed procedure.

## The scheduled rolling-record variant

The harness-watch workflow records its passes differently: a scheduled run
against a newer build writes the **rolling record** — the single
marker-delimited `validatedOn` entry in the adapter profile that
`scripts/record-playback-validation.mjs` rewrites in place (ADR-0009). The
evidence class is unchanged — still `live-probe`, still this directory as the
`artifact`, still never fixture evidence. What differs is bookkeeping, not
trust: weekly runs would otherwise append near-identical rows, and the one
claim consumers need is "newest build that passed scheduled playback". Only
that script writes the region; human captures stay append-only, and the
record's `what` string is the marker the release checker keys the playback
baseline on.
