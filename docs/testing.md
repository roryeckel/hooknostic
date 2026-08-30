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
   adapter's `harness.referenceVersion`, points its model transport at a
   loopback-only scripted server, loads the generated artifact through the
   harness's real discovery mechanism, and drives deterministic shell tool
   calls. The suite proves both rewrite and block effects through marker-file
   outcomes, asserts the naturally induced session, prompt, tool, and turn
   lifecycle events, and drives Claude's `tool.error` path with a nonzero shell
   exit. `session.end` is asserted for the command-hook harnesses; OpenCode's
   approximate session end maps to session deletion, which `opencode run` does
   not perform.
3. **Opt-in live smoke tests** remain available through
   `HOOKNOSTIC_SMOKE=<harness> pnpm test`. They use a real model and are for
   deliberate recapture or behavioral validation only, never normal CI.

The first layer is exhaustive over recorded hook payloads. The second proves
that the pinned harness still discovers the generated artifact, honors rewrite
and block results end to end, and delivers the common lifecycle around those
calls. Neither layer upgrades constructed or doc-derived
fixture provenance: a new claim about a harness still starts with the capture
procedure in `.agents/skills/harness-capture/SKILL.md`.

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
installed binary reports that exact version. Updating playback therefore starts
with a real capture against the new build, updates adapter metadata once, and
lets CI derive the install version.

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
