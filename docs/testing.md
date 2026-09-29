# Testing harness integrations without model spend

The default test suite proves adapter semantics from captured native fixtures.
The `harness-playback` CI job adds two integration layers using the real,
installed harness binaries and no model credentials.

## Confidence layers

1. **Generated-artifact fixture replay** feeds every captured native input for
   a harness through the exact bundled artifact that a consumer installs. This
   covers every event the adapter advertises, including lifecycle events that
   are difficult or expensive to induce in a short headless session.
2. **Real-harness playback** installs the harness version named by the
   adapter's `harness.referenceVersion` (or `HOOKNOSTIC_PLAYBACK_VERSION` — see
   below), points its model transport at a loopback-only scripted server, loads
   the generated artifact through the harness's real discovery mechanism, and
   drives a per-scenario script of tool calls and completions. The suite proves
   rewrite and block effects through marker-file outcomes, asserts the naturally
   induced session, prompt, tool, and turn lifecycle events, proves hook
   context injections reach the model side (recorded in the scripted server's
   requests), forces a second model turn through a once-only stop prevention,
   drives Claude's `tool.error` path with a nonzero shell exit, and covers
   Claude's interactive permission prompt in a real pseudo-terminal (see the
   pty lane below). `session.end` is asserted for the command-hook harnesses;
   OpenCode's approximate session end maps to session deletion, which
   `opencode run` does not perform.
3. **Opt-in live smoke tests** remain available through
   `HOOKNOSTIC_SMOKE=<harness> pnpm test`. They use a real model and are for
   deliberate recapture or behavioral validation only, never normal CI.

The first layer is exhaustive over recorded hook payloads. The second proves
that the pinned harness still discovers the generated artifact, honors rewrite
and block results end to end, and delivers the common lifecycle around those
calls. Neither layer upgrades constructed or doc-derived
fixture provenance: a new claim about a harness still starts with the capture
procedure in `.agents/skills/harness-capture/SKILL.md`.

## Scenario coverage (ADR-0010)

The capability profiles and automated verification are tied together by the
scenario registry in `packages/testkit/src/scenarios.ts`: every cell an adapter
resolves — including explicit `unsupported` entries — must map to at least one
scenario, enforced by `describeScenarioCoverage` in the adapter contract suite.
Scenarios declare the driver that produces the harness session (loopback,
pty-approval, mcp-stdio, compaction, subagent, opencode-serve); adding a
capability cell without a scenario fails CI.

Some capability families cannot be decided by the scheduled free lanes today,
and their tests record exactly why:

