# Codex CLI 0.148 fixtures

Captured from a real **codex-cli 0.148.0** session on Windows (2026-08-20) via
stdin-teeing command hooks in a trusted project (`.capture/codex`), except
where noted. Payload shapes cross-validated against the JSON Schemas embedded
in the codex binary (`*.command.input` / `*.command.output`, draft-07,
`additionalProperties: false`).

- `*.input.json` — native hook stdin payload.
- `*.canonical.json` — expected canonical event from `decode()` **minus `raw`**
  (tests splice `raw: input` back in).
- `*.output.json` — expected native result from `apply()`.

**One redaction.** The capturing machine's Windows account name is replaced with
`user` throughout — in `cwd` and in `transcript_path`. Nothing else was altered:
these stay Windows paths with their real drive letter, backslash escaping, and
structure, because that shape is itself evidence about what the harness sends.

Provenance:

| Fixture | Source |
| --- | --- |
| session-start, session-end, prompt-submit, pre-tool-bash, post-tool-bash, stop | **captured** 0.148.0 |
| permission-request, subagent-start, subagent-stop | schema-derived from the binary's embedded wire schemas (events did not fire in headless `codex exec` capture) |
| pre-compact, post-compact | schema-derived (compaction impractical to trigger headless) |
| pre-tool-exec-command | **constructed** (2026-08-30): tool args from the 0.151.0 router debug log (`.capture/codex-tools/README.md`), envelope schema-derived. Filed here because the adapter's `>=0.148 <1` profile covers it. **No hook has ever been observed receiving this shape** -- on 0.151.0 the hook boundary translates `exec_command` calls into `Bash`/`command` payloads and drops `workdir`; the fixture pins the defensive `cmd`/`workdir` mapping for a version or surface that passes the router shape through. |
| pre-tool-apply-patch-add, -update-move, -delete, -multi, post-tool-apply-patch-add, pre-tool-view-image | **captured** 0.156.1 (2026-09-27) over the loopback playback model (`.capture/file-tools`): hook payloads native, patch text and paths scripted. `apply_patch` is a freeform tool and reaches hooks as `tool_name: "apply_patch"`, `tool_input: { command: <patch text> }` for every operation; `view_image` as `tool_input: { path }`. Filed here because the adapter's `>=0.148 <1` profile covers it. |
| pre-tool-exec-command-rewrite.output | derived from the above: the `updateShell` lowering under `cmd`, per the same PreToolUse output wire schema as pre-tool-rewrite.output. |
| pre-tool-code-mode, post-tool-code-mode | **captured** 0.156.1 on Windows (2026-09-27), `.capture/codex-code-mode`: the hook payloads for a nested `tools.exec_command` call inside a Code Mode `exec` (`tool_mode: "code_mode_only"`, loopback model). Filed here because the adapter's profile covers 0.156.1. The model's `custom_tool_call` was scripted, so it is constructed, but the hook payloads are verbatim. They have the direct `Bash` shape. `tool_use_id` is Codex's nested id (`exec-<uuid>`), not the model's `call_id`. The paths are a scratch temp project. That the outer `exec` dispatches no hook at all is an observed absence, so it is recorded as live-probe evidence, not in these fixtures. |

Version-0.148.0 ground truth worth noting:

- Repo-level `.codex/hooks.json` uses **PascalCase** event keys and a
  Claude-compatible `{hooks: {Event: [{matcher?, hooks: [{type, command,
  timeout}]}]}}` shape; it is only loaded for **trusted projects**, and each
  hook additionally requires persisted hook trust (`[hooks.state]` hashes in
  `~/.codex/config.toml`) or `--dangerously-bypass-hook-trust`.
- The `plugin_hooks` feature is **removed** in 0.148.0 (`codex features`):
  plugin-bundled `hooks/hooks.json` does not load, contrary to R3 docs.
- `tool_response` is a plain string for shell tools; `turn_id` is present on
  turn-scoped events; `transcript_path` is nullable.
- PreToolUse output wire: `permissionDecision ∈ allow|deny|ask` (not
  "escalate"), `updatedInput`, `additionalContext`; top-level
  `decision ∈ approve|block`.
  `updatedInput` verified honoured live on 0.151.0 (rewritten command reached
  the spawn -- see `.capture/codex-tools/README.md`, write-path verification).
- PermissionRequest output: `hookSpecificOutput.decision.behavior ∈
  allow|deny` (+ `message`); `updatedInput`/`updatedPermissions`/`interrupt`
  are reserved and currently **fail closed**; no context channel.
- PostToolUse output: `decision: "block"` + reason; `updatedMCPToolOutput`
  (MCP tools only); `additionalContext`.
- PreCompact/PostCompact outputs expose no decision — compaction cannot be
  blocked via JSON.
