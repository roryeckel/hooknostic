import type { HookResult } from "@hooknostic/sdk";
import type { InvocationContext, NativeHookResult } from "@hooknostic/core";

const NATIVE_EVENT: Record<string, string> = {
  "session.start": "SessionStart",
  "session.end": "SessionEnd",
  "prompt.before": "UserPromptSubmit",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
  "permission.request": "PermissionRequest",
  "context.compact.before": "PreCompact",
  "context.compact.after": "PostCompact",
  "agent.start": "SubagentStart",
  "agent.stop": "SubagentStop",
  "turn.stop": "Stop",
};

/**
 * Encode a composed HookResult into Codex's native control output, strictly
 * following the 0.148.0 wire schemas (which are additionalProperties:false —
 * unknown fields are hard errors on the vendor side).
 */
export function applyCodex(
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
  const replacedOutput = [...result.effects]
    .reverse()
    .find((e) => e.effect.kind === "replaceOutput")?.effect as
    | { output: unknown }
    | undefined;

  const body: Record<string, unknown> = {};
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: NATIVE_EVENT[result.event] ?? result.event,
  };
  let hasHookSpecific = false;

  // The stop-family wire schemas have no hookSpecificOutput property at all and
  // are additionalProperties:false, so emitting one there is a hard vendor-side
  // error. Unreachable today (no stop-scoped context capability is registered),
  // but this wire now carries new fields and the guard costs one condition.
  const stopFamily = result.event === "turn.stop" || result.event === "agent.stop";

  if (context.length > 0 && !stopFamily) {
    hookSpecificOutput["additionalContext"] = context.join("\n");
    hasHookSpecific = true;
  }
  if (replacedInput !== undefined && result.event === "tool.before") {
    // 0.148.0 protocol: a rewrite is expressed as allow + updatedInput.
    hookSpecificOutput["permissionDecision"] = "allow";
    hookSpecificOutput["updatedInput"] = replacedInput.input;
    hasHookSpecific = true;
  }
  if (replacedOutput !== undefined && result.event === "tool.after") {
    // Only MCP tool outputs are replaceable on Codex (approximate cell).
    hookSpecificOutput["updatedMCPToolOutput"] = replacedOutput.output;
    hasHookSpecific = true;
  }

  switch (terminal?.kind) {
    case "block": {
      if (result.event === "tool.before") {
        hookSpecificOutput["permissionDecision"] = "deny";
        hookSpecificOutput["permissionDecisionReason"] = terminal.reason;
        delete hookSpecificOutput["updatedInput"];
        hasHookSpecific = true;
      } else if (result.event === "permission.request") {
        hookSpecificOutput["decision"] = { behavior: "deny", message: terminal.reason };
        hasHookSpecific = true;
      } else {
        // prompt.before: decision "block" + reason.
        body["decision"] = "block";
        body["reason"] = terminal.reason;
      }
      break;
    }
    case "requestApproval": {
      hookSpecificOutput["permissionDecision"] = "ask";
      if (terminal.reason !== undefined) {
        hookSpecificOutput["permissionDecisionReason"] = terminal.reason;
      }
      hasHookSpecific = true;
      break;
    }
    case "preventStop": {
      // JSON only. Verified on 0.148.0: exit 2 with a continuation prompt on
      // stderr does NOT prevent a stop here, despite the binary carrying an
      // error string that implies it should. Claude honours both encodings;
      // Codex honours only this one.
      body["decision"] = "block";
      body["reason"] = terminal.reason ?? "hooknostic: continue working";
      break;
    }
    case "blockContinuation": {
      body["decision"] = "block";
      body["reason"] = terminal.reason;
      break;
    }
    default:
      break;
  }

  if (hasHookSpecific) body["hookSpecificOutput"] = hookSpecificOutput;
  if (Object.keys(body).length === 0) {
    return Promise.resolve({ exitCode: 0 });
  }
  return Promise.resolve({ exitCode: 0, body });
}
