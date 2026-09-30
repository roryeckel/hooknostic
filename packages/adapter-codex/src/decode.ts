import type { InvocationContext } from "@hooknostic/core";
import type { HookEvent } from "@hooknostic/sdk";

import { classifyCodexTool } from "./toolmap.js";

export class CodexDecodeError extends Error {}

interface CodexPayload {
  session_id?: string;
  cwd?: string;
  turn_id?: string;
  agent_id?: string;
  agent_type?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  prompt?: string;
  source?: string;
  reason?: string;
  trigger?: string;
  last_assistant_message?: string | null;
  [key: string]: unknown;
}

/**
 * Tolerant decoder for Codex command-hook stdin payloads. The 0.148.0 wire
 * schemas are strict on the vendor side; this decoder still only validates
 * what the canonical event needs, so additive future fields pass through to
 * `raw` untouched.
 */
export function decodeCodex(nativeEvent: unknown, invocation: InvocationContext): HookEvent {
  if (typeof nativeEvent !== "object" || nativeEvent === null) {
    throw new CodexDecodeError("native event is not an object");
  }
  const payload = nativeEvent as CodexPayload;
  const nativeName = payload.hook_event_name;
  if (typeof nativeName !== "string") {
    throw new CodexDecodeError("native event has no hook_event_name");
  }
  if (typeof payload.cwd !== "string") {
    throw new CodexDecodeError("native event has no cwd");
  }

  const base = {
    schemaVersion: 1 as const,
    harness: {
      id: "codex",
      ...(invocation.harnessVersion !== undefined ? { version: invocation.harnessVersion } : {}),
      nativeEvent: nativeName,
    },
    session: {
      ...(typeof payload.session_id === "string" ? { id: payload.session_id } : {}),
      cwd: payload.cwd,
    },
    correlation: {
      ...(typeof payload.turn_id === "string" ? { turnId: payload.turn_id } : {}),
      ...(typeof payload.tool_use_id === "string" ? { toolCallId: payload.tool_use_id } : {}),
      ...(typeof payload.agent_id === "string" ? { agentId: payload.agent_id } : {}),
      // Inside a subagent only; the main agent's events carry none (ADR-0030,
      // fixtures pre-tool-bash-subagent and subagent-start-live).
      ...(typeof payload.agent_type === "string" ? { agentType: payload.agent_type } : {}),
    },
    raw: nativeEvent,
  };

  const tool = () => {
    if (typeof payload.tool_name !== "string") {
      throw new CodexDecodeError(`${nativeName} event has no tool_name`);
    }
    return classifyCodexTool(payload.tool_name, payload.tool_input);
  };

  const agent = () => ({
    ...(typeof payload.agent_id === "string" ? { id: payload.agent_id } : {}),
    ...(typeof payload.agent_type === "string" ? { type: payload.agent_type } : {}),
  });

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
      return { ...base, event: "agent.start", agent: agent() };
    case "SubagentStop":
      return {
        ...base,
        event: "agent.stop",
        agent: agent(),
        ...(typeof payload.last_assistant_message === "string" ? { lastMessage: payload.last_assistant_message } : {}),
      };
    case "Stop":
      return {
        ...base,
        event: "turn.stop",
        ...(typeof payload.last_assistant_message === "string" ? { lastMessage: payload.last_assistant_message } : {}),
      };
    default:
      throw new CodexDecodeError(`unmapped native event "${nativeName}"`);
  }
}
