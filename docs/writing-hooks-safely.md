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
`process.stdout.end()`, `import { stdout } from "node:process"`, and a
`process.stdout` reference captured at module scope all land on stderr, and that output is flushed before the hook exits. The reply keeps the
real stdout. One case the guard cannot reach:

- **Child processes that inherit stdout.** A `spawn(..., { stdio: "inherit" })` writes
  straight to the harness's pipe. Capture a child's output (`stdio: "pipe"`) and decide
  what to do with it — or use `runProcess` (below), which never inherits.

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

## Run subprocesses with `runProcess`

A hook that shells out — to `git`, a linter, a Python status script, `az` — has four
ways to fail quietly: a child inheriting stdout, a child that outlives the hook's
budget, a Windows `.cmd` shim that Node refuses to start, and an exception that
escapes into dispatch. `runProcess` from `@hooknostic/sdk` handles all four:

```ts
import { join } from "node:path";

import { addContext, hook, runProcess } from "@hooknostic/sdk";

hook("session.start", {
  id: "status",
  capabilities: { "context.add": "required" },
  timeoutMs: 5_000,
  async run(event, ctx) {
    if (!ctx.plugin) return;
    const status = await runProcess("python", [join(ctx.plugin.root, "scripts/status.py"), "--brief"], {
      cwd: event.session.cwd,
      signal: ctx.signal,
    });
    if (status.ok && status.stdout.trim()) return addContext(status.stdout.trim());
  },
});
```

- Output is always captured, and capped (`maxOutputBytes`, default 1 MiB).
- Passing `ctx.signal` kills the child's whole process tree when the hook's timeout
  elapses. The tree matters because a shim or a shell script leaves the real work in a
  grandchild, which killing the direct child would orphan. If the tree cannot be
  killed (for example, `taskkill` is denied access), the direct child is still
  terminated and the failure reports `treeKilled: false`.
- On Windows a bare command name is looked up on `PATH` with `PATHEXT`. A `.cmd` or
  `.bat` file runs through `cmd.exe` with its arguments escaped for a shim that
  forwards `%*`.
- It never throws. A missing program, a timeout or an abort comes back as a
  `failure`, and a non-zero exit as `ok: false` with its `exitCode`.

`ctx.plugin.root` is the package's root on every target (ADR-0020), and is present
only when the build projects a `components.root` package.

## Decide what happens when a tool view is absent

`tool.shell` and `tool.file` are normalized from each harness's captured argument
shapes, and they are absent exactly when that normalization cannot be trusted: a tool
whose shape has never been captured, an input that does not match it, a patch that is
not valid patch grammar, or a search tool that targets no file. The raw `tool.input` is
always present, but reading one harness's key from it is how guards used to compile
everywhere and silently allow everything on the other harnesses.

So make the absent case a decision, not a default:

- **A guard fails closed.** If it cannot read the command or the paths, it refuses:

  ```ts
  const command = tool.shell?.command;
  if (command === undefined) return block(`Unrecognized ${tool.nativeName} input`);
  ```

- **Advice fails open.** A reminder or a rewrite that cannot read its input simply
  says nothing: `if (tool.shell?.command.startsWith("cd ")) …`.
- **Never default to `""`.** `tool.shell?.command ?? ""` looks harmless and makes
  every unreadable command pass every check.

Two limits no view removes. A file read or written *by a shell command* (`cat .env`) is
a shell call, not a file call, so `tool.file` never sees it — and on Codex every read
goes through the shell. A file guard that matters also needs a shell guard. And paths
are reported as the harness sent them, relative or absolute, never resolved.

## Branch on the shell dialect, and decide what unknown means

A shell tool's name does not identify its grammar. `nativeName` is harness
vocabulary: in the [interpreter captures](../.capture/shell-dialects/README.md),
Claude's `Bash` ran Git Bash on Windows, OpenCode's `bash` ran PowerShell, Git
Bash, cmd or tcsh depending on how the host was configured, and Codex's `Bash`
ran PowerShell or cmd under identical hook input.

`tool.shell.dialect` is the grammar family the command will be interpreted in,
where the adapter can establish it: `"posix"`, `"powershell"` or `"cmd"`. A
family, not an interpreter: `posix` is bash or zsh, and `powershell` is either
edition, so a hook cannot assume a PowerShell 7 operator such as `&&`.

| Target | `dialect` |
| --- | --- |
| Claude Code | Set whenever the view is: `Bash` is `posix`, `PowerShell` is `powershell` |
| OpenCode | Set once the harness has stated a shell this adapter maps: bash, zsh, powershell, pwsh or cmd. Absent before that, and for any other shell |
| Codex | Never set: the model picks the interpreter per call, and no hook input says which |
| Pi | `powershell` is `powershell`; `bash` stays unknown because `shellPath` can select different interpreter families without changing the hook input |

`hooknostic inspect <target>` prints the same answer for one target, with the
adapter's reason and its evidence.

**Absent means unknown, not POSIX.** Make that case a decision, as with an absent
view:

```ts
const shell = tool.shell;
if (shell === undefined) return block(`Unrecognized ${tool.nativeName} input`);
switch (shell.dialect) {
  case "posix":
    return guardPosix(shell.command);
  case "powershell":
    return guardPowerShell(shell.command);
  case "cmd":
  case undefined:
    // No parser for this grammar, or no way to know it: a guard refuses.
    return block("Cannot verify this command's shell grammar");
}
```

- **A guard that parses fails closed** on a dialect it has no parser for, and on
  an absent one. A guard that only searches the text for a substring does not
  depend on the grammar and need not branch at all.
- **A rewrite that quotes fails open**: skip it unless the dialect is one it
  writes correctly. `updateShell` places your command under the tool's native
  key and does not quote or translate it.
- **Never branch on `nativeName`** to pick a parser. It is the mistake the field
  exists to remove.

To test these branches, `hooknostic dispatch` takes the dialect the harness
would state: see [testing your hooks](testing-your-hooks.md).
([Decision 0029](decisions/0029-shell-dialect.md))

## Returning more than one effect

A hook returns one effect, or an ordered list of them — `[notify(message),
preventStop(reason)]` — which applies exactly as if consecutive hooks had returned
each. An effect that ends the dispatch (`block`, `requestApproval`, `preventStop`,
`blockContinuation`) must be last; a list with one earlier is rejected whole, with
HN401, before anything in it applies. `undefined` entries are skipped, so
`[shouldNotify ? notify(message) : undefined, preventStop(reason)]` works.
([Decision 0025](decisions/0025-effect-lists.md))

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
