import type { CapabilityProfile } from "@hooknostic/core";

/**
 * Claude Code capability data. Non-exact levels carry rationale; per-fixture
 * provenance (captured vs doc-derived cells) lives in
 * fixtures/claude/2.1/README.md. Version facts live in `source.validatedOn`,
 * not prose.
 */
export const claudeCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=2.0 <3",
    source: {
      date: "2026-08-29",
      validatedOn: [
        {
          version: "2.1.238",
          date: "2026-08-20",
          method: "captured",
          artifact: "fixtures/claude/2.1",
          what: "hook payload fixtures for every observable event, captured on Windows",
        },
        {
          version: "2.1.250",
          date: "2026-08-29",
          method: "live-probe",
          artifact: ".capture/claude-output",
          what: "Stop/SubagentStop output semantics (systemMessage rendering) verified live",
        },
        {
          version: "2.1.250",
          date: "2026-08-30",
          method: "captured",
          artifact: "fixtures/claude/2.1",
          what: "PowerShell PreToolUse payload; pins that PowerShell shares Bash's command key",
        },
        {
          version: "2.1.250",
          date: "2026-09-01",
          method: "live-probe",
          artifact: "packages/cli/test/harness-playback.test.ts",
          what: "PermissionRequest deny honored end to end in an interactive pty session only when encoded as hookSpecificOutput.decision.behavior; the permissionDecision spelling is silently ignored there (matches upstream anthropics/claude-code#19298)",
        },
        {
          version: "2.1.263",
          date: "2026-09-07",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "Windows PTY approval probe: PreToolUse permissionDecision ask overrides preallowed Bash and requires confirmation; escalate is rejected as invalid",
        },
        {
          version: "2.1.238",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/claude-permission-mode",
          what: "Interactive sessions start in the prompting mode (hook permission_mode default, PermissionRequest fires), and --permission-mode manual keeps it; an inherited CLAUDE_CODE_CHILD_SESSION turns transcript saving off",
        },
        {
          version: "2.1.283",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/claude-permission-mode",
          what: "Interactive sessions start in auto mode: the scripted Bash call reaches PreToolUse with permission_mode auto and PermissionRequest never fires; --permission-mode manual restores the prompting mode and PermissionRequest, and the pty playback scenarios pass with it",
        },
        {
          version: "2.1.283",
          date: "2026-09-27",
          method: "captured",
          artifact: "fixtures/claude/2.1",
          what: "Write, Edit and NotebookEdit PreToolUse payloads over the loopback model (.capture/file-tools): Write/Edit name the path file_path, NotebookEdit notebook_path; MultiEdit is no longer advertised",
        },
        // scheduled-playback: at most one rolling live-probe record, rewritten
        // in place by scripts/record-playback-validation.mjs (harness-watch
        // workflow). Git history is the audit trail; see ADR-0009 and
        // .capture/harness-playback/README.md. Keep field order stable.
        // scheduled-playback:begin
        {
          version: "2.1.289",
          date: "2026-10-04",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "scheduled model-free playback vs a newer build: artifact discovery, rewrite/block markers, and lifecycle events verified",
        },
        // scheduled-playback:end
      ],
      notes: ["https://code.claude.com/docs/en/hooks (fetched 2026-08-20)"],
    },
    // Optional event fields (ADR-0027): exactly what the captured fixtures in
    // fixtures/claude/2.1 carry. prompt_id is on every payload except
    // SessionStart; agent_id is claimed only where a fixture shows it (the
    // subagent events), not on events fired inside a subagent, which no
    // capture has recorded.
    fields: {
      "session.start.how": { level: "exact" },
      "session.end.reason": { level: "exact" },
      "session.end.correlation.turnId": { level: "exact" },
      "prompt.before.correlation.turnId": { level: "exact" },
      "tool.before.correlation.turnId": { level: "exact" },
      "tool.before.correlation.toolCallId": { level: "exact" },
      "tool.after.correlation.turnId": { level: "exact" },
      "tool.after.correlation.toolCallId": { level: "exact" },
      "tool.error.error.message": { level: "exact" },
      "tool.error.correlation.turnId": { level: "exact" },
      "tool.error.correlation.toolCallId": { level: "exact" },
      "permission.request.correlation.turnId": { level: "exact" },
      "permission.request.correlation.toolCallId": { level: "exact" },
      "context.compact.before.trigger": { level: "exact" },
      "context.compact.before.correlation.turnId": { level: "exact" },
      "context.compact.after.correlation.turnId": { level: "exact" },
      "agent.start.agent.id": { level: "exact" },
      "agent.start.agent.type": { level: "exact" },
      "agent.start.correlation.turnId": { level: "exact" },
      "agent.start.correlation.agentId": { level: "exact" },
      "agent.stop.agent.id": { level: "exact" },
      "agent.stop.agent.type": { level: "exact" },
      "agent.stop.lastMessage": { level: "exact" },
      "agent.stop.correlation.turnId": { level: "exact" },
      "agent.stop.correlation.agentId": { level: "exact" },
      "turn.stop.lastMessage": { level: "exact" },
      "turn.stop.correlation.turnId": { level: "exact" },
    },
    matrix: {
      "session.start.observe": { level: "exact" },
      "session.start.context.add": { level: "exact" },

      "session.end.observe": { level: "exact" },

      "prompt.before.observe": { level: "exact" },
      "prompt.before.block": { level: "exact" },
      "prompt.before.context.add": { level: "exact" },

      // Claude Code exposes no per-model-request lifecycle point: no hook sits
      // between system-prompt assembly and the model request. model.request.before
      // is therefore absent entirely rather than rated unsupported -- a defined
      // .observe cell would advertise the event and require a native fixture.
      // Capability analysis rejects a hook on it first (HN202).

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
      "agent.stop.notify": { level: "exact" },

      "turn.stop.observe": { level: "exact" },
      "turn.stop.prevent": { level: "exact" },
      "turn.stop.notify": { level: "exact" },
    },
  },
];
