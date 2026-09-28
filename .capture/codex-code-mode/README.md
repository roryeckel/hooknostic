# Codex Code Mode hook dispatch

Evidence class: **captured** (hook payloads) and **live-probe** (effects), Codex
CLI **0.156.1** on Windows, 2026-09-27. No model credits: the model is the
loopback playback server. Secondary evidence, labelled **source-derived** where
used: codex-rs at `rust-v0.156.1` (`b412ff32`).

## Question

A live session with a paid model (gpt-5.6-luna, Codex 0.156.1, Windows) in a
consumer repository asked Codex to run `grep -r TODO . > probe.txt`. The
repository's generated `.codex/hooks.json` registered PreToolUse with matcher
`Bash|exec_command|shell`. The model did not call `exec_command`. It made one
`custom_tool_call` named `exec` whose input was JavaScript:

```js
const r = await tools.exec_command({cmd:"grep -r TODO . > probe.txt", workdir:"…", shell:"powershell", yield_time_ms:10000, max_output_tokens:10000}); text(r.output);
```

`codex exec` printed `hook: UserPromptSubmit` and `hook: Stop` but no PreToolUse
line, and the command ran. What does a hook receive under Code Mode, if
anything, for (a) the outer `exec` call and (b) the nested `exec_command`?

## Why Code Mode matters

The 0.156.1 client's cached model catalog (`models_cache.json` in the Codex
home) carries `tool_mode: "code_mode_only"` for gpt-5.6-luna and for every other
gpt-5.6 and gpt-6 entry; only gpt-5.5 omits it. Under `code_mode_only` the
model is offered `exec` (a freeform tool with a lark grammar), `wait`,
`request_user_input`, and `web_search`, and no direct `exec_command`. For
current models Code Mode is the default path, not an experiment.

The offline playback lane never reached it. Its served model info said
`tool_mode: "unified"`, which is not a Codex `ToolMode`, and codex-rs
deserializes an unknown value as omitted (Direct). Codex also never reads
`/models` from an unauthenticated custom provider, so no served value would
have reached it. A static `model_catalog_json` is the route in, and
`playbackModelInfo()` in `packages/cli/test/harness-playback.ts` now builds it.

## Method

```sh
pnpm run bundle
pnpm exec vitest run --config .capture/codex-code-mode/vitest.config.ts
```

`probe.test.ts` runs four drives. Each uses a scratch project, an isolated
`CODEX_HOME` whose `model_catalog_json` holds the playback model with the drive's
`tool_mode`, credential variables removed, and `--dangerously-bypass-hook-trust`.
The hooks are the `.capture/codex-capture` tee template (no matcher, so it
catches every call), plus two recorder groups on PreToolUse and PostToolUse:
`generated`, with the matcher the Codex generator emits for
`match: { kind: "shell" }` (`Bash|exec_command|shell`), and `exec`, which names
the Code Mode tool. The scripted model emits a `custom_tool_call` named `exec`
whose source mirrors the live emission above
(`scriptedCodeModeSource()`), then completes with text. The model-side
envelope is constructed. The hook payloads are verbatim. `observations.json` is
the redacted record.

## Observations

| Drive | `tool_mode` | Model offered | Model called | PreToolUse and PostToolUse received | Groups that fired |
| --- | --- | --- | --- | --- | --- |
| `direct` (control) | default | `exec_command` and the other direct tools | `function_call` `exec_command` | `Bash`, `{command}`, `tool_use_id` = the model's `call_id` | tee, `generated` |
| `codeModeOnly` | `code_mode_only` | `exec`, `wait`, `request_user_input`, `web_search` | `custom_tool_call` `exec` | `Bash`, `{command}`, `tool_use_id` = `exec-<uuid>` | tee, `generated` |
| `codeMode` | `code_mode` | `exec`, `wait`, and the direct tools | `custom_tool_call` `exec` | same as `codeModeOnly` | tee, `generated` |
| `liveShape` | `code_mode_only` | as `codeModeOnly` | `exec` with the live call's nested arguments (`workdir`, `shell: "powershell"`, `yield_time_ms`, `max_output_tokens`) | same as `codeModeOnly` | tee, `generated` |

- **(a) The outer `exec` never reaches a hook.** Neither the catch-all tee nor the
  `exec` matcher group received a PreToolUse or PostToolUse for it, in any drive.
