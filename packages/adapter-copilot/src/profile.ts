import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { CapabilityProfile } from "@hooknostic/core";

import { copilotHarness } from "./harness.js";
import { COPILOT_SKILL_POLICY_VALIDATION } from "./skill-policy.js";

const CAPTURE = ".capture/copilot/README.md";
const FIXTURES = "fixtures/copilot/1.0";

/**
 * Facts every Copilot profile and Agent Plugin projection may cite. One home
 * for the capture record, so a projection cannot claim a session the adapter
 * profile does not name.
 */
export const copilotValidationRecords: AgentPluginProjectionProfile["source"]["validatedOn"] = [
  {
    version: "1.0.101",
    date: "2026-10-20",
    method: "captured",
    artifact: FIXTURES,
    what: "camelCase and VS Code compatible (PascalCase) hook payloads for every advertised event, captured on Windows over the model provider, including tool argument shapes and the permissionRequest payload.",
  },
  {
    version: "1.0.101",
    date: "2026-10-21",
    method: "captured",
    artifact: FIXTURES,
    what: "Interactive /compact produced preCompact with trigger manual and transcriptPath; the capture is fixtures/copilot/1.0/pre-compact.input.json.",
  },
  {
    version: "1.0.101",
    date: "2026-10-20",
    method: "live-probe",
    artifact: CAPTURE,
    what: "Effect channels verified by effect: preToolUse deny/ask/modifiedArgs/additionalContext, postToolUse modifiedResult/additionalContext, postToolUseFailure additionalContext, permissionRequest allow/deny, agentStop block with its eight-block guard, and sessionStart context injection.",
  },
  {
    version: "1.0.101",
    date: "2026-10-20",
    method: "live-probe",
    artifact: CAPTURE,
    what: "Interactive preToolUse approval: a hook returning permissionDecision ask surfaced the native Hook permission request; Yes ran the command, while No/Esc denied it. The session log recorded approved and denied-interactively-by-user, and the marker file appeared only on approval.",
  },
  {
    version: "1.0.101",
    date: "2026-10-20",
    method: "live-probe",
    artifact: CAPTURE,
    what: "Session routing: repository hooks need folder trust and load from the session's cwd, userPromptSubmitted exit 2 and additionalContext are dropped, a resume payload reports source resume, and preToolUse command hooks are fail-closed on non-zero exit.",
  },
  {
    version: "1.0.101",
    date: "2026-10-20",
    method: "live-probe",
    artifact: CAPTURE,
    what: "Shell interpreters observed by effect: the Windows powershell tool ran Windows PowerShell 5.1 and the only shell tool advertised there, while the Linux bash tool ran /usr/bin/bash.",
  },
  {
    version: "1.0.101",
    date: "2026-10-21",
    method: "live-probe",
    artifact: ".capture/shell-dialects",
    what: "macOS arm64 shell interpreter: Copilot's bash tool ran /bin/bash, so the posix pin holds on macOS as well as Linux. The run is recorded in .capture/shell-dialects/observations-macos-copilot.json.",
  },
  {
    version: "1.0.101",
    date: "2026-10-20",
    method: "live-probe",
    artifact: CAPTURE,
    what: "Agent Plugins 1.0 plugin facts: skills and mcp.json load through --plugin-dir, ${PLUGIN_ROOT} and ${PLUGIN_DATA} expand in command, args, env and cwd, ambient variables also expand there and in remote headers, com.github.copilot hooks fire, and a local marketplace install is loaded live without copying or installing dependencies.",
  },
  {
    version: "1.0.101",
    date: "2026-10-20",
    method: "live-probe",
    artifact: CAPTURE,
    what: "Skill text: a loaded skill's context carries its Base directory but the body shows ${SKILL_DIR}, ${PLUGIN_ROOT}, ${PLUGIN_DATA} and $CLAUDE_SESSION_ID as written.",
  },
  {
    version: "1.0.101",
    date: "2026-10-21",
    method: "live-probe",
    artifact: CAPTURE,
    what: "Unclaimed channels probed by effect: userPromptSubmitted {decision: block} kept the prompt from the model and modifiedPrompt replaced its model-facing text; postToolUse {decision: block} replaced the result and stopped a sequential run, dropping additionalContext beside it; continue:false, systemMessage on both stop events, permissionRequest additionalContext, and preCompact block (JSON or exit 2) and additionalContext were all ignored.",
  },
  {
    version: "1.0.101",
    date: "2026-10-21",
    method: "live-probe",
    artifact: CAPTURE,
    what: "Hook loader and MCP expansion: a malformed entry rejects a plugin hooks.json whole but only itself in .github/hooks; ${NAME}, ${NAME:-fallback} and bare $NAME expand in stdio command, args, env and cwd and in remote url and header values, header names never; a plugin stdio cwd outside the specification forms runs in the plugin root.",
  },
  COPILOT_SKILL_POLICY_VALIDATION,
];

/**
 * GitHub Copilot CLI capability data.
 *
 * The hook surface is the documented camelCase format, with the VS Code
 * compatible payload shape decoded as well. Non-exact levels carry a
 * rationale; captured effect evidence lives in .capture/copilot/README.md.
 */
