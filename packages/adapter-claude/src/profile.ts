import type { CapabilityProfile } from "@hooknostic/core";

/**
 * Claude Code capability data. Validated against Claude Code 2.1.238
 * (fixtures captured 2026-08-20 on Windows) plus the hooks reference
 * (https://code.claude.com/docs/en/hooks, fetched 2026-08-20).
 *
 * Non-exact levels carry rationale. "Doc-derived" markers in
 * fixtures/claude/2.1/README.md flag cells whose fixtures were not captured
 * from a live session.
 */
export const claudeCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=2.0 <3",
    source: {
      date: "2026-08-20",
      references: [
        "https://code.claude.com/docs/en/hooks",
        "fixtures/claude/2.1 (captured 2.1.238)",
      ],
    },
    matrix: {
      "session.start.observe": { level: "exact" },
      "session.start.context.add": { level: "exact" },

      "session.end.observe": { level: "exact" },

      "prompt.before.observe": { level: "exact" },
      "prompt.before.block": { level: "exact" },
      "prompt.before.context.add": { level: "exact" },

      "tool.before.observe": { level: "exact" },
      "tool.before.block": { level: "exact" },
      "tool.before.requestApproval": { level: "exact" },
      "tool.before.input.replace": { level: "exact" },
      "tool.before.context.add": { level: "exact" },

      "tool.after.observe": { level: "exact" },
      // No documented tool_response replacement channel on PostToolUse.
      // (tool.after.output.replace intentionally absent → unsupported.)
      "tool.after.blockContinuation": {
        level: "approximate",
        rationale:
          "PostToolUse cannot block (the tool already ran, exit 2 is not honored); the reason is surfaced to the model via stderr, which usually but not deterministically stops continuation.",
      },
      "tool.after.context.add": { level: "exact" },

      "tool.error.observe": { level: "exact" },
      "tool.error.context.add": { level: "exact" },

      "permission.request.observe": {
        level: "exact",
        rationale:
          "fires on interactive permission prompts; headless -p sessions decide without prompting, so coverage is interactive-only.",
      },
      "permission.request.block": { level: "exact" },
      "permission.request.context.add": { level: "exact" },

      "context.compact.before.observe": { level: "exact" },
      "context.compact.before.block": { level: "exact" },
      // No context-injection channel at PreCompact → context.add unsupported.

      "context.compact.after.observe": { level: "exact" },

      "agent.start.observe": { level: "exact" },

      "agent.stop.observe": { level: "exact" },
      "agent.stop.prevent": { level: "exact" },

      "turn.stop.observe": { level: "exact" },
      "turn.stop.prevent": { level: "exact" },
    },
  },
];
