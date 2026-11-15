# OpenCode 2.x plugin throws

Question: what does OpenCode 2.x do when a plugin's hook callback throws an
ordinary `Error`, not a deliberate block (#180)? For each hook domain: is the
call denied, does the session fail, or is the error ignored? And where is the
message visible? The answer decides whether the v2 shim must fail open on its
own internal errors, as the v1 and Pi shims do.

## Method

No model spend and no credentials. `throw-plugin.js` is a minimal v2 plugin,
not the Hooknostic shim, so the probe measures the host alone. It registers
every callback the shim registers and records each one it receives. In the one
callback named by `HKN_THROW` (`<domain>:<hook>`), it throws
`hkn-probe-internal-error [<domain>:<hook>]` on every invocation. The event
domain is a second subscription whose loop body throws on
`session.execution.started`, uncaught, as a shim without its own catch would,
so its rejection is unhandled. A separate subscription that never throws
records completions in every case.

`drive.mjs` installs the plugin into a scratch project under
`.opencode/plugins/` and runs the binary against the loopback playback model
(`packages/cli/test/harness-playback.ts`). The model scripts one shell call
that writes `hooknostic-tool.txt` with `hooknostic-original`, then text. Each
case gets a fresh OS-temp root for `HOME`, `USERPROFILE` and all four XDG
homes. Credential-shaped, `OPENCODE*` and `HOOKNOSTIC*` variables are removed.

```bash
node --experimental-strip-types .capture/opencode-v2-plugin-throw/drive.mjs [case...]
HKN_OPENCODE_BINARY=/path/to/opencode node --experimental-strip-types .capture/opencode-v2-plugin-throw/drive.mjs
```

Two modes:

- `run:<domain>` and `run-logs:<domain>`:
  `run --standalone [--print-logs] --auto --format json "Use the shell once, then stop."`
- `serve-allow:<domain>` and `serve-ask:<domain>`:
  `serve --stdio --hostname 127.0.0.1 --port 0 --print-logs`. The driver then
  creates a session whose permission rule is `allow` or `ask`, prompts it,
  replies `once` to a pending permission, and then calls `POST /generate` and
  `/compact`.

The controls are the `none` cases, which throw nothing. For each case the
driver prints one JSON line: the exit code, which callbacks fired and threw,
whether the tool ran (the marker file), the model requests, whether the model
saw the message, whether stdout or stderr carried it, the execution
completions, the permission evaluations, the HTTP statuses, and every state
file outside the project that contains the message. `HKN_RAW_DIR`, if set,
receives each case's raw stdout, stderr, trace and model requests. Raw output
is not committed.

2.2.7 is the global install. 2.0.17, the reference build, was installed with
`npm install --prefix <temp> @opencode/cli@2.0.17`, never globally. Each was
run with `HKN_OPENCODE_BINARY` pointing at its `bin/opencode.exe`. On Windows
that path is required: the serve cases spawn the binary without a shell, which
cannot start npm's `opencode.cmd` shim.

## Observations (Windows 11, Node 24.20.0, 2026-11-14)

All controls passed: the tool ran, the execution succeeded, `/generate` and
`/compact` answered 200, and an `ask` raised a pending permission. OpenCode
2.0.17 and 2.2.7 gave the same result in all 23 cases. A second run of the
committed script on both builds reproduced every case's exit code, callbacks,
tool marker, model requests, completions, permission effects, HTTP statuses
and stream mentions:

| Domain (callback that throws) | Behaviour | Where the message is visible |
| --- | --- | --- |
| tool `execute.before` | Fails closed. The tool did not run. The model received `{"error":{"type":"unknown","message":…}}` as its result. Exit 0. | Model-visible; on `--format json` stdout as the `tool_use` part's `state.error` (`status: "error"`); in the session DB (`opencode.db`). Not on stderr, even with `--print-logs`. |
| tool `execute.after` | Fails closed on the result. The tool ran (marker written), but its result was replaced by the error. Exit 0. | As above. |
| session `prompt` | Fails closed. Exit 1, no model request, no tool. | stdout shows only an error event whose message is `UnexpectedStatus: 500`; `--print-logs` shows an INFO line with the cause and stack. |
| session `context` | Fails closed. `session.execution.failed`, no agent request, exit 1. | stdout `{"type":"error",…message}`; `--print-logs` shows ERROR `Failed to drain Session`. |
| session `title` | Error dropped. The title request was never sent; the session succeeded, the tool ran, exit 0. | Nowhere. |
| session `generate` (serve) | Fails closed. `/generate` answered 500. | Server `--print-logs` INFO with the cause. |
| session `compaction` (serve) | Fails closed. `session.compaction.failed`, and the execution failed. | Server `--print-logs` ERROR. |
| permission `evaluate`, already allowed (`run --auto`, serve `allow`) | Fails closed. Denied: the tool did not run, and the model saw the error. | Model-visible, session DB. Not on stderr. |
| permission `evaluate` with an `ask` (serve) | Fails closed. No pending permission was raised, and the call was denied. | As above. |
| Event subscription (loop body throws, rejection unhandled) | Error dropped. The session succeeded and the server stayed up. | `--print-logs`: `level=ERROR message="unhandled rejection"`. |

- At the host boundary a thrown plain `Error` cannot be told from a
  deliberate block. Both become `type:"unknown"`, and the message becomes
  model-visible. So before #180 the message of a shim bug reached the model
  as if it were a block reason.
- `opencode.log` contained the message only in some cases and runs. Do not
  rely on it.
- The only other state file containing the message was Bun's transpiler cache,
  which holds the compiled plugin, so the message appears there as a source
  literal.

### What escaped the shim before the fix

A scratch check drove the v2 shim, as it was at `3d0f2de4`, with host objects
it could not apply to. Each of these escaped the callback, with nothing
reported:

- `tool.before` with `replaceInput` on a frozen input rejected with
  `TypeError: Cannot delete property 'command'`.
- `tool.after` with `replaceOutput` on a frozen result rejected with
  `TypeError: Cannot assign to read only property 'content'`.
- `prompt` and `context` with a `sessionID` getter that throws rejected. For
  `prompt` the throw came from the callback's own bookkeeping, before dispatch.
- A permission block applied to a frozen evaluation rejected with
  `TypeError: Cannot assign … 'effect'`. Per the table, the host then denies
  even a call it had allowed.
- One subscription event whose `data` getter throws silently ended the shim's
  whole subscription: a good completion after it dispatched no `turn.stop`.

A non-JSON effect is already an HN401 handler error, not an internal error.
The unit tests in `packages/adapter-opencode/src/v2/adapter.test.ts`
(`internal errors (#180)`) replace that scratch check.

Not measured: the TUI, `run` through the background service (without
`--standalone`), Linux and macOS, a throw from plugin `setup`, and thrown
values that are not `Error`s.

## Consequences

- The v2 shim fails open on its own internal errors (#180). Deliberate blocks
  throw a dedicated `HooknosticBlock`. Every host callback is guarded as a
  whole, and anything else is reported as
  `hooknostic internal [<native hook>]: <message>` on `console.error` and
  swallowed. Title is guarded too, although the host drops its errors, so that
  the shim never loses the title request.
- A permission deny that cannot be written onto the evaluation leaves the
  host's own evaluation in place. It never becomes a denial.
- The subscription catches per event. The host only logs an unhandled
  rejection, so without that catch one unreadable event silently ends every
  later `session.start` and `turn.stop` hook.
- Like the handler-error report, the internal-error report is visible only
  under `opencode run --standalone --print-logs`
  (`.capture/opencode-v2-plugin-stderr`). The v2 playback case
  `internal-error` (`packages/cli/test/opencode-v2-playback.test.ts`) passes
  `--print-logs` for that reason. Its frozen input is constructed test
  infrastructure, not a host behaviour.
- `onHookError: "block"` does not extend to internal errors, as on v1 and Pi.
- The v2 profile's `validatedOn` records this probe for both builds.
