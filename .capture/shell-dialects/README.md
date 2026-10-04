# Shell interpreter evidence

Investigation for [issue #30](https://github.com/roryeckel/hooknostic/issues/30),
captured on native Windows on 2026-10-04. This procedure records which process
interprets a shell call and what reaches the hook. It does not add a portable
dialect field or choose its value set.

## Method

No model spend. The real harness binaries connect to the loopback playback
model from `packages/cli/test/harness-playback.ts`.

1. A discovery turn records the tools and argument keys advertised by each
   harness. The driver declines missing tools and command keys.
2. The model scripts one shell call in a fresh scratch project with the
   existing tee template attached. Claude and Codex have isolated configuration
   homes; OpenCode uses isolated configuration and state directories.
3. `interpreter.cjs` runs as the command's Node child and records its own process
   ancestry using Windows `Get-CimInstance Win32_Process`. The direct parent
   image identifies the interpreter actually executing the command. The helper
   PowerShell process doing the query is a child of Node and is not in that
   ancestry.
4. Codex's explicit PowerShell and cmd cases run identical command bytes:
   `node interpreter.cjs`. Shell selectors are scripted model arguments, not
   fabricated hook fields.
5. `promote.mjs` requires successful drives, a written process observation, and
   exactly one native before payload per case. It saves the native envelopes
   and process observations in `observations.json`, redacting only the account
   path segment to `user`. Tool discovery files contain the advertised names
   and shell-tool argument keys.

The hook envelopes are **captured**. Process ancestry is **live-probe** evidence.
Model responses and argument values, including the requested shell selectors,
are constructed. No claim is made about what an unscripted model tends to send.

## Observations

| Harness build | Tool at hook boundary | Requested interpreter | Direct parent of command's Node child |
| --- | --- | --- | --- |
| Claude Code 2.1.286 | `Bash` | default | Git for Windows `bash.exe` |
| Codex 0.156.1 | `Bash` | default | bundled `pwsh.exe` |
| Codex 0.156.1 | `Bash` | `powershell.exe` | bundled `pwsh.exe` |
| Codex 0.156.1 | `Bash` | `cmd.exe` | Windows `cmd.exe` |
| OpenCode 1.18.34 | `bash` | default | Windows `powershell.exe` |
| OpenCode 2.0.20 | `shell` | default | Windows `powershell.exe` |

All six executed cases exited 0 with no playback errors and wrote their process
observation. The three Codex hook inputs are identical:
`tool_name: "Bash"`, `tool_input: { "command": "node interpreter.cjs" }`.
The per-call shell selector is absent at that boundary. The process observation
separately proves that one case executed in cmd and the others in PowerShell.

Claude's discovery did not advertise `PowerShell` in this model configuration.
The existing captured `PowerShell` payload remains in
`fixtures/claude/2.1/pre-tool-powershell.input.json`; this session does not replace
or strengthen its interpreter evidence.

## Reproduce

Build the checkout first with `pnpm run bundle`. Then:

```text
node --experimental-strip-types .capture/shell-dialects/drive.mjs claude
node --experimental-strip-types .capture/shell-dialects/drive.mjs codex
```

For OpenCode v1, put the desired recorded v1 build's npm shim first on `PATH`
and set `HOOKNOSTIC_PLAYBACK_VERSION` to that build's version, then run:

```text
node --experimental-strip-types .capture/shell-dialects/drive.mjs opencode-v1
```

For v2, set `HKN_OPENCODE_BINARY` to its native executable and run:

```text
node --experimental-strip-types .capture/shell-dialects/drive.mjs opencode-v2
node .capture/shell-dialects/promote.mjs
```

Raw output is retained under the ignored `captured/` directory. Review newly
promoted observations before committing them.

## Consequences and limits

A tool name or Windows host does not select a portable grammar: Claude's
`Bash` ran Git Bash, OpenCode's `bash` ran Windows PowerShell, and Codex's
`Bash` covered both PowerShell and cmd. A grammar-dependent parser or rewrite
needs an established interpreter; an unknown interpreter must remain unknown.

This is evidence for the recorded builds and isolated configurations only.
macOS was not exercised. Existing Linux evidence remains in
`.capture/codex-hook-matcher/observations-linux.json`; it is not a new Linux
capture. How to represent PowerShell editions, whether an adapter may use host
platform information, and whether rewrites consult a future dialect field
remain design questions in #30. No SDK, schema, classifier, or rewrite behavior
changes in this investigation.
