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

Provenance:

| Fixture | Source |
| --- | --- |
| session-start, session-end, prompt-submit, pre-tool-bash, post-tool-bash, stop | **captured** 0.148.0 |
| permission-request, subagent-start, subagent-stop | schema-derived from the binary's embedded wire schemas (events did not fire in headless `codex exec` capture) |
| pre-compact, post-compact | schema-derived (compaction impractical to trigger headless) |

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
- PermissionRequest output: `hookSpecificOutput.decision.behavior ∈
  allow|deny` (+ `message`); `updatedInput`/`updatedPermissions`/`interrupt`
  are reserved and currently **fail closed**; no context channel.
- PostToolUse output: `decision: "block"` + reason; `updatedMCPToolOutput`
  (MCP tools only); `additionalContext`.
- PreCompact/PostCompact outputs expose no decision — compaction cannot be
  blocked via JSON.
