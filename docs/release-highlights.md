# Hook authoring without Zod, and every failure in your code reported

0.13.0 moves the SDK's Zod schemas to `@hooknostic/sdk/schemas`, so writing
hooks and configuration no longer needs Zod. Most of the rest is about what
happens when code fails, yours or Hooknostic's. The command shims,
`hooknostic dispatch` and every other command now run your config and hook
source under a guard. A rejection, a timer that throws or a `process.exit` is
reported, rather than ending the process with its own exit code or a stack
trace, and a leaked handle no longer hangs a command. Every shim reports the
errors it absorbs, in one format, and fails open. A new warning, HN110, names
a CLI and an SDK from different releases.

Several of these changes affect exit codes and output that scripts read. The
breaking changes come first, each with its upgrade step.

## Upgrading from 0.12.x

- **Upgrade the SDK and CLI together.** An older CLI's shims import the schemas
  from the SDK root and cannot bundle against this SDK. Keep
  `@hooknostic/sdk`, `@hooknostic/agent-plugin` and the `hooknostic` CLI on
  the same release. From 0.13.0, the CLI warns HN110 when it and the
  project's SDK differ.
- **The SDK's schemas move to `@hooknostic/sdk/schemas`.** Every `*Schema`
  export moves from `@hooknostic/sdk` to the subpath, including
  `runtimeDiagnosticCodeSchema`, `handlerErrorSchema` and `hookResultSchema`.
  Nothing else moves: `definePlugin`, `hook`, `defineConfig`, the effect
  helpers, `RUNTIME_DIAGNOSTIC_CODES` and every type stay at the root. The
  root never loads Zod, at runtime or in its type declarations, and `zod` is
  now an optional peer.

  To upgrade, change the imports:

  ```ts
  import { effectSchema, toolInvocationSchema } from "@hooknostic/sdk/schemas";
  ```

  Code that imports the subpath needs `zod@^4.6.7`. If you added `zod` only
  to satisfy the SDK, you can remove it. If you keep a `zod` dependency, keep
  it at `^4.6.7` or a newer 4.x floor: npm refuses an older one with
  `ERESOLVE`, and under pnpm the build warns HN109. See
  [importing SDK schemas](upgrading/sdk-schemas-subpath.md).
- **Under Yarn Plug'n'Play, run Hooknostic through Yarn.** `npx`, a global
  install and `pnpm dlx` run without the project's PnP runtime, and the build
  now fails with HN504. `yarn dlx` is not supported either. It fails with
  HN504 when the build needs the CLI's own Zod, and can fail on some
  platforms even when it doesn't. A plain-`node` build that used to succeed,
  with misattributed licence notices and two SDK copies in the artifact, now
  fails too. This is intended. To upgrade, add `hooknostic` as a
  devDependency and run `yarn hooknostic`. npm, pnpm and Yarn `node_modules`
  projects are unaffected.
- **Rebuild packages or re-sync projects.** Artifact bytes change even when
  your sources don't, so a project integration created by 0.12.x reports its
  hook files as modified until `sync` runs again. That is expected. Sync,
  then verify.
- **A hook source's exit no longer decides a shim's exit code.** In the
  Claude Code, Codex and Copilot shims, a rejection nothing handles, a timer
  that throws or a call to `process.exit` is reported as one
  `hooknostic internal` line. The hook then exits 0, or with the code its
  hooks decided. So a `process.exit(2)` no longer blocks a Claude Code event
  or denies a Copilot `preToolUse`. Inside a handler, it is that handler's
  error, `the hook source called process.exit(2)`. To upgrade, return
  `block(...)` to block, or set `runtime.onHookError: "block"` so that a
  failing handler blocks where the event can.
