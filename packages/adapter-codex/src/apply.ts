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

  if (context.length > 0) {
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
