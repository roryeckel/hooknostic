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
- on a Codex build at or above the `.capture/codex-code-mode` capture, a
  `match: { kind: "shell" }` guard, with its generated native matcher, denies
  and rewrites a nested `tools.exec_command` inside a Code Mode `exec`. The
  catalog is `code_mode_only` and the model is offered no direct shell tool.
  Below that build the two drives skip with that reason. CI's `code-mode` job
  runs them on the captured build, where skipping is a failure
  (`scripts/verify-code-mode.mjs`).
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

## MCP servers still connecting at the first request (2026-10-11)

Claude Code 2.1.296 failed the projected-plugin scenario in the scheduled lane.
The plugin declares a stdio, a Streamable HTTP and an SSE MCP server, and the
script's first step calls the stdio server's tool. The first model request
listed the two remote servers' tools and `WaitForMcpServers`, and not the stdio
server's tool, so the playback had no tool to call and reported that the
request exposed no usable one. It failed that way on each of three runs: on the
Linux runner and on Windows on 2.1.296, and on Windows on 2.1.295. 2.1.289
passed the scenario in the scheduled lane on 2026-10-04, and the reference
build passes it.

The request describes `WaitForMcpServers` as waiting for servers that are still
connecting. Its one argument, `servers`, is optional, and a call without it
waits for all of them. With that call made first, on 2.1.296 on Windows:

| Request | Tools listed                                | Playback's call        | Result                                              |
| ------- | ------------------------------------------- | ---------------------- | --------------------------------------------------- |
| 1       | `WaitForMcpServers`, the HTTP and SSE tools | `WaitForMcpServers {}` | `ready: true`, naming the stdio server as connected |
| 2       | the same, and the stdio server's tool       | the stdio tool         | the fixture's marker                                |

The stdio process had received the plugin root, working directory and data
directory, as on earlier builds. So this build still starts the server the
projection declares; what changed is that the first request no longer waits
for it.

The drive changed in two ways:

- The playback model answers a step whose named tool is not listed, in a
  request that lists `WaitForMcpServers`, with that call and no arguments, and
  the step stays next. A step gets two waits, after which its tool is reported
  missing as before. A request that offers no way to wait is reported at once.
- The scenario's `--max-turns` rose from 3 to 4, for the turn a wait takes.

With these changes the Claude lane passed on 2.1.238 and on 2.1.296, each
installed from npm into an isolated directory on Windows. Not established:
whether an interactive session holds its first request for a connecting server,
and what the tool returns for a server that fails to connect.

## Windows private CSI folder-trust correction (2026-10-11)

Claude Code 2.1.238's folder-trust walk failed on both the invocation-policy
change and an independently installed and bundled archive of pre-change commit
831a2e3. Both PTY scenarios reproduced the failure on that baseline before a
user prompt was submitted. The hook artifacts match after removing generated
source-path labels and comments.

[claude-windows-trust-csi.json](claude-windows-trust-csi.json) records the native
terminal text seen by the old selection helper, including its initial entry
frame before any arrow keys. This is **processed terminal capture**: the old
driver already removed some CSI sequences and whitespace. It is not raw ConPTY
traffic or a hook-payload fixture. Account paths are redacted to `user`, and
the capture retains hashes of the ignored diagnostic reports.

The initial frame has the wanted `>1.Yes,Itrustthisfolder` selection followed
by `ESC[>0q`. The old ANSI regex allowed only digits, semicolons and question
marks in CSI parameters, so it left that private sequence intact. The selector
read its `>` as the latest option cursor, sent unnecessary up keys, and failed
to confirm an already-selected option. The later frames retain those cursor
redraws. This establishes the parsing defect; it does not assign semantics to
the private terminal sequence.

Both Claude PTY drives now share Node's `stripVTControlCharacters` before
recognizing dialogs and selection cursors. The regression passes the captured
initial frame through that same normalizer and the actual first-run walk. It
failed with the original regex and the same folder-trust selection error; the
corrected helper confirms the selection with one Enter and no arrow keys.
Native hooks, fixture payloads, support ratings and invocation policy are
unchanged by this playback-driver correction.

With the correction, the complete reference Claude playback lane passed all
42 enabled tests (nine skips), exit zero. The isolated regression also passed
with the existing PTY unit tests. No paid-model smoke was run.

## Cursor-only trust redraw (Windows, 2026-10-17)

claude-windows-trust-295.json records Claude Code 2.1.295 in a fresh ConPTY
session with seeded onboarding and a loopback-only API endpoint. No folder
trust was confirmed and no prompt was submitted. Six up keys, 600 ms apart,
produced cumulative raw frames. The capturing account's home-directory segment
is redacted to user.

The initial selection is No, exit. The first up key erases its cursor and
writes > beside the existing Yes, I trust this folder label, without writing
that label again. Stripping control codes leaves a trailing bare >; the
append-only selector consequently never finds the wanted label. The prior
private-CSI correction above does not reconstruct overwritten terminal cells.

