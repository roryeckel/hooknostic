import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { CapabilityProfile } from "@hooknostic/core";

import { copilotHarness } from "./harness.js";

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
    what: "Session routing: repository hooks need folder trust and load from the session's cwd, userPromptSubmitted output is dropped, a resume payload reports source resume, and preToolUse command hooks are fail-closed on non-zero exit.",
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
    what: "Skill text and policy: a loaded skill's context carries its Base directory but the body shows ${SKILL_DIR}, ${PLUGIN_ROOT}, ${PLUGIN_DATA} and $CLAUDE_SESSION_ID as written; disable-model-invocation: true withholds a skill from listing and makes an explicit /skill invocation fail.",
  },
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

      "prompt.before.observe": {
        level: "exact",
        rationale:
          "Fires once per submitted prompt. No blocking or context channel is claimed: command-hook output is dropped for this event (a captured exit 2 did not stop the turn, and additionalContext was not delivered).",
      },

      "tool.before.observe": { level: "exact" },
      "tool.before.block": { level: "exact" },
      "tool.before.requestApproval": {
        level: "exact",
        rationale:
          'permissionDecision "ask" defers to the user\'s permission flow. In the captured headless -p session no user exists, so the call was denied as "unable to ask user for confirmation"; an interactive session\'s native prompt is not captured.',
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
    },
  },
];
