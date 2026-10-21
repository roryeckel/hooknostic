import type { InvocationContext } from "@hooknostic/core";
import type { HookEvent, HookEventName } from "@hooknostic/sdk";

import { classifyCopilotTool } from "./toolmap.js";

export class CopilotDecodeError extends Error {}

interface CopilotPayload {
  [key: string]: unknown;
}

/**
 * The camelCase event names a hook entry configures, and the PascalCase names
 * that select Copilot's VS Code compatible payload format. Both spellings fire
 * when both are configured; the generated artifacts use the camelCase ones
 * because they keep the runtime tool names (`powershell` beside `bash`), which
 * is what pins a shell dialect.
 */
const NATIVE_TO_CANONICAL: Record<string, HookEventName | undefined> = {
  sessionStart: "session.start",
  sessionEnd: "session.end",
  userPromptSubmitted: "prompt.before",
  userPromptTransformed: undefined,
  preToolUse: "tool.before",
  permissionRequest: "permission.request",
  postToolUse: "tool.after",
  postToolUseFailure: "tool.error",
  preCompact: "context.compact.before",
  agentStop: "turn.stop",
  subagentStart: "agent.start",
  subagentStop: "agent.stop",
  errorOccurred: undefined,
  notification: undefined,

  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "prompt.before",
  PreToolUse: "tool.before",
  PermissionRequest: "permission.request",
  PostToolUse: "tool.after",
  PostToolUseFailure: "tool.error",
  PreCompact: "context.compact.before",
  Stop: "turn.stop",
  SubagentStart: "agent.start",
  SubagentStop: "agent.stop",
  ErrorOccurred: undefined,
};

function stringAt(payload: CopilotPayload, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** The tool input, under the key each event shape uses. */
function inputAt(payload: CopilotPayload, canonical: HookEventName): unknown {
  if (canonical === "permission.request" && payload.toolInput !== undefined) return payload.toolInput;
  if (payload.toolArgs !== undefined) return payload.toolArgs;
  if (payload.tool_input !== undefined) return payload.tool_input;
  return undefined;
}

function toolAt(payload: CopilotPayload, canonical: HookEventName, nativeName: string) {
  const nativeTool = stringAt(payload, "toolName", "tool_name");
  if (nativeTool === undefined) {
    throw new CopilotDecodeError(`${nativeName} event has no toolName`);
  }
  return classifyCopilotTool(nativeTool, inputAt(payload, canonical));
}

/**
 * Tolerant decoder for GitHub Copilot CLI command-hook payloads.
 *
 * The camelCase format carries no event name of its own, so the generated hook
 * entry passes the native event it was registered for as the first argument;
 * `nativeEventName` is that hint. A PascalCase payload states
 * `hook_event_name`, and `permissionRequest` states `hookName`, so both are
 * preferred over the hint when present. `raw` is always the payload exactly as
 * received -- the hint never enters it.
 */
export function decodeCopilot(
  nativeEvent: unknown,
  invocation: InvocationContext,
  nativeEventName?: string,
): HookEvent {
  if (typeof nativeEvent !== "object" || nativeEvent === null) {
    throw new CopilotDecodeError("native event is not an object");
  }
  const payload = nativeEvent as CopilotPayload;
  const stated =
    stringAt(payload, "hook_event_name") ?? (typeof payload.hookName === "string" ? payload.hookName : undefined);
  const nativeName = stated ?? nativeEventName;
  if (nativeName === undefined) {
    throw new CopilotDecodeError("native event has no hook_event_name and no event hint");
  }
  const canonical = Object.hasOwn(NATIVE_TO_CANONICAL, nativeName) ? NATIVE_TO_CANONICAL[nativeName] : undefined;
  if (canonical === undefined) {
    throw new CopilotDecodeError(`unmapped native event "${nativeName}"`);
  }

  const cwd = stringAt(payload, "cwd");
  if (cwd === undefined) throw new CopilotDecodeError(`${nativeName} event has no cwd`);
  const sessionId = stringAt(payload, "sessionId", "session_id");
  const agentId = stringAt(payload, "agentId", "agent_id");
  const parentAgentId = stringAt(payload, "parentAgentId", "parent_agent_id");
  const agentType = stringAt(payload, "agentType", "agent_type");

  const base = {
    schemaVersion: 1 as const,
    harness: {
      id: "copilot",
      ...(invocation.harnessVersion !== undefined ? { version: invocation.harnessVersion } : {}),
      nativeEvent: nativeName,
    },
    session: {
      ...(sessionId !== undefined ? { id: sessionId } : {}),
      cwd,
    },
    correlation: {
      ...(agentId !== undefined ? { agentId } : {}),
      ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    },
    raw: nativeEvent,
  };

  switch (canonical) {
    case "session.start": {
      const how = stringAt(payload, "source");
      return { ...base, event: "session.start", ...(how !== undefined ? { how } : {}) };
    }
    case "session.end": {
      const reason = stringAt(payload, "reason");
      return { ...base, event: "session.end", ...(reason !== undefined ? { reason } : {}) };
    }
    case "prompt.before":
      return { ...base, event: "prompt.before", prompt: stringAt(payload, "prompt") ?? "" };
    case "tool.before":
      return { ...base, event: "tool.before", tool: toolAt(payload, canonical, nativeName) };
    case "tool.after": {
      const output = payload.toolResult ?? payload.tool_result;
      return { ...base, event: "tool.after", tool: toolAt(payload, canonical, nativeName), output };
    }
    case "tool.error": {
      const error = payload.error;
      const message =
        typeof error === "string"
          ? error
          : typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : undefined;
      return {
        ...base,
        event: "tool.error",
        tool: toolAt(payload, canonical, nativeName),
        error: { ...(message !== undefined ? { message } : {}) },
      };
    }
    case "permission.request":
      return { ...base, event: "permission.request", tool: toolAt(payload, canonical, nativeName) };
    case "context.compact.before": {
      const trigger = stringAt(payload, "trigger");
      return { ...base, event: "context.compact.before", ...(trigger !== undefined ? { trigger } : {}) };
    }
    case "agent.start": {
      const agent = {
        ...(agentId !== undefined ? { id: agentId } : {}),
        ...(agentType !== undefined ? { type: agentType } : {}),
      };
      return { ...base, event: "agent.start", agent };
    }
    case "agent.stop": {
      const lastMessage = stringAt(payload, "response", "last_assistant_message");
      const agent = {
        ...(agentId !== undefined ? { id: agentId } : {}),
        ...(agentType !== undefined ? { type: agentType } : {}),
      };
      return {
        ...base,
        event: "agent.stop",
        agent,
        ...(lastMessage !== undefined ? { lastMessage } : {}),
      };
    }
    case "turn.stop":
      return { ...base, event: "turn.stop" };
    default:
      throw new CopilotDecodeError(`unmapped canonical event "${canonical}"`);
  }
}
