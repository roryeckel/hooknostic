# OpenCode dispose and one-shot runs

Question: under a one-shot `opencode run`, does a hook that is still running when
the session goes idle get to finish? OpenCode 1.x starts plugin `event` handlers
without awaiting them, and a `turn.stop` hook runs off `session.idle`, after a
session read of up to 10 s when it declares a turn field (ADR-0027). The 1.18.33
binary's strings show what should happen at exit:

- the bus listener calls `V.event?.({ event })` for each plugin inside
  `Effect.sync`, so nothing waits for the promise it returns;
- the instance's finalizer runs, per plugin,
  `Effect.tryPromise(() => Promise.resolve(N.dispose?.()))` and logs a failure as
  "plugin dispose hook failed";
- the command wrapper does `finally { await runPromise(store.dispose(ctx)) }`, and
  the CLI entry ends in `finally { process.exit() }`.

`dispose` is not in `@opencode-ai/plugin`'s `Hooks` type. This capture checks that
it is called, awaited, and unbounded, and what that means for OpenCode 2.x.

## Method

No model spend. Both drivers run the installed harness against the loopback
playback model (`packages/cli/test/harness-playback.ts`), which answers one line
of text. Every state directory (`HOME`, `USERPROFILE`, all four XDG homes) is
redirected into a fresh OS-temp root per run. Each probe appends marks with
wall-clock times to `captured/timeline.jsonl` there, including one from a
`process.once("exit")` listener; the drivers print them relative to the idle
event.

```bash
pnpm run bundle   # the shim modes compile the checkout's shim
node --experimental-strip-types .capture/opencode-dispose/drive.mjs await none hang shim shim-nodispose
node --experimental-strip-types .capture/opencode-dispose/drive-v2.mjs standalone
node --experimental-strip-types .capture/opencode-dispose/drive-v2.mjs service
```

- `.opencode/plugins/probe.js` (1.x): at `session.idle` it starts a task that
  calls `client.session.messages` and then waits 3 s. `HKN_DISPOSE_MODE` chooses
  what the plugin returns: `await` (a `dispose` that awaits the task), `none` (no
  `dispose`) or `hang` (awaits the task, then 25 s more).
- `hooks.ts` (1.x, `shim` modes): a portable plugin whose `turn.stop` hook
  declares `lastMessage`, waits 3 s and records it. `shim` compiles it with the
  checkout's shim as a build does; `shim-nodispose` removes the `dispose` the
  shim returns, which is the shim before 0.4.0.
- `v2-probe.js` (2.x): the same 3 s task, started at
  `session.execution.succeeded` from the event subscription, which is where the
  v2 shim dispatches `turn.stop`. Its cleanup awaits the task. `standalone` runs
  `run --standalone`; `service` gives the isolated background service a free
  port (the user's own service holds the default one), starts it, runs without
  `--standalone`, and stops it.

## Observations (Windows, 2026-09-30)

OpenCode 1.18.33, times after `session.idle`:

| Mode | Session read | `dispose` called | Task / hook done | Process exit |
| --- | --- | --- | --- | --- |
| `none` | 6 ms | — | never | 41 ms |
| `await` | 11 ms | 45 ms, 1 in flight | 3020 ms | 3023 ms |
| `hang` | 7 ms | 17 ms, 1 in flight | 3025 ms | 28030 ms |
| `shim` | (in the shim) | | 3016 ms, `lastMessage` = the reply | 3072 ms (driver) |
| `shim-nodispose` | (in the shim) | | never | 99 ms (driver) |

- `dispose` is called and awaited under `opencode run`. The session read inside
  the idle task still answered (two messages) while it ran.
- The host puts no bound on `dispose`: `hang` held the process 28 s. Whatever
  bound there is, the plugin sets.
- With no `dispose`, the process exits about 40 ms after idle, and a hook that has
  not finished by then is lost. The shim before 0.4.0 lost a 3 s `turn.stop` hook
  that way; the 0.4.0 shim's `dispose` let it finish.
- In `await` and `hang` a second plugin instance initialised about 0.5 s after
  `dispose` was called, and two `exit` marks were written. Its `dispose` was not
  called, and it received no `session.idle`.

OpenCode 2.0.18, times after `session.execution.succeeded`:

| Mode | Plugin pid vs run pid | Cleanup called | Task done | `run` exit |
| --- | --- | --- | --- | --- |
| `standalone` | different | never | never | 767 ms |
| `service` | different | never | 3002 ms, in the service | 41 ms |

- Plugins run in a server process. `run --standalone` spawns
  `opencode serve --stdio --port 0` as a private server (the binary's
  `cli.standalone.endpoint`, `killSignal: "SIGTERM"`, `forceKillAfter: "3 seconds"`)
  and terminates it when the run ends. The probe's cleanup was never called and
  no `exit` mark was written, so the server was killed rather than shut down;
  the in-flight task was lost.
- Through the background service, `run` returned at once and the task completed
  in the service, which outlives the run. `service stop` did not call cleanup
  either.
- Only Windows was measured. On POSIX the SIGTERM may let the server shut down,
  within the 3 s before SIGKILL; that is not established.

## Consequences

- The 1.x disposal observations apply to the measured build above. Whether
  earlier supported versions call and await a plugin's `dispose` is unverified;
  they may still truncate in-flight hooks at idle. Returning the callback does
  not establish that a host invokes it.
- The OpenCode 1.x shim returns `dispose` (0.4.0). It waits for every dispatch
  still in flight, including ones that start while it waits, for up to the
  busiest event's summed hook budgets plus one 10 s host round trip, clamped to
  15 s. It never rejects. The `turn.stop.observe` rationale says so.
- The OpenCode 2.x shim is unchanged. Its cleanup already drains the per-session
  queues, but under `run --standalone` the host never calls it, and a plugin in a
  terminated process has no channel left. The `turn.stop.observe` rationale
  records the limit: through the background service, a hook still running when
  `run` exits completes; under `--standalone` it is cut off.
