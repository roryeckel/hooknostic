# Writing hooks safely

A hook source is not a program. It is bundled into an artifact that each harness runs
in its own way, and a few habits that are harmless in ordinary Node code break that
contract — usually silently, because hook dispatch is fail-open. Read this before you
ship a hook that other people will run.

## Keep stdout for the harness

Claude Code and Codex run your artifact as a command and read its **stdout as the
hook's reply**, parsed as JSON. Anything else written there stops the reply parsing, so
the `block` or rewrite it carried cannot be relied on.

The generated command shims claim stdout before your plugin's modules even load:
`process.stdout` and the global `console` are pointed at a stream that forwards to
stderr, so `console.log`, `process.stdout.write`, piping into stdout,
`process.stdout.end()`, and a `process.stdout` reference captured at module scope all
land on stderr, and that output is flushed before the hook exits. The reply keeps the
real stdout. One case the guard cannot reach:

- **Child processes that inherit stdout.** A `spawn(..., { stdio: "inherit" })` writes
  straight to the harness's pipe. Capture a child's output (`stdio: "pipe"`) and decide
  what to do with it.

For diagnostics, write to stderr (`console.error`) or use `notify(...)` where the
target supports it.

On OpenCode the hook runs inside the harness process rather than as a command, so the
stdout guard does not apply there and anything a handler prints goes wherever OpenCode
sends its own output.

## See why a hook did nothing: `HOOKNOSTIC_DEBUG`

A command hook exits `0` and prints nothing when it receives a payload it cannot
decode — an event outside the portable vocabulary, or malformed input — because a hook
must never break the user's session. Set `HOOKNOSTIC_DEBUG=1` in the harness's
environment to see what happened instead:

```text
hooknostic debug: PreToolUse -> tool.before (shell Bash)
hooknostic debug: effects [no-force-push:block], terminated by no-force-push, 0 errors
```

```text
hooknostic debug: ignored payload: unmapped native event "Notification"
```

The trace goes to stderr. Handler errors and timeouts are reported there with a
`hooknostic` prefix whether or not debugging is on.

## Keep imported modules free of side effects

Your hook source and everything it imports are bundled into one artifact, and every
module's top-level code runs each time the artifact loads — on every dispatch for the
command harnesses. The classic trap is the ESM main-module guard around a CLI:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

After bundling, both sides name the artifact, so the guard is always true and the CLI
runs on every dispatch — typically reading stdin before the dispatcher can. `hooknostic
build` warns about this pattern as **HN502**. Put command-line entry points in modules
your hooks do not import.

## `process.execPath` is not always Node

On Claude Code and Codex the artifact runs under Node, so `process.execPath` is Node.
On OpenCode the hook runs inside the opencode binary, so `process.execPath` is the
harness itself; spawning it with a script path runs the harness's own CLI instead of
your script. When a hook starts a Node subprocess, resolve Node explicitly — for
example, use `process.execPath` only when its basename is `node`/`node.exe`, and fall
back to `node` on `PATH` otherwise.

## A stop hook that prevents must know when to stop

`preventStop` keeps the agent working, and when that turn ends the stop hook runs
again. If the hook prevents every time, the session never ends.

- Claude Code and Codex mark a stop that follows a prevented one with
  `stop_hook_active: true` in the native payload (`event.raw`).
- OpenCode has no such flag and no cap on consecutive prevents.

Give every preventing stop hook its own terminating condition: stop preventing after a
fixed number of attempts, or once the thing it was waiting for has changed, and keep
that state somewhere that survives between dispatches (a file, since a command hook is
a fresh process each time).

## Budget for what the hook waits on

Each hook runs under a timeout (`timeoutMs`, or the global runtime policy). A handler
that outlives it is abandoned and reported on stderr, and dispatch carries on — so a
guard that times out does not block. Size the budget for the slowest thing the hook
actually waits on, and keep string-scanning guards fast.
