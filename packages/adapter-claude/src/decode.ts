import type { InvocationContext } from "@hooknostic/core";
import type { HookEvent } from "@hooknostic/sdk";

import { classifyClaudeTool } from "./toolmap.js";

export class ClaudeDecodeError extends Error {}

interface ClaudePayload {
  session_id?: string;
  cwd?: string;
  prompt_id?: string;
  agent_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  prompt?: string;
  source?: string;
  reason?: string;
  trigger?: string;
  error?: string;
  agent_type?: string;
  last_assistant_message?: string;
  [key: string]: unknown;
}

/**
 * Tolerant decoder for Claude Code command-hook stdin payloads: validates
 * only the fields the canonical event needs, preserves everything (known and
 * unknown) in `raw`, and never invents identifiers.
 */
export function decodeClaude(nativeEvent: unknown, invocation: InvocationContext): HookEvent {
  if (typeof nativeEvent !== "object" || nativeEvent === null) {
    throw new ClaudeDecodeError("native event is not an object");
  }
  const payload = nativeEvent as ClaudePayload;
  const nativeName = payload.hook_event_name;
  if (typeof nativeName !== "string") {
    throw new ClaudeDecodeError("native event has no hook_event_name");
  }
  if (typeof payload.cwd !== "string") {
    throw new ClaudeDecodeError("native event has no cwd");
  }

  const base = {
    schemaVersion: 1 as const,
    harness: {
      id: "claude",
      ...(invocation.harnessVersion !== undefined ? { version: invocation.harnessVersion } : {}),
      nativeEvent: nativeName,
    },
    session: {
      ...(typeof payload.session_id === "string" ? { id: payload.session_id } : {}),
      cwd: payload.cwd,
    },
    correlation: {
      ...(typeof payload.prompt_id === "string" ? { turnId: payload.prompt_id } : {}),
      ...(typeof payload.tool_use_id === "string" ? { toolCallId: payload.tool_use_id } : {}),
      ...(typeof payload.agent_id === "string" ? { agentId: payload.agent_id } : {}),
    },
    raw: nativeEvent,
  };

  const tool = () => {
    if (typeof payload.tool_name !== "string") {
      throw new ClaudeDecodeError(`${nativeName} event has no tool_name`);
    }
    return classifyClaudeTool(payload.tool_name, payload.tool_input);
  };

  switch (nativeName) {
    case "SessionStart":
      return {
        ...base,
        event: "session.start",
        ...(typeof payload.source === "string" ? { how: payload.source } : {}),
      };
    case "SessionEnd":
      return {
        ...base,
        event: "session.end",
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
      };
    case "UserPromptSubmit":
      return { ...base, event: "prompt.before", prompt: payload.prompt ?? "" };
    case "PreToolUse":
      return { ...base, event: "tool.before", tool: tool() };
    case "PostToolUse":
      return { ...base, event: "tool.after", tool: tool(), output: payload.tool_response };
    case "PostToolUseFailure":
      return {
        ...base,
        event: "tool.error",
        tool: tool(),
        error: {
          ...(typeof payload.error === "string" ? { message: payload.error } : {}),
        },
      };
    case "PermissionRequest":
      return { ...base, event: "permission.request", tool: tool() };
    case "PreCompact":
      return {
        ...base,
        event: "context.compact.before",
        ...(typeof payload.trigger === "string" ? { trigger: payload.trigger } : {}),
      };
    case "PostCompact":
      return { ...base, event: "context.compact.after" };
    case "SubagentStart":
      return {
        ...base,
        event: "agent.start",
        agent: {
          ...(typeof payload.agent_id === "string" ? { id: payload.agent_id } : {}),
          ...(typeof payload.agent_type === "string" ? { type: payload.agent_type } : {}),
        },
      };
    case "SubagentStop":
      return {
        ...base,
        event: "agent.stop",
        agent: {
          ...(typeof payload.agent_id === "string" ? { id: payload.agent_id } : {}),
          ...(typeof payload.agent_type === "string" ? { type: payload.agent_type } : {}),
        },
        ...(typeof payload.last_assistant_message === "string" ? { lastMessage: payload.last_assistant_message } : {}),
      };
    case "Stop":
      return {
        ...base,
        event: "turn.stop",
        ...(typeof payload.last_assistant_message === "string" ? { lastMessage: payload.last_assistant_message } : {}),
      };
    default:
      // Vendor events outside the normalized vocabulary (Setup, Notification,
      // TaskCreated, …) are not decodable canonical events.
      throw new ClaudeDecodeError(`unmapped native event "${nativeName}"`);
  }
}
