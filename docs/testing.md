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

Two capability families cannot be decided by the scheduled free lanes today,
and their tests record exactly why:

- **Codex subagent lifecycle** — `SubagentStart`/`SubagentStop` fire in the
  spawned *child* session, which does not inherit the parent's
  `--dangerously-bypass-hook-trust` (session-scoped override lost in the
  child's config rebuild; observed live on 0.151.0 and matches upstream
  openai/codex#33097). The drive runs on the manual `force_llm` lane, where
  hook trust can be persisted.
- **Compaction** — the free lane cannot fill the context deterministically
  (shell results are capped ~30k chars, turn count is capped at 6 against a
  200k-token context). Same routing: the drive runs only on the `force_llm`
  lane.

Codex's `tool.after.output.replace` is rated `unsupported` (captured live on
0.151.0: the hook engine strictly rejects `updatedMCPToolOutput` from a
PostToolUse hook — it fails open with "PostToolUse hook returned unsupported
updatedMCPToolOutput"). The mcp-stdio drive therefore runs as an inverted
watch on the scheduled lane: the MCP tool call must dispatch end to end (the
scripted namespace-pair emission resolves the router's exact
`{namespace, name}` lookup), the model must see the fixture's *original*
output, and the replaced marker must surface nowhere. If upstream starts
honouring the field, the watch fails and the rating is revisited.

Two drives are gated on `HOOKNOSTIC_PLAYBACK_FORCE_LLM=1` (the manual-lane
switch): unset, they skip with their recorded reason; set, they run against
the real model. Skipped ≠ silent: harness-watch's workflow summary reports
every inconclusive lane on every run.

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
| OpenCode | `opencode-ai` |

The playback test also calls the adapter's normal detector and fails unless the
installed binary reports the expected version — `referenceVersion`, or the build
named in `HOOKNOSTIC_PLAYBACK_VERSION` when harness-watch verifies a newer one.

The model-side request inspection and scripted response envelopes are test
infrastructure, not harness fixtures. Their constructed provenance, the exact
claims a passing run establishes, and the procedure for promoting a successful
run to validation evidence are recorded in
`.capture/harness-playback/README.md`.

## Local execution

Install the exact reference build of one harness, bundle the SDK and CLI, and
run:

```bash
pnpm --filter @hooknostic/sdk run bundle
pnpm --filter hooknostic run bundle
HOOKNOSTIC_PLAYBACK=codex pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

Use `claude`, `codex`, or `opencode`. The test removes common model credential
variables from the spawned process and supplies only a dummy credential where
the harness requires a non-empty value. Model requests are served on
`127.0.0.1` and never forwarded.
