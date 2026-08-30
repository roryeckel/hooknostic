import type { CapabilityProfile } from "@hooknostic/core";

/**
 * Codex CLI capability data. Validated against codex-cli 0.148.0 (fixtures
 * captured 2026-08-20 on Windows) and the wire JSON Schemas embedded in the
 * 0.148.0 binary (`*.command.input` / `*.command.output`). Vendor docs
 * (https://developers.openai.com/codex/hooks → learn.chatgpt.com/docs/hooks,
 * fetched 2026-08-20) were used as secondary sources; where docs and the
 * binary disagreed, the binary won (e.g. `plugin_hooks` is removed, and
 * `permissionDecision` uses "ask", not an escalate variant).
 */
export const codexCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=0.140 <1",
    source: {
      date: "2026-08-20",
      references: [
        "codex-cli 0.148.0 embedded wire schemas",
        "fixtures/codex/0.148 (captured 0.148.0)",
        "https://learn.chatgpt.com/docs/hooks",
        "Stop output semantics verified live on 0.148.0 (.capture/codex-output)",
      ],
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
        rationale: "permissionDecision \"ask\" surfaces a native approval prompt.",
      },
      "tool.before.input.replace": {
        level: "exact",
        rationale:
          "vendor protocol requires permissionDecision \"allow\" alongside updatedInput, so a rewrite also resolves the permission decision.",
      },
      "tool.before.context.add": { level: "exact" },

      "tool.after.observe": { level: "exact" },
      "tool.after.output.replace": {
        level: "approximate",
        rationale:
          "only MCP tool outputs are replaceable (updatedMCPToolOutput); shell/file tool outputs cannot be replaced.",
      },
      "tool.after.blockContinuation": { level: "exact" },
      "tool.after.context.add": { level: "exact" },

      // No PostToolUseFailure equivalent in 0.148.0 → tool.error unsupported.

      "permission.request.observe": { level: "exact" },
      "permission.request.block": {
        level: "exact",
        rationale: "hookSpecificOutput.decision.behavior \"deny\" with message.",
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
      // notify is UNSUPPORTED on both stop events. `systemMessage` is accepted by
      // the stop.command.output / subagent-stop.command.output wire schemas --
      // a live 0.148.0 run validates cleanly and logs "Stop Completed" -- but
      // 0.148.0 has no rendering path for it and the message appears nowhere.
      // Accepted-and-discarded is not support: claiming it would make a portable
      // hook lose every notice on this target, silently.
    },
  },
];
