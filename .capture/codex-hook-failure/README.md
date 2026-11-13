# Codex hook failure: what fails, and what Codex says about it

Evidence class: Codex CLI **0.156.1** on Windows 11 (32 logical processors),
2026-11-13. No model credits: the model is the loopback playback server.

- **live-probe**: hook outcomes and their effects, read from `codex app-server`
  `hook/completed` notifications and from a test-only Node preload in each hook
  process.
- **source-derived**, secondary, where labelled: codex-rs at `rust-v0.156.1`.

## Question

CI run 43375628256 (job "Codex Code Mode playback", windows-latest) failed once
and passed on re-run with no change. In the failing "denies a nested
exec_command inside a Code Mode exec" drive, `codex exec` printed
`hook: PreToolUse` then `hook: PreToolUse Failed`, and the command the guard
should have denied ran. The trace had no `tool.before` line. The playback
build gives every hook a 1s budget, so its hooks.json `timeout` was 2 seconds.
Codex's Code Mode cell reported `Wall time 3.2 seconds` for the PreToolUse hook,
the 403ms command and PostToolUse together.

Why did the hook fail, and why did no output say?

## What `codex exec` reports (source-derived)

- `hooks/src/engine/command_runner.rs`: a command hook runs under one deadline,
  `timeout_sec`, that covers spawning the process, writing its stdin and
  waiting for it to exit. On expiry the result is the error
  `hook timed out after {N}s` and the process tree is terminated.
- `hooks/src/events/pre_tool_use.rs`: a run error, an exit code other than 0 or
  2, or invalid JSON output is `HookRunStatus::Failed` with an error entry. Only
  a deny decision or exit 2 with a reason blocks. A failed run does not block.
- `exec/src/event_processor_with_human_output.rs` prints `hook: <Event>
  <status>` and drops the entries. The JSONL processor drops hook events
  entirely, and `rollout/src/policy.rs` does not persist them. With `RUST_LOG`
  set, the outcome exists only as a span field (`hook.command_outcome`), which
  is not printed.
- The app-server `hook/completed` notification carries the entries and
  `durationMs` (`app-server-protocol/src/protocol/v2/hook.rs`).

So `codex exec` gives no cause for a failed hook. `probe.test.ts` reads the
app-server notification instead.

## Method

```sh
pnpm run bundle
HOOKNOSTIC_PROBE_RUNS=15 HOOKNOSTIC_PROBE_HOOK_TIMEOUT_MS=1000 \
  HOOKNOSTIC_PROBE_OUT=observations-2s.json \
  pnpm exec vitest run --config .capture/codex-hook-failure/vitest.config.ts
```

Each drive builds the Code Mode deny artifact (`buildPlaybackArtifact` with
`match: { kind: "shell" }`), serves a `code_mode_only` catalog and runs one turn
through `codex app-server`. It uses an isolated `CODEX_HOME`, the same `-c`
overrides as the playback lane, and `bypass_hook_trust` as a thread config
override, which is how `codex exec` forwards `--dangerously-bypass-hook-trust`.
It records every `hook/completed` run and whether the blocked marker was
written. It also records each hook process's own record from
`packages/cli/test/hook-process-recorder.mjs`, a preload passed through
`NODE_OPTIONS` (`--require` of a CommonJS form during this capture, `--import`
of the committed ES module since; both preload before the hook runtime). Codex passes `NODE_OPTIONS` to hook processes: every drive's
hooks loaded it.

`HOOKNOSTIC_PROBE_HOOK_TIMEOUT_MS` sets every hook's budget except session.end.
The native timeout is that budget plus one second. 1000 is the configuration CI
failed with; 10000 is the playback lane's budget after this capture.

The host had to be contended, because an idle host never timed out. A side
process ran 96 busy-loop Node processes on the 32 logical processors for each
batch of 15 drives.

## Observations

| Native timeout | Drives | Hook runs | Failed | Deny drives that failed open | Codex `durationMs` median / max | Hook code, in Node, median / max |
| --- | --- | --- | --- | --- | --- | --- |
| 2s (`observations-2s.json`) | 15 | 62 | 4, all `hook timed out after 2s` (2 PreToolUse, 2 UserPromptSubmit) | **2** | 1704 / 6742 ms | 198 / 264 ms |
| 11s (`observations-11s.json`) | 15 | 60 | 1, `hook timed out after 11s` (UserPromptSubmit) | 0 | 1772 / 11040 ms | 199 / 255 ms |

- **The cause is a timeout, and the hook's code is not what is slow.** Codex's
  clock includes `cmd.exe` and `node.exe` process creation and scheduling. The
  hook's code ran for at most 264ms under the same load. In one 2s drive the
  PreToolUse process answered `deny` and exited 0 after 223ms, but Codex had
  already timed it out at 2042ms. In another, PreToolUse left no process record
  at all: it was killed before Node started, and Codex logged 6742ms for a
  two-second timeout, so Codex's own timer was starved too. In the 11s drive the
  UserPromptSubmit process started about nine seconds after Codex spawned it,
  and then ran in 194ms.
- **A timed-out PreToolUse fails open.** Both failed PreToolUse runs let the
  denied command run and write its marker, which is the CI failure exactly.
- Without the artificial load, 40 runs of the Code Mode gate (80 `codex exec`
  drives) recorded every hook process exiting 0, with its code taking 33-42ms.
  An unloaded app-server drive measured about 200ms per hook by Codex's clock,
  against about 37ms in Node.

CI's frequency, from the Actions API: in 286 completed runs of this job since
2026-10-11, this was the only failure.

## Consequences

- The playback lane gives each hook a 10s budget (`playbackHookTimeoutMs` in
  `packages/cli/test/harness-playback.ts`), so 11s native, except session.end,
  which keeps 2s + 1s inside Codex's 3s SessionEnd cap. The drives assert
  effects, not latency. A deny must still deny.
- A failed Codex playback drive now reports the events Codex said failed, the
  hooks.json timeouts, and each hook process's exit code, wall time, stdout and
  stderr, from the same preload. A failed event with no process record is one
  killed before Node ran.
- **Product risk, not fixed here.** A generated Codex guard fails open whenever
  process start plus its handler exceeds the native timeout, which is
  `ceil(sum of budgets) + 1` seconds. With the default 5s runtime budget that is
  6s. A hook declaring a small `timeoutMs` gets as little as 2s, the
  configuration that failed here. hooknostic cannot make Codex treat a failed
  PreToolUse as a block.

## Limits

- One Windows host, with load from busy loops. Real contention (antivirus
  scanning a fresh bundle, a 4-vCPU runner, Code Mode's own V8 isolate) was not
  reproduced directly. The CI failure matches the timeout signature: a
  `Failed` PreToolUse inside a 3.2s cell, with no `tool.before`.
- Linux and macOS were not run. The deadline logic is shared code, but process
  start costs differ.
- The drives ran under `codex app-server`, not `codex exec`. Both reach the same
  hook engine: in 0.156.1 `codex exec` consumes the same app-server
  notifications, `HookCompleted` included. Under 64 busy loops, the playback
  lane's own `codex exec` drives printed `hook: SessionStart Failed` and
  `hook: UserPromptSubmit Failed` for hooks that left no process record.
