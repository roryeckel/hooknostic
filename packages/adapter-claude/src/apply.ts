import type { HookResult } from "@hooknostic/sdk";
import type { InvocationContext, NativeHookResult } from "@hooknostic/core";

const NATIVE_EVENT: Record<string, string> = {
  "session.start": "SessionStart",
  "session.end": "SessionEnd",
  "prompt.before": "UserPromptSubmit",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
  "tool.error": "PostToolUseFailure",
  "permission.request": "PermissionRequest",
  "context.compact.before": "PreCompact",
  "context.compact.after": "PostCompact",
  "agent.start": "SubagentStart",
  "agent.stop": "SubagentStop",
  "turn.stop": "Stop",
};

/**
 * Encode a composed HookResult into Claude Code's native control output.
 * Strict writer: only documented fields are emitted, and event-specific
 * blocking distinctions are preserved — exit code 2 is used only where
 * Claude honors it (Stop/SubagentStop/PreCompact prevention and the
 * approximate PostToolUse continuation-block), never as a generic deny.
 */
export function applyClaude(
  result: HookResult,
  _nativeEvent: unknown,
  _invocation: InvocationContext,
): Promise<NativeHookResult> {
  const context = result.effects
    .filter((e) => e.effect.kind === "addContext")
    .map((e) => (e.effect as { context: string }).context);
  const terminal =
    result.terminatedBy !== undefined
      ? result.effects[result.effects.length - 1]?.effect
      : undefined;
  const replacedInput = [...result.effects]
    .reverse()
    .find((e) => e.effect.kind === "replaceInput")?.effect as
    | { input: unknown }
    | undefined;

  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: NATIVE_EVENT[result.event] ?? result.event,
  };
  let hasJsonOutput = false;

  if (context.length > 0) {
    hookSpecificOutput["additionalContext"] = context.join("\n");
    hasJsonOutput = true;
  }
  if (replacedInput !== undefined) {
    hookSpecificOutput["updatedInput"] = replacedInput.input;
    hasJsonOutput = true;
  }

  switch (terminal?.kind) {
    case "block": {
      if (result.event === "tool.before" || result.event === "permission.request") {
        hookSpecificOutput["permissionDecision"] = "deny";
        hookSpecificOutput["permissionDecisionReason"] = terminal.reason;
        hasJsonOutput = true;
        break;
      }
      // prompt.before / context.compact.before: exit 2 blocks and surfaces
      // the reason via stderr on these events.
      return Promise.resolve({ exitCode: 2, stderr: terminal.reason });
    }
    case "requestApproval": {
      hookSpecificOutput["permissionDecision"] = "escalate";
      if (terminal.reason !== undefined) {
        hookSpecificOutput["permissionDecisionReason"] = terminal.reason;
      }
      hasJsonOutput = true;
      break;
    }
    case "preventStop": {
      // Stop/SubagentStop: exit 2 prevents stopping; stderr reason is shown.
      return Promise.resolve({
        exitCode: 2,
        stderr: terminal.reason ?? "hooknostic: continue working",
      });
    }
    case "blockContinuation": {
      // Approximate on Claude: the tool already ran and exit 2 is not
      // honored as a hard block on PostToolUse, but stderr reaches the model.
      return Promise.resolve({ exitCode: 2, stderr: terminal.reason });
    }
    default:
      break;
  }

  if (!hasJsonOutput) {
    return Promise.resolve({ exitCode: 0 });
  }
  return Promise.resolve({ exitCode: 0, body: { hookSpecificOutput } });
}