export const copilotCapabilityProfiles: CapabilityProfile[] = [
  {
    range: copilotHarness.recommendedRange,
    source: {
      date: "2026-10-20",
      validatedOn: [
        ...copilotValidationRecords,
        // scheduled-playback: at most one rolling live-probe record, rewritten
        // in place by scripts/record-playback-validation.mjs (harness-watch
        // workflow). Git history is the audit trail; see ADR-0009 and
        // .capture/harness-playback/README.md. Keep field order stable.
        // scheduled-playback:begin
        // scheduled-playback:end
      ],
      notes: [
        "https://docs.github.com/en/copilot/reference/hooks-reference (fetched 2026-10-20)",
        "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins (fetched 2026-10-20)",
      ],
    },
    fields: {
      "session.start.how": { level: "exact" },
      "session.end.reason": { level: "exact" },
      "context.compact.before.trigger": { level: "exact" },

      "tool.before.correlation.agentId": { level: "exact" },
      "tool.before.correlation.parentAgentId": { level: "exact" },

      "tool.error.error.message": { level: "exact" },

      "agent.start.agent.id": { level: "exact" },
      "agent.start.agent.type": { level: "exact" },
      "agent.start.correlation.agentId": { level: "exact" },
      "agent.start.correlation.parentAgentId": { level: "exact" },

      "agent.stop.agent.id": { level: "exact" },
      "agent.stop.agent.type": { level: "exact" },
      "agent.stop.lastMessage": { level: "exact" },
      "agent.stop.correlation.agentId": { level: "exact" },
      "agent.stop.correlation.parentAgentId": { level: "exact" },

      "turn.stop.correlation.agentId": { level: "exact" },
      "turn.stop.correlation.parentAgentId": { level: "exact" },
    },
    matrix: {
      "session.start.observe": { level: "exact" },
      "session.start.context.add": { level: "exact" },

      "session.end.observe": { level: "exact" },

      "context.compact.before.observe": {
        level: "exact",
        rationale:
          'Notification only: an interactive /compact still completed after preCompact returned {decision: "block"} or exited 2, and additionalContext there did not reach the model (all captured). No postCompact payload or post-compaction sessionStart fired, so context.compact.after has no channel.',
      },

      "prompt.before.observe": {
        level: "exact",
        rationale: "Fires once per submitted prompt, before userPromptTransformed and the first model request.",
      },
      "prompt.before.block": {
        level: "exact",
        rationale:
          '{decision: "block", reason} on exit 0 kept the prompt from the model: no user message or model turn followed, and the reason was shown. Exit 2 alone did not stop the turn, so the adapter never relies on it.',
      },
      "prompt.before.context.add": {
        level: "emulated",
        rationale:
          "additionalContext on userPromptSubmitted is dropped, but modifiedPrompt reaches the model while the session timeline keeps the typed prompt (captured, though the hook reference says config-file output is dropped). The context is appended to the prompt text, so the model reads it as part of the user message rather than as separate context.",
      },

      "tool.before.observe": { level: "exact" },
      "tool.before.block": { level: "exact" },
      "tool.before.requestApproval": {
        level: "exact",
        rationale:
          'permissionDecision "ask" surfaces the native "Hook permission request" dialog in an interactive session; the captured Yes ran the command and the captured No/Esc denied it. A headless -p session has no user and denies with "unable to ask user for confirmation".',
      },
      "tool.before.input.replace": { level: "exact" },
      "tool.before.context.add": {
        level: "exact",
        rationale:
          "additionalContext on preToolUse is consumed and reaches the model, though the hook reference does not list it; verified by an injected token the model quoted.",
      },

      "tool.after.observe": { level: "exact" },
      "tool.after.output.replace": {
        level: "exact",
        rationale:
          "Lowered to the native modifiedResult success result. The native field is text (textResultForLlm), so a non-string portable replacement is JSON-encoded.",
      },
      "tool.after.blockContinuation": {
        level: "approximate",
        rationale:
          '{decision: "block", reason} replaces the result the model sees with "Tool result blocked: <reason>" (captured); the tool already ran and the turn continues, so stopping depends on the model honouring the reason. In the captured sequential run it made no further call. An additionalContext beside the block is dropped, so context from the same dispatch is joined to the reason.',
      },
      "tool.after.context.add": { level: "exact" },

      "tool.error.observe": { level: "exact" },
      "tool.error.context.add": {
        level: "exact",
        rationale:
          "Lowered to the documented JSON additionalContext field on exit 0. A captured exit-2 form with plain stdout was dropped by 1.0.101, so the adapter never relies on it.",
      },

      "permission.request.observe": {
        level: "exact",
        rationale:
          "Fires before the permission service even in a -p session with --allow-all-tools; read and hook permission kinds short-circuit before it.",
      },
      "permission.request.block": { level: "exact" },
      // additionalContext beside behavior "allow" did not reach the model
      // (captured) -> permission.request.context.add unsupported.

      "agent.start.observe": { level: "exact" },

      "agent.stop.observe": { level: "exact" },
      "agent.stop.prevent": {
        level: "approximate",
        rationale:
          'decision "block" forces another subagent turn (verified). A captured session-scoped subagentStop hook blocked more than forty consecutive completions: the documented eight-block guard was not observed to bound it, and the canonical event carries no stop_hook_active field, so a handler that always prevents can loop indefinitely.',
      },

      "turn.stop.observe": { level: "exact" },
      "turn.stop.prevent": {
        level: "exact",
        rationale:
          'decision "block" with a reason forces another turn; the harness stopped after eight consecutive blocks and set stop_hook_active.',
      },
      // systemMessage on agentStop and subagentStop, and decision "allow" with a
      // reason, showed the user nothing (captured) -> *.notify unsupported.
    },
  },
];
