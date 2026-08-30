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

  const notices = result.effects
    .filter((e) => e.effect.kind === "notify")
    .map((e) => (e.effect as { message: string }).message);

  // `systemMessage` is a TOP-LEVEL field, not part of hookSpecificOutput, so the
  // response has to be assembled as a body rather than as a lone
  // hookSpecificOutput. Verified on 2.1.250: it renders as
  // {"type":"system","subtype":"informational","content":"Stop says: …"} — seen
  // by the user, never by the model, and it does not affect the turn.
  const body: Record<string, unknown> = {};
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
  if (notices.length > 0) body["systemMessage"] = notices.join("\n");

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
      // Stop/SubagentStop: exit 0 with a top-level `decision` prevents stopping,
      // identically to the exit-2 form this used to emit (both verified on
      // 2.1.250). JSON is what lets a notification ride along in the same
      // response; exit 2 cannot carry a body at all.
      //
      // The enum is "approve"|"block" — NOT "allow"|"deny". A "deny" candidate
      // was rejected outright and did not prevent the stop.
      body["decision"] = "block";
      body["reason"] = terminal.reason ?? "hooknostic: continue working";
      break;
    }
    case "blockContinuation": {
      // Approximate on Claude: the tool already ran and exit 2 is not
      // honored as a hard block on PostToolUse, but stderr reaches the model.
      return Promise.resolve({ exitCode: 2, stderr: terminal.reason });
    }
    default:
      break;
  }

  if (hasJsonOutput) body["hookSpecificOutput"] = hookSpecificOutput;
  if (Object.keys(body).length === 0) {
    return Promise.resolve({ exitCode: 0 });
  }
  return Promise.resolve({ exitCode: 0, body });
}
