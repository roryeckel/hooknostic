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
5. Returns one shell tool call and then a completion response.
6. Uses marker files and the generated hook trace to discriminate rewrite,
   block, failure, discovery, and lifecycle outcomes.

Run the same probe locally after installing the exact reference harness:

```bash
pnpm --filter @hooknostic/sdk run bundle
pnpm --filter hooknostic run bundle
HOOKNOSTIC_PLAYBACK=codex pnpm exec vitest run packages/cli/test/harness-playback.test.ts
```

Use `claude`, `codex`, or `opencode` for `HOOKNOSTIC_PLAYBACK`.

## What a passing run establishes

A successful run is a **live-probe** for only the installed version and harness:

- the harness discovers the generated artifact through its real loader;
- the common lifecycle events asserted by the test reach the artifact;
- a shell rewrite reaches process execution, proven by rewritten marker content;
- a blocked shell call does not execute, proven by the absent marker; and
- for Claude, a nonzero shell exit reaches `tool.error`.

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
