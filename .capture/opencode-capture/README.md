# OpenCode tee-capture template

Committed OpenCode plugin project for capturing the native hook boundary.
It serves the harness-watch drift lane (plan step 7: `drive-capture-session.mjs`
copies it into the scratch session dir, where OpenCode auto-loads it from
`.opencode/plugins/`) and manual captures. OpenCode plugins are persistent
in-process modules — they receive **live objects**, not JSON on stdin, so the
tee serializes a per-value-degraded **clone** (`hooknostic-capture.js`:
safeStringify → toSerializeable) instead of mutating what it was handed and
instead of risking losing the record to a cycle or an unserializable host
object. The harness keeps using the callback objects after the hook returns;
a capture probe that rewrote `output.args` in place would alter tool input
the harness then executes.

## Layout

- `hooknostic-capture.js` — the plugin. Registers every hook the adapter
  observes (`tool.execute.before/after`, `chat.message`,
  `experimental.session.compacting`, the generic `event` bus) plus the
  never-fires `permission.ask` channel as negative evidence (captured:
  `.capture/opencode-permission`, upstream anomalyco/opencode #9229).
  Envelope matches the fixtures' invocation shape
  (`{ hook, directory, input, output }`, `fixtures/opencode/1.18/README.md`).
- `captured/` (created at runtime, gitignored via `.capture/*/captured/`) —
  one `<hook>.jsonl` per callback, plus `plugin-load.jsonl`.

## Install (what a driver does, or you by hand)

```
<scratch>/
  .opencode/plugins/hooknostic-capture.js   ← copy of this file
  opencode.json                             ← provider config (the driver's)
```

For OpenCode 1.18.27, the automated driver completes the harness's
configuration dependency bootstrap before starting it. It installs
`@opencode-ai/plugin@<harness-version>` into both the project `.opencode/`
directory and a redirected scratch config directory, while setting
`XDG_CONFIG_HOME` to the latter. OpenCode waits for dependency preparation
across both config directories before loading a project plugin; leaving the
fresh global-config directory unresolved can exceed the playback timeout.
Both installs are scratch-local and disposable. This is execution-environment
provenance only and does not upgrade any captured payload claim.

Set `HKN_CAPTURE_DIR` to redirect `captured/` (the driver points it at the
scratch dir so captures survive plugin re-instantiation); unset, it lands
next to the plugin. OpenCode trusts an inherited `PWD` over the process cwd —
a spawner must set `PWD` to the scratch dir or the session runs in
`PWD`'s project, where plugins may not exist (captured:
`.capture/opencode-client`, profile validatedOn 1.18.25).

## What the teed payloads are

Live callback invocations, serialized at capture time — the same class as
`fixtures/opencode/1.18/*.input.json` (**captured** provenance when the run
records version and date). The comparator
(`scripts/compare-capture-shapes.mjs`) filters the `event` bus to the
adapter-mapped event types and diffs shapes against those fixtures; drift
routes humans to the harness-capture skill. This project never upgrades
provenance by itself.

## Smoke (clean-clone verification, 2026-09-02)

Verified from a fresh `git clone` (templates committed, scratch dir outside
the repo) against opencode 1.18.27 with the loopback playback model: all five
expected variants were captured (`event+session.created`, `chat.message`,
`tool.execute.before+bash`, `tool.execute.after+bash`, `event+session.idle`)
plus `session.deleted`-absence consistent with a short-lived session. Two
serialization rules were pinned by this run:

- the `event` tee stores the whole callback `input` (`{ event: … }`), not the
  unwrapped bus event, so the envelope matches the fixtures' invocation shape;
- serialization **clones** the handed objects (cycles render as
  `"[circular]"` inside the clone; the live objects are never touched —
  verified with deep-frozen inputs);
- `safeStringify` **drops undefined-valued keys** instead of writing
  `"[undefined]"` strings — a host that omits a key and a host that sends
  `undefined` must produce the same shape, or the tee manufactures drift.

Resolved limitation: the comparator used to report **drift** for the two bus
variants (`session.created`, `session.idle`), `chat.message`, and bash
`tool.execute.before`/`after`, because the committed 1.18 fixtures were
type-derived envelopes with minimal `properties`/`metadata` while live
payloads carry richer `info`/`metadata` objects. Those five fixtures are now
captured on 1.18.33 (`fixtures/opencode/1.18/README.md`). The tee was never
the defect: it records exactly what the harness sent.