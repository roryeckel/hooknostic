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
2. Bundles agent-plugin, SDK, and CLI, then generates a production-format artifact in a
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
7. For the pty-approval driver, runs the interactive TUI under `node-pty` in
   the prompting permission mode (`--permission-mode manual`), with no
   enclosing Claude session's variables in its environment. It walks the
   first-run dialogs by polling for their screen markers, and lets the
   generated hook answer the native approval prompt.
8. For Claude Agent Plugin projection, builds a portable skill plus stdio,
   Streamable HTTP, and SSE MCP
   package, projects it together with the production hook artifact, validates
   it strictly, and loads it through `--plugin-dir`. The model request must
   contain the skill marker, the stdio process records resolved root/data
   variables and actual cwd while Claude runs from a separate project directory;
   the stdio launcher must anchor `./mcp-working-dir` inside the plugin. Both remote transports must complete initialization requests,
   and the hook trace must contain `prompt.before`.
9. For OpenCode Agent Plugin projection, projects the same portable package at
   `delivery: "package"` — the only delivery `build.ts` ever hands the
   projector — writes the emitted npm package to a directory **outside** the
   project, and names that absolute path in the project's `opencode.json`
   `plugin` array. The manifest's `exports["./server"]` must name the generated
   entry; the entry must re-export the component injector and, with no hook
   artifacts projected, must NOT re-export the hook module it would then be
   unable to import. The stdio process must record `${PLUGIN_ROOT}` resolved to
   the nested author package and `${PLUGIN_DATA}` to a directory outside both
   the package and the project, with `./mcp-working-dir` anchored inside the
   package. The path is absolute because the package deliberately sits outside
   the project; pointing the entry somewhere the package is not loads nothing
   while OpenCode still exits `0`, which is what the mutant check flips.

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
pnpm run bundle
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

## Windows interactive approval correction (2026-09-07)

Claude Code 2.1.263 was installed in an isolated Windows temporary directory
and driven through `node-pty` against the loopback model. The paired terminal
frames in `claude-windows-approval.json` are captured output: `rejected` shows
Claude rejecting `permissionDecision: "escalate"`; `approval` shows the
replacement `"ask"` causing a native prompt with the hook's reason. These are
terminal frames, not hook-input fixtures. Account path segments, if present,
are redacted to `user`.

The request-approval scenario preallows Bash with `--allowedTools Bash`.
Without that control the harness's default permission prompt can make the test
pass even when the hook output is rejected. With `ask`, the prompt explicitly
attributes the request to the PreToolUse hook; accepting it produces the
`hooknostic-original` marker. The old `escalate` output fails the strengthened
test and the corrected apply fixture.

The installed binary's PreToolUse schema enumerates `allow`, `deny`, `ask`,
and `defer`; this is **schema-derived** evidence, corroborated for `ask` by
this live probe. The output fixture remains a constructed expected result.
No hook-input fixture provenance or capability rating changes.

The same run established three driver requirements:

- Windows npm batch shims need `cmd.exe` when launched by ConPTY; direct
  execution failed with error 193.
- The Windows TUI used ASCII `>` for both selection and prompt cursors.
  Matching only `❯` left the driver cycling through the trust choices.
- Selecting an account type on fresh-state login onboarding opened OAuth in
  the desktop browser. The driver now stops if that screen appears.

Each PTY scenario now gets a private `CLAUDE_CONFIG_DIR`. Its `.claude.json`
sets `hasCompletedOnboarding: true` and preapproves only the disposable
`hooknostic-playback` key in `customApiKeyResponses.approved`. Those field
names and the key-suffix rule (last 20 trimmed characters) were extracted from
the installed binary, then verified by this session reaching the generated
hook and native approval prompt. This seed is **constructed test bootstrap**,
not captured user configuration; personal credentials and preferences are
not copied into it.

## Auto-mode default correction (2026-09-27)

Claude Code 2.1.283 failed the permission-request scenario: interactive
sessions now start in auto mode. The scripted Bash call reached `PreToolUse`
and was settled without a prompt, so `PermissionRequest` never fired. Auto mode
also rendered a classifier billing notice for the loopback base URL, which the
walk did not know. The run had been started from inside a Claude session, and
the child inherited that session's markers: it reported transcript saving off
because of an inherited `CLAUDE_CODE_CHILD_SESSION`.

`.capture/claude-permission-mode` holds the probe and its observations on
2.1.238 and 2.1.283. The drive changed in three ways:

- It forces the prompting mode with `--permission-mode manual`. Both builds
  accept it and report `permission_mode: "default"` to hooks. The lane does not
  rely on either build's default.
- It walks the classifier billing notice by its screen marker, pressing Enter to
  continue. The probe saw the notice only in auto mode, at the first tool call,
  so the forced mode keeps it from rendering. The walk handles it in case a
  build renders it before the main prompt.
- It drops every inherited `CLAUDECODE` and `CLAUDE_*` variable except
  `CLAUDE_CODE_GIT_BASH_PATH`, plus `AI_AGENT` and `TRACEPARENT`. On CI these
  are absent, so the drop changes nothing there.

With these changes, both pty scenarios passed on 2.1.238, installed from npm
into an isolated directory, and on 2.1.283, run from inside a Claude session.
Without the forced mode, 2.1.283 failed again as first reported.
