# OpenCode v2 generation, compaction, permissions and execution outcomes

Windows, `@opencode/cli` 2.0.17, 2026-09-26. Private server, scratch homes,
loopback model, no credentials or spend. From the repository root:

```
pnpm run bundle
node --experimental-strip-types .capture/opencode-v2/drive.mjs lifecycle
node --experimental-strip-types .capture/opencode-v2/drive.mjs sessions
node --experimental-strip-types .capture/opencode-v2/drive.mjs sessions-deny
```

## Generation and compaction

The lifecycle drive calls generation and manual compaction separately after
two sessions and a plugin reload. Each route issues one model request and
receives the generated `model.request.before` context marker. Compaction also
receives its own `context.compact.before` marker and emits
`session.compaction.ended` with a valid summary. The portable after event is
observed once. A preliminary plain-text response failed the summary template
and triggered a retry; the final probe uses the required structured summary.
Execution success alone cannot establish compaction success.

`model.request` carries request kind but no mutable system parts. Context,
title, generation and compaction callbacks supply the mutable text parts.
Compaction dispatches both existing portable events from one registration,
preserving its raw callback envelope. Cadence across retries and other
providers remains approximate; this is not universal provider validation.

## Permissions

The session drive covers allow, ask/accept, ask/reject and configured deny.
Allowed and accepted controls execute the shell marker once. Rejected and
configured-deny controls execute none. `evaluate` also fires for preallowed
commands; only `effect: ask` maps to `permission.request`. Configured deny
does not fire this callback in the capture.

First, `sessions-native-deny` proved that setting an ask evaluation to deny
prevents execution. The final `sessions-deny` drive uses the generated
portable `block` effect, with no denial from the capture plugin. Both ask
cases execute nothing, while the allow control still executes. The portable
event precedes admission to the approval UI, so its rating is approximate.

The evaluation supplies a permission action, resources and source call ID;
it supplies no tool name or input. These are not reconstructed from command
resources. `tool` is `other`/`unknown` with undefined input; the permission
fields survive in `raw`, and the captured source ID supplies correlation.
Tool-kind/native-name guards should use `tool.before` instead. No approval
effect or blanket interception of already allowed commands is claimed.

## Execution and cleanup

A deliberate HTTP 400 produces `session.execution.failed`; interrupting a
pending loopback request produces `session.execution.interrupted`. Both now
dispatch `turn.stop`, alongside successful executions. This also observes
manual compaction execution completion, so the rating remains approximate.
Stop prevention and notification post only after a succeeded execution; see
the `stop` drive in `../opencode-v2`.

Reload records one cleanup, two setups and one prompt per session. The probe
kills and awaits its private server at exit. Abrupt process exit is not proof
that the host invoked every plugin cleanup callback.

`promote-sessions.mjs <lifecycle-root> <sessions-root>` promotes reviewed
callback snapshots and canonical decoder output. The nested permission
audit contains captured callbacks/API responses plus constructed scenario
names and observed marker counts. Model responses are constructed test data.
All captured account path segments are redacted to `user`.

## Regression verification

After bundling, `verify-mutations.mjs` detected each deliberately removed
generation/compaction registration, compaction after-event mapping, ask-only
filter, permission-denial mutation and failed/interrupted completion mapping.
Removing generation decoding fails its fixture test; removing raw preservation
fails every new callback fixture. Filtering the new routes out of drift
comparison fails all six new drift cases. Original source bytes were restored
after every mutant.

Final local gates: `pnpm lint` exit 0; `pnpm format:check` exit 0;
`pnpm build` exit 0; `pnpm test` exit 0 (1,403 passed, 62 skipped).
Root example regeneration exited 0. The complete Windows v2 offline lane
exited 0 with 19 scenarios passing. Hosted Linux CI and paid smoke were not
run in this local session.
The independent v1 offline lane exited 0 with 24 passed and 14 skipped,
using its isolated installation while the user's global v2 remained installed.
