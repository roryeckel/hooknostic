import type { InvocationContext } from "@hooknostic/core";
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

/**
 * pi executes the *live* `event.input` object after the handler returns (0.84.4
 * type docs: "Mutate it in place… No re-validation is performed"). Handlers
 * must receive an isolated snapshot so direct mutations cannot bypass the
 * dispatcher's validated `replaceInput` effects.
 */
function snapshotPiInput(input: unknown): unknown {
  try {
    return structuredClone(input);
  } catch {
    throw new PiDecodeError("tool_call input cannot be cloned");
  }
}

function snapshotPiRaw(native: PiNativeEvent): PiNativeEvent {
  try {
    return structuredClone(native);
  } catch {
    throw new PiDecodeError("tool_call event cannot be cloned");
  }
}

export function decodePi(nativeEvent: unknown, invocation: InvocationContext): HookEvent {
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
      const prompt = native.event["prompt"];
      if (typeof prompt !== "string") {
        throw new PiDecodeError("before_agent_start has no prompt");
      }
      return { ...base, event: "prompt.before", prompt };
    }
    case "context": {
      // Per-LLM-call boundary: the message array the call will use.
      return { ...base, event: "model.request.before" };
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
        tool: classifyPiTool(toolCall.toolName, snapshotPiInput(toolCall.input)),
      };
    }
    case "tool_result": {
      if (typeof toolCall.toolName !== "string") {
        throw new PiDecodeError("tool_result has no toolName");
      }
      const isError = native.event["isError"] === true;
      const output = native.event["content"];
      if (isError) {
        return {
          ...withToolCallId(base),
          event: "tool.error",
          tool: classifyPiTool(toolCall.toolName, toolCall.input),
          error: {},
        };
      }
      return {
        ...withToolCallId(base),
        event: "tool.after",
        tool: classifyPiTool(toolCall.toolName, toolCall.input),
        output,
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
      return { ...base, event: "turn.stop" };
    }
    default:
      throw new PiDecodeError(`unmapped pi event "${type}"`);
  }
}