- **Commands exit 2 when your config or hook source fails.** `check`,
  `build`, `sync`, `verify`, `recover`, `doctor` and `inspect --config` load
  them under a guard. A load that fails is HN501, and the command exits 2.
  That covers a top-level throw, a `process.exit`, a rejection, a timer that
  throws, a top-level `await` or thenable default export that never settles,
  and a default export that throws when read, from a getter or a proxy. The
  message names the cause, as in
  `failed to load config <path>: the config called process.exit(3)`. Before,
  these exited with your code's own exit code or Node's 1 or 13, exited 0
  without a word, or hung on a leaked handle.
  - A failure after the load is a `hooknostic internal` line, and the command
    still exits 2. That takes precedence over `verify`'s drift exit 1. It does
    not hold back output: `build` or `sync` may already have written its
    changes.
  - A timer or socket your code leaves open no longer keeps a command running
    once it has reported, and a load that fails no longer leaves a
    `hooknostic-eval-*` directory in the temporary directory.
  - To upgrade, expect exit 2 where a script used to see your code's own exit
    code, a crash or a hang, and fix the failure the message names. See
    [design §10.3](design.md#103-error-and-timeout-policy).
- **`hooknostic dispatch` runs under the shims' guard, with new exit codes.**
  - Exit **1** is new. The hook source failed outside a handler, with a
    rejection nothing handles or a timer that throws (at load or later) or a
    `process.exit` after it loaded, or it ended the process before every
    result was written. Each failure is reported on stderr against the event
    it interrupted, as in `hooknostic internal [event 2]: stray rejection`,
    and usually every result line is still written.
  - A load that fails exits **2** with no results. The config fails as it does
    under `check`, with HN501, including when it rejects or throws from a
    timer while it loads. A load that never settles is a load failure, with a
    message that names what it waits on.
  - Before, the hook source's own exit code, Node's 1 or 13 ended the run,
    usually with no result lines.
  - A `process.exit` inside a handler is that handler's error. The run exits
    0 on a command target, as the shim does, or 1 on a module target
    (OpenCode, Pi), with a note that the shim in the harness does not
    intercept it.
  - Exit 2 takes precedence over 1. The staged hook bundle's temporary
    directory is removed even when the run ends early.

  To upgrade, note that a caller that treats any non-zero exit as failure now
  fails on a stray rejection or timer throw in the hook source. Fix it, or pass
  `--unguarded` to keep the previous path, with the hook source's own exit
  code and Node's stack trace; other commands reject the flag. See
  [when the hook source fails outside a handler](testing-your-hooks.md#when-the-hook-source-fails-outside-a-handler)
  and [exit codes](testing-your-hooks.md#exit-codes).
- **Some error and JSON output changes.** A usage or configuration mistake
  prints a plain message, followed by the usage for a usage error. Before, it
  printed `hooknostic: unexpected error:` and a stack. Exit codes are
  unchanged. Under `--json`, a usage error keeps its single JSON line. These
  reports change:
  - **`inspect --config` with a config that fails to load:** `errors` holds
    one `"HN501: <message>"` entry per diagnostic. A new `diagnostics` array
    holds the same diagnostic objects as `check --json`. The report is
    pretty-printed, like inspect's other failures.
  - **`inspect <target> --config` with a target the config does not
    declare:** `errors` reads
    `target "<name>" is not configured; configured targets: ...`, and the
    report is pretty-printed.
  - **`init --local --json` with a path it cannot create:** the report gains
    `created`, the files written before the failure. Its message reads
    `init failed: cannot create <path>: ...`.
  - **`dispatch --events` with a file it cannot read:** it prints
    `cannot read --events "<path>": ...` on stderr, even under a stray
    `--json`, and no longer prints a JSON line on stdout.

  To upgrade, update any parser of these failure reports. Successful
  `inspect --json` output is unchanged.
- **Expect new stderr lines.** Lines starting `hooknostic internal` may appear
  where earlier releases were silent, or where a hook used to end non-zero.
  Each one names an error that was previously swallowed or fatal. The line can
  come from your own config or hook source: a module that fails to load, or a
  rejection, a timer throw or a `process.exit` outside a handler. Its message,
  and its stack under `HOOKNOSTIC_DEBUG`, then point into your code. Otherwise
  it reports a Hooknostic defect worth filing. See
  [writing hooks safely](writing-hooks-safely.md#see-why-a-hook-did-nothing-hooknostic_debug).
- **`__proto__` names are no longer dropped silently.** Zod 4 skipped a record
  entry named `__proto__`, so such a name vanished without a diagnostic. A lone
  `__proto__` target, for example, failed as `configuration declares no
  targets.`
  - `__proto__` now fails with HN501 as a target name, and as a name in
    `components.excludeFor`, `components.mcpOverrides` and a materializer's
    `inputs`.
  - An MCP server may be named `__proto__`.
    `components.mcpOverrides.<target>.servers` now keeps and validates an own
    `__proto__` entry, as `components.mcpEnvironment` already did, and the
    override reaches every adapter's project output.
  - An object literal entry written as `__proto__: {...}` sets the record's
    prototype instead of adding an entry. It now fails with HN501 in all of
    these records, `components.mcpEnvironment` included. 0.12.0 dropped it
    silently, unless its value was an array.
  - Inside `components.mcpEnvironment`, a bad entry no longer hides a bad
    `__proto__` entry or a configuration-level issue, and per-call parse
    options (`error`, `reportInput`) now reach its issues.

  To upgrade, rename a target or key that was `__proto__`. To name an MCP
  server `__proto__`, write the key as a computed `["__proto__"]` key. If your
  code inspects or encodes `hooknosticConfigSchema` rather than only parsing
  with it, five of its fields changed shape: see
  [importing SDK schemas](upgrading/sdk-schemas-subpath.md) and
  [configuration](configuration.md).
- **`runCli` no longer takes over its caller's process.** This affects only
  programs that call the exported `runCli(argv, options)`. It never replaces
  `process.exit`, adds process listeners, claims stdout or forces an exit,
  with or without an `io`. A config or hook source it evaluates behaves like
  any module your program imports. Its `process.exit` ends your process, and
  a handle it leaks keeps your process alive.
  - Since 0.2.0, `runCli(["dispatch", ...])` without an `io` claimed stdout,
    set `process.exitCode`, and armed a forced exit after its results. It now
    does none of these. Without an `io`, whatever the hook source writes to
    stdout, such as its own `console.log`, now shares stdout with the result
    lines. Before, it was moved to stderr.
  - To upgrade, pass an `io` to keep result lines apart from hook output. If
    you relied on the guard, the stdout claim or the forced exit, run the
    `hooknostic` binary as a child process instead.

## What is new

- **HN110: the CLI and the SDK are on different releases.** `check`, `build`,
  `sync` and `verify` compare the CLI's version with that of the
  `@hooknostic/sdk` the build resolves. When they differ, they warn once per
  run, even beside a configuration that fails to load. `doctor` with a project
  configuration warns too, and `recover` warns beside a load failure.
  - Any difference counts, prereleases included. Build metadata is ignored.
  - The message names the SDK's path, relative to the configuration's
    directory when the SDK is inside it, so a committed build report names no
    machine's path.
  - The remedy is to install `hooknostic` at the SDK's version and run that
    CLI: `npx hooknostic` from the project, or `yarn hooknostic` under
    Plug'n'Play.
  - HN110 never changes an exit code. In `--json` output and
    `hooknostic-build.json`, it is one more diagnostic.
- **Generated runtimes bring their own Zod when yours cannot serve.** Every
  runtime still validates effects with Zod. A build uses your project's Zod
  for the SDK's schemas when it is in the SDK's peer range, sharing one copy
  with your code. With no Zod, it uses the CLI's own copy without a word.
  With a Zod outside the range, it uses the CLI's copy and warns HN109,
  naming the Zod it found. That includes Zod 3.24 and older, which have no
  `zod/v4`. The check reads one manifest instead of resolving the import, so
  it adds no nested resolve to a bundle.

## What is fixed

### Shims fail open, and say so

- **OpenCode v2 reports handler errors.** A handler that throws or overruns
  its budget still fails open. The v2 shim now writes the same
  `hooknostic <code> [<hookId>]: <message>` line as the other shims, where
  before it wrote nothing. On OpenCode 2.0.17 and 2.2.7, plugin output is
  visible only under `opencode run --standalone --print-logs`. See
  [the capture](../.capture/opencode-v2-plugin-stderr/README.md).
- **The OpenCode v2 shim fails open on its own errors.** OpenCode 2.x fails
  closed whenever a plugin callback throws. A shim defect therefore denied
  tool calls and permissions, replaced tool results, and failed prompt,
  context, generate and compaction requests. It also showed the internal
  message to the model as if it were a block reason. Every host callback the
  v2 shim registers is now guarded.
  - Deliberate blocks still propagate.
  - A deny that cannot be written falls back to the host's own evaluation.
  - One unreadable event no longer ends the event subscription.

  See [the capture](../.capture/opencode-v2-plugin-throw/README.md).
- **One internal-error report in every shim.** When an OpenCode v1, OpenCode
  v2, Pi, Claude Code, Codex or Copilot shim absorbs an error of its own, it
  writes `hooknostic internal [<native hook>]: <message>` and fails open. The
  stack follows only under `HOOKNOSTIC_DEBUG`. OpenCode v1 and Pi previously
  swallowed these errors silently. The command shims printed
  `hooknostic: <message>` with no newline.
- **Command shims fail open when the hook source fails outside a handler.**
  An async `main()` that rejected, a timer that threw, or a hook source that
  called `process.exit` used to end Claude Code, Codex and Copilot hook
  processes with a non-zero exit, usually with no reply. On Copilot
  `preToolUse`, that exit is a denial. Now each is reported once, and the
  hooks still decide. A decision the shim has made keeps its exit code, so a
  stray failure can neither add nor remove a Claude Code block.
- **Hostile thrown values no longer fail closed.** The shims, and the Pi MCP
  extension's server registration, told errors apart with checks that
  themselves throw on a revoked proxy. A plugin that threw one made a command
  shim exit 1, which is a denial on Copilot `preToolUse`. In the Pi
  extension, the throw stopped the remaining MCP servers from registering.
  The checks and message rendering are now proxy-safe, and they read an
  error's message once.
- **Pi and OpenCode v1 guard host reads.** Pi's per-event setup and OpenCode
  v1's plugin-input reads now sit inside the fail-open boundary.

### Clearer errors from the CLI

- **A config that throws while it is validated is HN501.** A getter or proxy
  trap that throws while the configuration is read now gives
  `failed to load config <path>: reading its default export threw: ...` in
  every command. Before, commands printed an unexpected error with a stack,
  printed a bare message, or crashed while rendering the thrown value.
- **Values that cannot be rendered keep their diagnostic.** A materializer
  provider that throws a null-prototype object or a revoked proxy is now its
  own HN501, not HN301. `dispatch` reports a hook entry that throws one as a
  load failure. An in-process `runCli` call no longer rejects on such a value.
- **An undeclared `--target` is named without an `entry`.** `build` and `check`
  with `--target <name>` on a package-only or components-only configuration
  exited 2 with no diagnostic. They now report HN501 `target "<name>" is not
  declared in the configuration.` A target named twice is analysed once, so a
  successful build no longer writes duplicate diagnostics into
  `hooknostic-build.json`.

### Names that match `Object.prototype` members

- **Adapter and target names are looked up by own key.** A name such as
  `toString`, `constructor` or `__proto__` now fails as unknown in
  `dispatch`, `doctor` and `inspect --config`, where it crashed or gave the
  wrong message. A target with such a name appears in the build report even
  when it fails early, and no longer receives another target's exclusion
  patterns or MCP override.
- **MCP server names are looked up by own key.** An
  `mcpOverrides.<target>.servers` entry named after an `Object.prototype`
  member, with no such server, now fails as an unknown server. Such a server
  no longer breaks Codex's TOML generation, a server named `__proto__` no
  longer gets a non-numeric OpenCode `timeout`, and on both a target-wide
  startup timeout now reaches it. On Claude Code and Pi, which cannot
  represent startup timeouts, a target-wide timeout whose only server is
  `__proto__` now reports HN205.

### Yarn Plug'n'Play

- TODO(#216): `yarn dlx` ... describe the HN110 regression fix and the
  re-measured `yarn dlx` behaviour before release (#216).

### Documentation

- The shell-name lists drop `exec_command`, which never reaches a hook.
- The `tool.shell` and `tool.file` docs, including the SDK's TSDoc, say that
  a view is also absent when the input does not match the captured shape.

## Limits

- **HN109 is a warning, not a fix.** When your Zod is out of range, the SDK's
  schemas use the CLI's copy, but your own code that imports Zod still
  bundles yours, so the artifact carries two. Install a Zod in range to share
  one.
- **Yarn Plug'n'Play needs Yarn's runtime.** `npx`, global installs,
  `pnpm dlx` and `yarn dlx` are unsupported
  ([#190](https://github.com/roryeckel/hooknostic/issues/190)).
- **HN110 compares release numbers, not contents.** A CLI before 0.13.0
  never warns. `dispatch` does not check. `doctor` does not report HN110 for a
  package-only or hooks-only configuration, or for one that fails to load.
  `sync` and `verify` don't check a configuration with no project-delivery
  targets or no `project.root`.
- **On OpenCode v2, reports are visible only with `--print-logs`.**
  `opencode run --standalone --print-logs` is the only path measured to show
  plugin output. The TUI and the background service are unmeasured.
- **The guards cover accidental failures in the `hooknostic` command and the
  shims.** Your code runs as trusted code, and Hooknostic is not a sandbox:
  rearranging Node's process listeners can defeat a guard, and
  `process.kill(process.pid)`, `process.abort()` and `process.reallyExit`
  still end the process. A load that never settles while a leaked handle
  keeps the loop alive still hangs. Attribution to a load or a `dispatch`
  event is best effort, and a `dispatch` run that ends early loses some or
  all of its result lines. `runCli`, `dispatchEvents()`, `buildProject()` and
  the other programmatic APIs install no guard. See
  [design §10.3](design.md#103-error-and-timeout-policy).
- **`onHookError: "block"` does not cover internal errors.** Hooknostic's own
  failures always fail open.
- **No harness support range claim changes.** The new captures add
  `validatedOn` evidence for OpenCode 2.0.17 and 2.2.7 without widening any
  range.

Start with the [README](../README.md).
