import type { CapabilityProfile } from "@hooknostic/core";

/**
 * Shared by both stop events: `systemMessage` is accepted on the wire and never
 * rendered, which is the one place the three harnesses genuinely diverge.
 */
const NOTIFY_ACCEPTED_AND_DISCARDED =
  'systemMessage is accepted by the stop.command.output / subagent-stop.command.output wire schemas -- a live 0.148.0 run validates cleanly and logs "Stop Completed" -- but 0.148.0 has no rendering path for it and the message appears nowhere. Accepted-and-discarded is not support: claiming it would make a portable hook lose every notice on this target, silently.';

/**
 * Codex CLI capability data. Where docs and the binary disagreed, the binary
 * won (e.g. `permissionDecision` uses "ask", not an escalate variant). Version
 * facts live in `source.validatedOn`, not prose.
 *
 * `plugin_hooks` was read as removed from the 0.148.0 binary. It is not gone on
 * 0.153.2 -- an installed plugin's hook runs (`.capture/codex-plugin-hooks`) --
 * so do not restate that; the reason hooks still cannot ship in a projected
 * package is manifest precedence, recorded on the projector.
 */
export const codexCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=0.140 <1",
    source: {
      date: "2026-08-29",
      validatedOn: [
        {
          version: "0.153.2",
          date: "2026-09-08",
          method: "live-probe",
          artifact: ".capture/codex-plugin-hooks",
          what: 'Hook EFFECTS survive the installed-plugin delivery boundary, not just hook invocation: driven through the offline playback lane, a tool.before deny stopped the tool running and a tool.before input rewrite reached the spawned command. The capability matrix resolves by version and ignores mode, so this is what lets mode: "plugin" advertise the same write channels the local .codex/hooks.json route evidences.',
        },
        {
          version: "0.148.0",
          date: "2026-08-20",
          method: "captured",
          artifact: "fixtures/codex/0.148",
          what: "hook payload fixtures via a trusted teeing project, captured on Windows",
        },
        {
          version: "0.148.0",
          date: "2026-08-20",
          method: "schema-derived",
          artifact: "fixtures/codex/0.148",
          what: "wire JSON Schemas embedded in the binary (*.command.input/output)",
        },
        {
          version: "0.148.0",
          date: "2026-08-29",
          method: "live-probe",
          artifact: ".capture/codex-output",
          what: "Stop output semantics: systemMessage accepted-and-discarded, never rendered",
        },
        {
          version: "0.151.0",
          date: "2026-08-30",
          method: "router-log",
          artifact: ".capture/codex-tools",
          what:
            "exec_command router args (cmd/workdir); NOTE the hook boundary translates " +
            "these calls to Bash/command payloads and drops workdir",
        },
        {
          version: "0.151.0",
          date: "2026-08-30",
          method: "live-probe",
          artifact: ".capture/codex-tools",
          what: "updatedInput write channel verified honoured (rewritten command reached spawn)",
        },
        {
          version: "0.151.0",
          date: "2026-09-02",
          method: "live-probe",
          artifact: ".capture/codex-tools",
          what:
            "PostToolUse updatedMCPToolOutput is REJECTED by the hook engine (fails open with " +
            '"PostToolUse hook returned unsupported updatedMCPToolOutput", run status Failed; ' +
            "matches upstream codex-rs hooks/src/events/post_tool_use.rs " +
            "unsupported_updated_mcp_tool_output_fails_open). tool.after.output.replace is " +
            "therefore unsupported on the hook channel; the output parser also shows the MCP " +
            "connector path (not hooks) is the only output-replacement surface.",
        },
        {
          version: "0.153.2",
          date: "2026-09-14",
          method: "live-probe",
          artifact: ".capture/codex-hook-matcher",
          what:
            "Project PreToolUse matcher is honoured for a shell call on Windows and compared against the " +
            "hook-boundary tool name (Bash, not exec_command); exact word lists and anchored regexes match, " +
            "a bare prefix does not. Non-shell tools, other tool events, MCP names, and POSIX are uncaptured.",
        },
        {
          version: "0.153.2",
          date: "2026-09-14",
          method: "live-probe",
          artifact: ".capture/codex-hook-matcher",
          what:
            "The same PreToolUse matcher probe on Linux x64 (WSL2) produced an identical dispatch table: " +
            "matched against the hook-boundary name Bash, word lists and anchored regexes match, a bare prefix does not. macOS is uncaptured.",
        },
        // scheduled-playback: at most one rolling live-probe record, rewritten
        // in place by scripts/record-playback-validation.mjs (harness-watch
        // workflow). Git history is the audit trail; see ADR-0009 and
        // .capture/harness-playback/README.md. Keep field order stable.
        // scheduled-playback:begin
        // scheduled-playback:end
      ],
      notes: ["https://learn.chatgpt.com/docs/hooks (fetched 2026-08-20)"],
    },
    matrix: {
      "session.start.observe": { level: "exact" },
      "session.start.context.add": { level: "exact" },

      "session.end.observe": { level: "exact" },

      "prompt.before.observe": { level: "exact" },
      "prompt.before.block": { level: "exact" },
      "prompt.before.context.add": { level: "exact" },

      "tool.before.observe": {
        level: "exact",
        rationale:
          "tool-path coverage, not a security boundary: hosted tools (e.g. web_search) bypass hooks and write_stdin does not re-trigger PreToolUse.",
      },
      "tool.before.block": { level: "exact" },
      "tool.before.requestApproval": {
        level: "exact",
        rationale: 'permissionDecision "ask" surfaces a native approval prompt.',
      },
      "tool.before.input.replace": {
        level: "exact",
        rationale:
          'vendor protocol requires permissionDecision "allow" alongside updatedInput, so a rewrite also resolves the permission decision.',
      },
      "tool.before.context.add": { level: "exact" },

      "tool.after.observe": { level: "exact" },
      // The output parser strictly rejects updatedMCPToolOutput from a
      // PostToolUse hook (fails open, run status Failed; captured live on
      // 0.151.0 and pinned by upstream's own
      // unsupported_updated_mcp_tool_output_fails_open test). The
      // updatedMCPToolOutput encoding stays in apply.ts as defensive wire
      // correctness, but no hook can deliver an output replacement here.
      // The output parser strictly rejects updatedMCPToolOutput from a
      // PostToolUse hook (fails open, run status Failed; captured live on
      // 0.151.0 and pinned by upstream's own
      // unsupported_updated_mcp_tool_output_fails_open test). The
      // updatedMCPToolOutput encoding stays in apply.ts as defensive wire
      // correctness, but no hook can deliver an output replacement here; the
      // mcp-stdio playback drive is the inverted watch. The MCP connector
      // path (not hooks) is the only output-replacement surface upstream.
      "tool.after.output.replace": {
        level: "unsupported",
        rationale:
          "the hook engine strictly rejects updatedMCPToolOutput from a PostToolUse hook " +
          '(fails open: run logs "PostToolUse hook returned unsupported updatedMCPToolOutput", ' +
          "status Failed; captured live on 0.151.0, .capture/codex-tools, and pinned by upstream " +
          "codex-rs unsupported_updated_mcp_tool_output_fails_open). Only additionalContext is " +
          "honoured on this event; the MCP connector path is the only output-replacement surface.",
      },
      "tool.after.blockContinuation": { level: "exact" },
      "tool.after.context.add": { level: "exact" },

      // No PostToolUseFailure equivalent in 0.148.0 → tool.error unsupported.

      "permission.request.observe": { level: "exact" },
      "permission.request.block": {
        level: "exact",
        rationale: 'hookSpecificOutput.decision.behavior "deny" with message.',
      },
      // PermissionRequest output wire has no additionalContext channel.

      "context.compact.before.observe": { level: "exact" },
      // pre-compact output wire exposes no decision; `continue:false` halts
      // the turn rather than the compaction → block unsupported.

      "context.compact.after.observe": { level: "exact" },

      "agent.start.observe": { level: "exact" },

      "agent.stop.observe": { level: "exact" },
      "agent.stop.prevent": { level: "exact" },

      "turn.stop.observe": { level: "exact" },
      "turn.stop.prevent": { level: "exact" },

      // Stated explicitly rather than left absent. Absent would resolve to the
      // same level, but `hooknostic inspect` can only print a rationale that
      // belongs to an entry -- and "we checked, and it does not work" is worth
      // more to a user than silence.
      "turn.stop.notify": {
        level: "unsupported",
        rationale: NOTIFY_ACCEPTED_AND_DISCARDED,
      },
      "agent.stop.notify": {
        level: "unsupported",
        rationale: NOTIFY_ACCEPTED_AND_DISCARDED,
      },
    },
  },
];
