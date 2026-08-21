import type { HookEvent } from "@hooknostic/sdk";
import type { InvocationContext } from "@hooknostic/core";
import { classifyOpenCodeTool } from "./toolmap.js";

export class OpenCodeDecodeError extends Error {}

/**
 * OpenCode plugins receive native *callback invocations*, not a JSON stdin
 * payload. The adapter normalizes each invocation into this envelope (which
 * is also the fixture format) before canonical decoding.
 */
export interface OpenCodeNativeEvent {
  /** Native callback name, e.g. "tool.execute.before", or "event" for the bus. */
  hook: string;
  /** Project directory from PluginInput. */
  directory: string;
  /** The callback's `input` argument (or `{event}` for the bus). */
  input: unknown;
  /** The callback's mutable `output` argument, when present. */
  output?: unknown;
}

interface ToolCallbackInput {
  tool?: string;
  sessionID?: string;
  callID?: string;
  args?: unknown;
  [key: string]: unknown;
}

export function decodeOpenCode(
  nativeEvent: unknown,
  invocation: InvocationContext,
): HookEvent {
  if (typeof nativeEvent !== "object" || nativeEvent === null) {
    throw new OpenCodeDecodeError("native event is not an object");
  }
  const native = nativeEvent as OpenCodeNativeEvent;
  if (typeof native.hook !== "string" || typeof native.directory !== "string") {
    throw new OpenCodeDecodeError("native event has no hook/directory");
  }

  const input = (native.input ?? {}) as ToolCallbackInput;
  const output = (native.output ?? {}) as Record<string, unknown>;

  const base = {
    schemaVersion: 1 as const,
    harness: {
      id: "opencode",
      ...(invocation.harnessVersion !== undefined
        ? { version: invocation.harnessVersion }
        : {}),
      nativeEvent: native.hook,
    },
    session: {
      ...(typeof input.sessionID === "string" ? { id: input.sessionID } : {}),
      cwd: native.directory,
    },
    correlation: {
      ...(typeof input.callID === "string" ? { toolCallId: input.callID } : {}),
    },
    raw: nativeEvent,
  };

  switch (native.hook) {
    case "tool.execute.before": {
      if (typeof input.tool !== "string") {
        throw new OpenCodeDecodeError("tool.execute.before has no tool name");
      }
      return {
        ...base,
        event: "tool.before",
        tool: classifyOpenCodeTool(input.tool, output["args"]),
      };
    }
    case "tool.execute.after": {
      if (typeof input.tool !== "string") {
        throw new OpenCodeDecodeError("tool.execute.after has no tool name");
      }
      return {
        ...base,
        event: "tool.after",
        tool: classifyOpenCodeTool(input.tool, input.args),
        output: output["output"],
      };
    }
    case "permission.ask": {
      // input is the SDK Permission object; its `type` names the tool path.
      const permission = input as { type?: string; sessionID?: string; callID?: string };
      return {
        ...base,
        session: {
          ...(typeof permission.sessionID === "string" ? { id: permission.sessionID } : {}),
          cwd: native.directory,
        },
        correlation: {
          ...(typeof permission.callID === "string"
            ? { toolCallId: permission.callID }
            : {}),
        },
        event: "permission.request",
        tool: classifyOpenCodeTool(permission.type ?? "unknown", native.input),
      };
    }
    case "chat.message": {
      const parts = Array.isArray(output["parts"]) ? (output["parts"] as unknown[]) : [];
      const prompt = parts
        .map((p) => (typeof (p as { text?: string }).text === "string" ? (p as { text: string }).text : ""))
        .filter(Boolean)
        .join("\n");
      return { ...base, event: "prompt.before", prompt };
    }
    case "experimental.session.compacting":
      return { ...base, event: "context.compact.before" };
    case "event": {
      const busEvent = (input as { event?: { type?: string } }).event;
      switch (busEvent?.type) {
        case "session.created":
          return { ...base, event: "session.start" };
        case "session.deleted":
          return { ...base, event: "session.end" };
        case "session.idle":
          return { ...base, event: "turn.stop" };
        case "session.compacted":
          return { ...base, event: "context.compact.after" };
        default:
          throw new OpenCodeDecodeError(`unmapped bus event "${busEvent?.type}"`);
      }
    }
    default:
      throw new OpenCodeDecodeError(`unmapped native callback "${native.hook}"`);
  }
}
