import type { InvocationContext, ReportedToolFacts } from "@hooknostic/core";
import type { HookEvent } from "@hooknostic/sdk";

import { classifyPiTool } from "./toolmap.js";

export class PiDecodeError extends Error {}

/**
 * pi extensions receive live in-process event objects, not a JSON stdin
 * payload. The shim normalizes each handler invocation into this envelope
 * (which is also the fixture format) before canonical decoding:
 *
 *   { event: <pi event object>, ctx: { cwd, mode } }
 *
 * `event` is the live object; handlers may mutate parts of it (tool_call's
 * `input`, per the 0.84.4 type docs) and the shim applies effects through
 * those live references after dispatch.
 */
export interface PiNativeEvent {
  /** pi event name, e.g. "tool_call", "session_start". */
  event: Record<string, unknown> & { type?: unknown };
  /** Extension context fields the shim received. */
  ctx: {
    cwd: string;
    mode?: string;
  };
}

interface ToolCallShape {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
}

/** Context read beside a callback, never inserted into event.raw (ADR-0027). */
export interface PiEnrichment {
  branch?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function finalAssistant(branch: unknown): { lastMessage?: string; turnId?: string } {
  if (!Array.isArray(branch)) return {};
  const entry = record(branch.filter((value) => record(value)["type"] === "message").at(-1));
  const message = record(entry["message"]);
  // A user, tool result, failure or interruption at the leaf must not expose
  // the preceding assistant's response as the just-completed turn.
  if (message["role"] !== "assistant" || message["stopReason"] !== "stop") return {};
  const content = message["content"];
  const text = Array.isArray(content)
    ? content
        .filter((part) => record(part)["type"] === "text")
        .map((part) => record(part)["text"])
        .filter((part): part is string => typeof part === "string")
        .join("\n")
    : "";
  return {
    ...(text ? { lastMessage: text } : {}),
    ...(typeof entry["id"] === "string" ? { turnId: entry["id"] } : {}),
  };
}

/**
 * pi executes the *live* `event.input` object after the handler returns (0.84.4
 * type docs: "Mutate it in place… No re-validation is performed"). Handlers
 * must receive an isolated snapshot so direct mutations cannot bypass the
 * dispatcher's validated `replaceInput` effects.
 */
function snapshotPiValue(input: unknown, label: string): unknown {
  try {
    return structuredClone(input);
  } catch {
    throw new PiDecodeError(`${label} cannot be cloned`);
  }
}

function snapshotPiRaw(native: PiNativeEvent): PiNativeEvent {
  try {
    return structuredClone(native);
  } catch {
    throw new PiDecodeError("pi event cannot be cloned");
  }
}

/** The MCP identity a tool_result's `details` states, when it names both parts as strings. */
export function piReportedMcp(details: unknown): ReportedToolFacts | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const { server, tool } = details as Record<string, unknown>;
  return typeof server === "string" && typeof tool === "string" ? { mcp: { server, tool } } : undefined;
}

