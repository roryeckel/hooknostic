# OpenCode 2.x plugin stderr

Question: when a generated OpenCode 2.x shim reports a failed handler on
`console.error` (#175), where can the user see it? `opencode run --help` says
of `--print-logs`: "Print logs to stderr (server logs require --standalone)",
and of `--standalone`: "Run with a private server instead of the background
service". Plugins run in the server process, not the `run` process
(`.capture/opencode-dispose`).

## Method

No model spend and no credentials. `drive.mjs` builds the playback plugin
(`packages/cli/test/harness-playback.ts`) with the checkout's v2 shim, for the
detected harness version. With `HOOKNOSTIC_PLAYBACK_EFFECTS=handler-error` its
`tool.before` handler throws `hooknostic-playback-handler-error` before any other
effect. The binary runs against the loopback playback model, which scripts one
shell call. Each mode gets a fresh OS-temp root for `HOME`, `USERPROFILE` and
all four XDG homes, and credential-shaped and `OPENCODE*` variables are
removed, as in the playback lane.

```bash
node --experimental-strip-types .capture/opencode-v2-plugin-stderr/drive.mjs
HKN_OPENCODE_BINARY=/path/to/opencode node --experimental-strip-types .capture/opencode-v2-plugin-stderr/drive.mjs
```

For each mode the driver records the exit code and whether `tool.before` was
dispatched (the plugin's trace). It records whether the call failed open:
the model's `hooknostic-original` command ran unrewritten. It reports the
shim's report line on stderr, the message anywhere in stdout, every `*.log`
under the isolated root, and every state file outside the scratch project
that contains the message.

| Mode | Arguments after `run` |
| --- | --- |
| `standalone` | `--standalone` |
| `standalone-print-logs` | `--standalone --print-logs` |
| `standalone-debug` | `--standalone --log-level debug` |

2.2.7 is the global install. 2.0.17, the reference build, was installed with
`npm install --prefix <temp> @opencode/cli@2.0.17`, never globally, and run
with `HKN_OPENCODE_BINARY` pointing at its `bin/opencode.exe`.

## Observations (Windows 11, Node 24.20.0, 2026-11-14)

OpenCode 2.0.17 and 2.2.7 gave the same result in every mode:

| Mode | Exit | `tool.before` dispatched, failed open | Report on stderr | On stdout | In a `*.log` |
| --- | --- | --- | --- | --- | --- |
| `standalone` | 0 | yes | no | no | no |
| `standalone-print-logs` | 0 | yes | `hooknostic error [playback-tool.before]: hooknostic-playback-handler-error` | no | no |
| `standalone-debug` | 0 | yes | no | no | no |

- The only log file written was `data/opencode/log/opencode.log`. It records
  the private `serve --stdio --port 0` server's own entries, but never the
  plugin's `console.error`, even at `--log-level debug`.
- The only state file containing the message was Bun's transpiler cache
  (`cache/bun/**/*.pile`), which holds the compiled plugin, so the message
  appears there as a source literal, not as output.
- Under `--print-logs` the report arrived on `run`'s stderr as a whole line.

Not measured: the TUI, `run` through the background service (without
`--standalone`), `--server`, `serve`, Linux and macOS.

## Consequences

- The v2 shim's report is visible only under
  `opencode run --standalone --print-logs` on the measured builds. Elsewhere it
  is not shown, and on the measured paths it is not kept anywhere either.
  `docs/writing-hooks-safely.md` says so, and names the unmeasured paths.
- The v2 playback case `handler-error` (`packages/cli/test/opencode-v2-playback.test.ts`)
  passes `--print-logs` for that reason.
- The v2 profile's `validatedOn` records this probe for both builds.