- **(b) Each nested `exec_command` reaches both hooks as `Bash`/`{command}`.** The
  payload has the direct call's shape (`pre-tool-code-mode` and
  `post-tool-code-mode` in `fixtures/codex/0.148`), and the generated matcher
  selects it. Only `tool_use_id` differs: it is Codex's nested call id
  (`exec-<uuid>`), because the model's `call_id` belongs to the outer `exec`.
  `workdir` and `shell` are dropped, as for direct calls (`.capture/codex-tools`).
- The marker file was written in every drive, so the nested command ran.

The live call's argument set dispatches exactly as the minimal one does, so the
live bypass was not argument-dependent. It was not Code Mode either; see
"The live bypass" below.

## Effects (live-probe)

`packages/cli/test/harness-playback.test.ts`, "denies / rewrites a nested
exec_command inside a Code Mode exec". Both drives do the following:

- Build the production artifact with `match: { kind: "shell" }`, targeted at the
  installed build, so the generated native matcher is part of the drive.
- Serve a `code_mode_only` catalog, and assert that the model was offered `exec`
  and no direct `exec_command`.
- Verify the effect. On a deny, the blocked marker is absent. On a rewrite, the
  marker holds the rewritten content. The trace shows one `tool.before` with
  `toolKind: "shell"` and `toolNativeName: "Bash"`.

Both drives failed against a mutant that dropped `Bash` from the generated
matcher's vocabulary, and passed on restore. They skip, with that reason, on a
binary older than this directory's `captured` profile record, which includes
CI's default `referenceVersion` lane.

## Source-derived (codex-rs `rust-v0.156.1`)

- `core/src/tools/code_mode/execute_spec.rs`: `exec` is a `ToolSpec::Freeform`, so
  the router builds a `ToolPayload::Custom` for it.
- `core/src/tools/registry.rs`: the default `pre_tool_use_payload` and
  `post_tool_use_payload` return `None` for any non-`Function` payload, and
  `CodeModeExecuteHandler` overrides neither. The outer `exec` cannot reach a
  hook under any matcher.
- `core/src/tools/code_mode/mod.rs` `submit_nested_tool` passes each nested call to
  `ToolCallRuntime::handle_tool_call_with_source(…, ToolCallSource::CodeMode)`.
  That runs the router, then `registry.dispatch_any_with_state`, the same
  PreToolUse and PostToolUse path direct calls take. Nothing on that path or in
  the hooks crate branches on the source.
  `handlers/unified_exec/exec_command.rs` presents `HookToolName::bash()` with
  `{command: cmd}` whichever way the call arrived. `code_mode/delegate.rs` mints
  the nested id as `exec-<uuid>`.
- `code-mode-runtime/src/runtime/globals.rs`: the V8 isolate exposes `tools`,
  `ALL_TOOLS`, timers, `text`/`image`/`audio`/`generatedImage`, an in-memory
  `store`/`load`, `notify`, `yield_control`, and `exit`. It has no filesystem,
  process, or network API, so a script's side effects go through nested tool
  calls.

## The live bypass

The live session ran in a **linked git worktree**, and Codex loads a linked
worktree's hooks from the root checkout. A read-only `hooks/list` over
`codex app-server` for that session's working directory listed only the root
checkout's `.codex/hooks.json`, which held the consumer's own
UserPromptSubmit and Stop hooks. Nothing from the worktree's generated file was
listed. The `hook:` lines the live run printed belonged to those other hooks, and
no PreToolUse guard was loaded. Captured separately in
[`../codex-worktree-hooks`](../codex-worktree-hooks/README.md).

## Consequences recorded in the adapter

- The toolmap and matcher are unchanged. The nested call arrives as `Bash`, which
  `CODEX_TOOL_KINDS` classifies as shell and the generated matcher names.
- `exec` is deliberately not added to `CODEX_TOOL_KINDS`. No hook ever receives
  it, so an entry would be dead, and it would imply a guard could see the script.
- The profile's `tool.before.block` stays exact, with a Code Mode rationale.
  `tool.before.observe` records that the script itself is invisible to hooks.
- For portable hooks: a shell guard judges each nested command on its own, as it
  would a series of direct calls. It never sees the script that composes them.

## Limits

- Windows only. The hook dispatch path is platform-independent code, but Linux
  and macOS were not run.
- Nested non-shell tools (`apply_patch`, MCP) were not driven inside Code Mode.
  Source says they take the same registry path; their handlers override the hook
  payload the same way they do for direct calls.
- A nested call made after a cell yields and resumes through `wait` was not
  exercised.
- The model-side `custom_tool_call` is constructed. The live model's emission
  shape comes from the consumer's session rollout, which is not committed.
