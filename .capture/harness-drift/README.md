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
- This procedure does not upgrade the provenance of its template, playback,
  or fixture inputs. The loopback response is constructed even though the
  harness hook payloads are native output.
