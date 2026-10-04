# Harness-watch drift capture

Procedure and provenance boundary for the advisory `drift` lane in
`.github/workflows/harness-watch.yml`.

## Question

For one newly assessed harness build, do the native hook payloads produced by
a short real-harness session still have the same structural shapes as the
committed fixture variants that the session exercises?

## Method

`scripts/drive-capture-session.mjs` copies the relevant committed tee template
into an isolated scratch project, drives one real harness session, and flattens
the raw JSONL output for `scripts/compare-capture-shapes.mjs`.

The default transport uses the repository's constructed loopback model. An
explicit `force_llm` dispatch may instead use the owner's model endpoint via a
LiteLLM sidecar. In both cases the installed third-party harness runs in a
restricted container: the repository mount is read-only, captures are the only
writable output, no Docker socket is mounted, and the paid transport exposes
only a disposable proxy credential to that container.

Each run stores its raw captures, report, and `drift-verdict-<harness>` JSON as
a seven-day workflow artifact. Those artifacts are diagnostic records, not
committed fixtures.

## Observation

The observation is the artifact's `clean`, `drift`, `inconclusive`, or
`drive-failure` verdict together with the raw payloads that produced it. A
clean verdict means only that the exercised variants matched the existing
fixture shapes in that one session; it is not a new fixture capture or a
ValidationRecord.

## Consequences

- `drift`, `inconclusive`, and `drive-failure` are reportable outcomes, never
  automatic fixture or range changes.
- A human who needs to change an adapter claim follows the harness-capture
  skill: preserve the raw evidence, record provenance, update paired fixtures,
  append the appropriate ValidationRecord, and regenerate harness support.
- Promotion is a separate, reviewed human step. A playback-transport artifact
  whose payloads a human has inspected may be promoted to fixtures (captured,
  argument values scripted); `promote-opencode-v1.mjs` does this for the
  opencode-v1 variants the session exercises, with fail-closed redaction and
  canonical files from today's decoder. The skill's remaining steps (README
  provenance row, ValidationRecord, harness-support regeneration) still apply.
- This procedure does not upgrade the provenance of its template, playback,
  or fixture inputs. The loopback response is constructed even though the
  harness hook payloads are native output.

## Reviewed v2 context variant (2026-10-04)

The owner-requested [issue #82](https://github.com/roryeckel/hooknostic/issues/82)
reviewed the playback artifact from
[run 37241402964](https://github.com/roryeckel/hooknostic/actions/runs/37241402964).
Select the first `hook === "context"` record from its
`captured-opencode-v2/events.jsonl`, retain the complete envelope, check for
account paths, and derive the canonical form with `decodeOpenCodeV2` using the
fixture suite's injected reference version. The resulting `context-max-tokens`
pair is additive to the old context fixture. Its exact capture version,
platform, JSONL checksum and provenance limits are recorded in
`fixtures/opencode/2.0/README.md`.

Replaying all saved JSONL records through `compareCaptures` with the v2
`EXPECTED_VARIANTS` reproduced the original numeric `event.options.maxTokens`
difference, then became clean after the new fixture was added. The comparator
was not relaxed. The regression also rejects a string token limit and an
unseen option; the existing adapter fixture replay checks canonical output and
raw-object identity. No new effect semantics are inferred from the option.