export function decodePi(
  nativeEvent: unknown,
  invocation: InvocationContext,
  enrichment: PiEnrichment = {},
): HookEvent {
  if (typeof nativeEvent !== "object" || nativeEvent === null) {
    throw new PiDecodeError("native event is not an object");
  }
  const native = nativeEvent as PiNativeEvent;
  if (typeof native.event !== "object" || native.event === null) {
    throw new PiDecodeError("native event has no event object");
  }
  if (typeof native.ctx?.cwd !== "string") {
    throw new PiDecodeError("native event has no ctx.cwd");
  }
  const type = native.event.type;
  if (typeof type !== "string") {
    throw new PiDecodeError("native event has no type");
  }

  const base = {
    schemaVersion: 1 as const,
    harness: {
      id: "pi",
      ...(invocation.harnessVersion !== undefined ? { version: invocation.harnessVersion } : {}),
      nativeEvent: type,
    },
    session: {
      cwd: native.ctx.cwd,
    },
    correlation: {} as Record<string, string>,
    raw: nativeEvent,
  };

  const toolCall = native.event as ToolCallShape;
  const withToolCallId = (obj: typeof base) => ({
    ...obj,
    correlation: {
      ...(typeof toolCall.toolCallId === "string" ? { toolCallId: toolCall.toolCallId } : {}),
    },
  });

  switch (type) {
    case "session_start": {
      const reason = native.event["reason"];
      return {
        ...base,
        event: "session.start",
        ...(typeof reason === "string" ? { how: reason } : {}),
      };
    }
    case "session_shutdown": {
      const reason = native.event["reason"];
      return {
        ...base,
        event: "session.end",
        ...(typeof reason === "string" ? { reason } : {}),
      };
    }
    case "before_agent_start": {
      // From pi 1.2 a run started by a custom message -- including the
      // sendMessage({triggerTurn: true}) continuation turn.stop prevent posts --
      // also fires before_agent_start, with messageType "custom", the message,
      // and no prompt (fixtures/pi/1.3/before-agent-start-custom). No user
      // prompt was submitted, so it is declined rather than mapped to
      // prompt.before; 0.84 never fired the event for such a run.
      if (native.event["messageType"] === "custom") {
        throw new PiDecodeError("before_agent_start for a custom-message run carries no user prompt");
      }
      const prompt = native.event["prompt"];
      if (typeof prompt !== "string") {
        throw new PiDecodeError("before_agent_start has no prompt");
      }
      return { ...base, event: "prompt.before", prompt };
    }
    case "context": {
      // Per-LLM-call boundary: the message array the call will use.
      return { ...base, raw: snapshotPiRaw(native), event: "model.request.before" };
    }
    case "tool_call": {
      if (typeof toolCall.toolName !== "string") {
        throw new PiDecodeError("tool_call has no toolName");
      }
      // Keep the native payload and unknown fields in raw, but not their live
      // references. The independent tool.input snapshot cannot be changed
      // through raw, and neither view can mutate the object pi will execute.
      return {
        ...withToolCallId(base),
        raw: snapshotPiRaw(native),
        event: "tool.before",
        tool: classifyPiTool(toolCall.toolName, snapshotPiValue(toolCall.input, "tool_call input")),
      };
    }
    case "tool_result": {
      if (typeof toolCall.toolName !== "string") {
        throw new PiDecodeError("tool_result has no toolName");
      }
      // pi's result content and input can still share references with the
      // agent. Raw and normalized views must not let a no-effect hook mutate
      // either those live values or each other.
      const raw = snapshotPiRaw(native);
      const input = snapshotPiValue(toolCall.input, "tool_result input");
      const isError = native.event["isError"] === true;
      const output = native.event["content"];
      // An MCP result's `details` names its server and tool as pi registered
      // them (fixtures/pi/1.3/tool-result-mcp); the lossy name cannot
      // (toolmap.ts). It reaches the view as a reported fact, which is how
      // classifyTool rebuilds the same view (ADR-0023, ADR-0032).
      const tool = classifyPiTool(toolCall.toolName, input, piReportedMcp(native.event["details"]));
      if (isError) {
        return { ...withToolCallId(base), raw, event: "tool.error", tool, error: {} };
      }
      return {
        ...withToolCallId(base),
        raw,
        event: "tool.after",
        tool,
        output: snapshotPiValue(output, "tool_result content"),
      };
    }
    case "session_before_compact": {
      const reason = native.event["reason"];
      return {
        ...base,
        event: "context.compact.before",
        ...(typeof reason === "string" ? { trigger: reason } : {}),
      };
    }
    case "session_compact": {
      return { ...base, event: "context.compact.after" };
    }
    case "session_compact_failed": {
      // A cancelled or failed compaction is still the end of the compaction
      // attempt; the portable event is the same observation.
      return { ...base, event: "context.compact.after" };
    }
    case "agent_settled": {
      const { lastMessage, turnId } = finalAssistant(enrichment.branch);
      return {
        ...base,
        event: "turn.stop",
        ...(lastMessage !== undefined ? { lastMessage } : {}),
        ...(turnId !== undefined ? { correlation: { turnId } } : {}),
      };
    }
    default:
      throw new PiDecodeError(`unmapped pi event "${type}"`);
  }
}