- **Codex subagent lifecycle** — `SubagentStart`/`SubagentStop` fire in the
  spawned *child* session, which does not inherit the parent's
  `--dangerously-bypass-hook-trust` (session-scoped override lost in the
  child's config rebuild; observed live on 0.151.0 and matches upstream
  openai/codex#33097). Decisive validation requires a separately prepared
  live session with persisted hook trust.
- **Compaction** — the free lane cannot fill the context deterministically
  (shell results are capped ~30k chars, turn count is capped at 6 against a
  200k-token context). Decisive validation requires a separately captured
  live run.
- **Codex interactive permission and approval** — the capability profile has
  captured evidence, but this suite has no captured Codex interactive driver.
  The Claude pty driver is never treated as evidence for Codex; these cells
  remain explicitly inconclusive in scheduled playback until that driver is
  added.

Codex's `tool.after.output.replace` is rated `unsupported` (captured live on
0.151.0: the hook engine strictly rejects `updatedMCPToolOutput` from a
PostToolUse hook — it fails open with "PostToolUse hook returned unsupported
updatedMCPToolOutput"). The mcp-stdio drive therefore runs as an inverted
watch on the scheduled lane: the MCP tool call must dispatch end to end (the
scripted namespace-pair emission resolves the router's exact
`{namespace, name}` lookup), the model must see the fixture's *original*
output, and the replaced marker must surface nowhere. If upstream starts
honouring the field, the watch fails and the rating is revisited.

The Claude, Codex and OpenCode v1 playback lanes also configure and call the in-repository stdio MCP
fixture server. The dedicated MCP drive requires its tool to reach both
`tool.before` and `tool.after` as normalized `mcp` events. Claude loads the
fixture through `--mcp-config`, Codex through `mcp_servers`, and OpenCode
through its local `mcp` configuration; the output-replacement drive remains
separate because it is a capability-specific assertion.

The loopback suite never switches to a paid model. Every declared driver
limitation is written to the harness-watch workflow summary as an
**inconclusive** outcome, including the affected capability cells. A decisive
check requires the relevant captured live procedure; an environment flag must
not turn a constructed loopback session into a claimed real-model validation.

## Verifying a newer harness build

harness-watch installs a build newer than `referenceVersion` and names it in
`HOOKNOSTIC_PLAYBACK_VERSION`; the version-pin test then accepts that build.
Unset, the assertion stays CI's exact reference pin. The playback artifact keeps
baking `referenceVersion` into its capability resolution deliberately — the
load-bearing question is whether the artifact consumers already have keeps
working on the new binary:

```bash
HOOKNOSTIC_PLAYBACK=claude HOOKNOSTIC_PLAYBACK_VERSION=2.1.250 \
  pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

### The pty lane

Claude's `permission.request.*` cells are interactive-only: headless `-p`
sessions decide without prompting (that limit is why the PermissionRequest
fixture carries doc-derived provenance). The pty-approval scenario starts the
interactive TUI under `node-pty`, walks the first-run dialogs by polling for
their screen markers, sends a prompt whose scripted tool call trips the native
approval prompt, and lets the generated hook deny it — asserted from the hook
trace (the request fired) and the filesystem (denied command never executed).
The drive forces the prompting permission mode: newer builds start interactive
sessions in auto mode, where no prompt fires. It also drops the `CLAUDECODE`
and `CLAUDE_*` variables it would inherit (all but `CLAUDE_CODE_GIT_BASH_PATH`),
so a run from inside a Claude session starts a fresh top-level session as CI
does (`.capture/claude-permission-mode`).
Scenario-to-lane mapping lives in the registry's `driverByHarness` overrides,
and `docs/harness-watch.md` documents which lane runs on which schedule.

## Version pinning

CI does not copy harness patch versions into workflow YAML.
`scripts/harness-playback-version.mjs` reads each adapter's
`harness.referenceVersion`, and the matrix installs that exact npm package
version:

| Harness | npm package |
| --- | --- |
| Claude Code | `@anthropic-ai/claude-code` |
| Codex CLI | `@openai/codex` |
| OpenCode v1 (`opencode-v1`) | `opencode-ai` |
| OpenCode v2 (`opencode-v2`) | `@opencode/cli` |

The playback test also calls the adapter's normal detector and fails unless the
installed binary reports the expected version — `referenceVersion`, or the build
named in `HOOKNOSTIC_PLAYBACK_VERSION` when harness-watch verifies a newer one.

The model-side request inspection and scripted response envelopes are test
infrastructure, not harness fixtures. Their constructed provenance, the exact
claims a passing run establishes, and the procedure for promoting a successful
run to validation evidence are recorded in
`.capture/harness-playback/README.md`.

## Local execution

Install the exact reference build of one harness, bundle the compiler and its dependencies, and
run:

```bash
pnpm run bundle
HOOKNOSTIC_PLAYBACK=codex pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

Use `claude`, `codex`, `opencode-v1`, or `opencode-v2`. The historical
`opencode` lane selector remains a v1 alias. V2 uses
`packages/cli/test/opencode-v2-playback.test.ts`; see
[OpenCode families](opencode-families.md) for its independently verified
capabilities and limits. Agent definitions (ADR-0027) have their own file,
`packages/cli/test/agent-definition-playback.test.ts`, which runs on every lane: it
synchronizes a portable definition through project delivery, makes the harness
delegate to it, and asserts the child ran on its instructions and native model
(`.capture/agents/README.md`). The test removes common model credential
variables from the spawned process and supplies only a dummy credential where
the harness requires a non-empty value. Model requests are served on
`127.0.0.1` and never forwarded.

## Marketplace release gates

After `pnpm run bundle`, print the package baseline from existing capture metadata:

```sh
node scripts/verify-marketplaces.mjs codex --print-version
node scripts/verify-marketplaces.mjs claude --print-version
```

Install those exact harness versions, then run `node scripts/verify-marketplaces.mjs codex`
and the corresponding `claude` command. For a deliberate check against another installed
version, set `HOOKNOSTIC_PLAYBACK_VERSION` to that exact version; record it with the result.
The gate fails when the binary is missing, the version differs, or the package route is
unsupported. It must actually install the documented example into an isolated marketplace,
find the skill, receive an MCP greeting, and observe the hook denial from an unrelated
project directory. Codex also checks the existing installed-plugin block/rewrite scenarios.
The older project playback baseline stays unchanged.

These gates use loopback model playback and isolated configuration. They are local commands;
no Actions workflow or paid smoke session is launched. Normal `pnpm test` also relocates
all example outputs and calls the bundled MCP server without source dependencies.

## Codex Code Mode gate

Current Codex models run shell commands through Code Mode, where one `exec` tool
calls `tools.exec_command` from JavaScript. That dispatch is captured on a build
newer than `referenceVersion`, so the ordinary Codex playback lane skips its two
Code Mode drives. After `pnpm run bundle`, print the captured build from the
profile:

```sh
node scripts/verify-code-mode.mjs --print-version
```

Install that exact Codex version, then run `node scripts/verify-code-mode.mjs`.
It checks the installed version and drives a shell guard's deny and rewrite
through a nested `exec_command`. Below the baseline the drives fail instead of
skipping. The gate also fails unless the version check and both drives ran and
passed, by exact title, so a renamed drive cannot shrink it to nothing. CI runs
the same gate as its `code-mode` job on Windows, the platform the capture
covers, with the pinned playback Node version
([evidence](../.capture/codex-code-mode/README.md)).

## Actual npm package installation

After `pnpm run bundle`, set `HOOKNOSTIC_PACK=1` and run
`pnpm exec vitest run packages/cli/test/packed-consumer.test.ts`.
This packs all three packages with `pnpm pack`, installs those exact tarballs with npm
in a temporary consumer, checks shipped documentation and rewritten dependencies,
and exercises init/check/sync/verify plus a hookless package build. It may download
registry dependencies; it never publishes. The normal suite retains its offline
simulated-install coverage.