The two PTY drives now use the test-only @xterm/headless terminal buffer for
dialog recognition, with the same 110 columns and 34 rows as their native PTY.
Raw output remains available for historical-output assertions. The captured
repaint regression failed against the old strip-only reader with the same trust
selection error, then passed with exactly one up key and Enter. Both real
interactive denial and hook-requested approval passed on Node 22.22.2. The
AttachConsole failed message appeared on teardown of the exploratory capture,
after its raw frames had been collected; it was not the selection failure.

### Playback fix validation (Windows, 2026-10-17)

All final commands exited zero. Lint, formatting and the full build ran on
Node 24.20.0; the full test suite and all four playback runs below ran on the
SHA-256-verified official Node 22.22.2 runtime. Reference harnesses were installed
in an isolated temporary directory; current global installations were unchanged.

| Check | Result |
| --- | --- |
| pnpm lint | exit 0 |
| pnpm format:check | exit 0 |
| pnpm build | exit 0 |
| pnpm test with HOOKNOSTIC_PACK=1 | exit 0; 2,045 passed, 92 skipped |
| Claude reference 2.1.238 full playback | exit 0; 43 passed, 15 skipped |
| Claude installed 2.1.295 full playback | exit 0; 43 passed, 15 skipped |
| OpenCode v2 reference 2.0.17 full playback | exit 0; 31 passed |
| OpenCode v2 installed 2.0.32 full playback | exit 0; 31 passed |
| pnpm build:examples from the repository root | exit 0; generated bytes identical to the preceding Node-minimum change |
| Dependency ownership, version literals and git diff --check | each exit 0 |

The new cursor-repaint and OAuth-catalog regressions each failed against the
original behavior, then passed after correction. The custom-error fixture failed
when error decoding was disabled. The retry-budget test failed when a third
retry was allowed. Existing remote-project and remote-package mutants each
failed their focused playback test after configuration or headers were removed.
Every mutated source was restored byte for byte before the final runs. No paid
model smoke or publication was performed.

## Deferred MCP tool discovery (Windows, 2026-10-21)

Claude Code 2.1.306 failed both the projected-plugin MCP scenario and the
fixture MCP scenario with `playback request exposed no usable tool`. The
first model request offered `ToolSearch` but neither scripted MCP tool nor
`WaitForMcpServers`. The fixture's full tool name appeared in a deferred-tools
message; the projected stdio server appeared among servers still connecting.

The probe temporarily prepended `ToolSearch` with the scripted suffix as
`query` and `max_results: 5`. Both scenarios passed: the next request included
the requested tool's full name and schema with `defer_loading: true`, and the
script called it successfully. Setting `ENABLE_TOOL_SEARCH=false` for the
unmodified drive also made both scenarios pass. All requests went to the
loopback model server; no paid model was used.

[claude-tool-search-306.json](claude-tool-search-306.json) retains processed
live model-request excerpts from the isolated fixture-server run: the discovery
tool declaration, the scripted search call as echoed by the harness, and the
resulting MCP declaration. Unrelated tools, system instructions and messages
are omitted. There are no account paths in the retained excerpts. This is
model-router evidence, not a new hook-boundary fixture or adapter tool shape.

Tool search itself was not new. The
[2.1.304 release notes](https://github.com/anthropics/claude-code/releases/tag/v2.1.304)
(October 19) say it became enabled by default behind a custom
`ANTHROPIC_BASE_URL`. Playback sets that variable to its loopback server. The
[MCP gateway documentation](https://code.claude.com/docs/en/mcp#tool-search-through-an-llm-gateway)
states that earlier builds kept search off there unless explicitly enabled.
These are vendor-documented version-boundary facts, not a live binary bisect:
the recorded scheduled lane passed on 2.1.303 on October 19, and the local
failure was reproduced on 2.1.306. The old driver had never exercised this
discovery path under its default gateway configuration.

The corrected driver gives each scripted tool step at most two discovery
calls, shared between `ToolSearch` and `WaitForMcpServers`. It prefers search
when both are offered, leaves the named call pending, and uses distinct call
ids. Auxiliary requests neither consume the step nor replenish its budget.
An advertised tool is called immediately, even when marked `defer_loading`;
an absent tool with no discovery mechanism, or after the budget is exhausted,
still fails. No harness version or model-name special case selects this path.

The complete Claude 2.1.306 lane passes with the correction: 52 tests passed,
18 skipped, exit zero. The regression tests failed against the original driver;
targeted mutants also failed when discovery ran for an already advertised tool
or auxiliary requests replenished the budget. Each mutated source was restored
byte for byte. Lint, formatting, build and example regeneration exited zero;
the committed examples were unchanged. The full repository suite passed
2,405 tests with 98 skips after registering the new capture with Git.
