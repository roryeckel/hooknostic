import type { InvocationContext } from "@hooknostic/core";
import type { HookEvent } from "@hooknostic/sdk";

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

/**
 * What the shim learned from the host beside the callback, handed to the
 * decoder separately so `event.raw` stays the callback's own envelope
 * (ADR-0027).
 */
export interface OpenCodeEnrichment {
  /**
   * The session's messages, as `client.session.messages` returned them (its
   * `data`), read at a `session.idle` when a hook declares a turn field. The
   * bus event itself carries only the session id.
   */
  messages?: unknown;
}

interface ToolCallbackInput {
  tool?: string;
  sessionID?: string;
  callID?: string;
  args?: unknown;
  [key: string]: unknown;
}

/**
 * OpenCode consumes the live `output.args` object after this callback returns.
 * Handlers must receive an isolated snapshot so direct mutations cannot bypass
 * the dispatcher’s validated `replaceInput` effects.
 */
function snapshotOpenCodeArgs(args: unknown): unknown {
  try {
    return structuredClone(args);
  } catch {
    throw new OpenCodeDecodeError("tool.execute.before arguments cannot be cloned");
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The finished turn's fields from a session read at `session.idle`, newest
 * message first, stopping at the user message that started the turn so an
 * earlier turn's reply is never reported. OpenCode stores one assistant
 * message per model step, each naming the user message as its `parentID`
 * (captured on 1.18.32, .capture/opencode-turn-fields): the last message is
 * the turn's, and the latest one with text is what the model said last.
 */
function turnFields(messages: unknown): { lastMessage?: string; turnId?: string } {
  if (!Array.isArray(messages)) return {};
  let lastMessage: string | undefined;
  let turnId: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = record(messages[index]);
    const info = record(entry["info"]);
    if (info["role"] !== "assistant") break;
    if (turnId === undefined && typeof info["parentID"] === "string") turnId = info["parentID"];
    if (lastMessage === undefined) {
      const parts = Array.isArray(entry["parts"]) ? (entry["parts"] as unknown[]) : [];
      const text = parts
        .map(record)
        // Reasoning, tool, step and patch parts are not what the model said;
        // synthetic and ignored text parts are the harness's, not the model's.
        .filter((part) => part["type"] === "text" && part["synthetic"] !== true && part["ignored"] !== true)
        .map((part) => part["text"])
        .filter((value): value is string => typeof value === "string" && value !== "")
        .join("\n");
      if (text !== "") lastMessage = text;
    }
    if (turnId !== undefined && lastMessage !== undefined) break;
  }
  return {
    ...(lastMessage !== undefined ? { lastMessage } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

export function decodeOpenCode(
  nativeEvent: unknown,
  invocation: InvocationContext,
  enrichment: OpenCodeEnrichment = {},
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
      ...(invocation.harnessVersion !== undefined ? { version: invocation.harnessVersion } : {}),
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
        tool: classifyOpenCodeTool(input.tool, snapshotOpenCodeArgs(output["args"])),
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
          ...(typeof permission.callID === "string" ? { toolCallId: permission.callID } : {}),
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
      // The user message chat.message creates; its assistant replies name it as
      // parentID. input.messageID is only the caller's optional id, absent in
      // the 1.18.32 capture.
      const messageId = record(output["message"])["id"];
      return {
        ...base,
        ...(typeof messageId === "string" ? { correlation: { ...base.correlation, turnId: messageId } } : {}),
        event: "prompt.before",
        prompt,
      };
    }
    case "experimental.chat.system.transform":
      // input is { sessionID, model }; base already lifts sessionID.
      return { ...base, event: "model.request.before" };
    case "experimental.session.compacting":
      return { ...base, event: "context.compact.before" };
    case "event": {
      const busEvent = (
        input as {
          event?: {
            type?: string;
            properties?: { info?: { id?: string }; sessionID?: string };
          };
        }
      ).event;
      const infoSessionId = busEvent?.properties?.info?.id;
      const propertySessionId = busEvent?.properties?.sessionID;
      const withSession = (id: unknown) => ({
        ...base,
        session: {
          ...(typeof id === "string" ? { id } : {}),
          cwd: native.directory,
        },
      });
      switch (busEvent?.type) {
        case "session.created":
          return { ...withSession(infoSessionId), event: "session.start" };
        case "session.deleted":
          return { ...withSession(infoSessionId), event: "session.end" };
        case "session.idle": {
          const { lastMessage, turnId } = turnFields(enrichment.messages);
          const session = withSession(propertySessionId);
          return {
            ...session,
            ...(turnId !== undefined ? { correlation: { ...session.correlation, turnId } } : {}),
            event: "turn.stop",
            ...(lastMessage !== undefined ? { lastMessage } : {}),
          };
        }
        case "session.compacted":
          return { ...withSession(propertySessionId), event: "context.compact.after" };
        case "permission.asked": {
          // The active Permission module publishes this bus event instead of
          // triggering the documented `permission.ask` plugin hook (captured
          // live on 1.18.25: .capture/opencode-permission -- the callback
          // never fires, upstream defect anomalyco/opencode #9229). The
          // request's `permission` names the tool path; `metadata` carries the
          // tool's own input (e.g. {command}); `tool.callID` correlates.
          const properties = (busEvent.properties ?? {}) as {
            sessionID?: unknown;
            permission?: unknown;
            metadata?: unknown;
            tool?: { callID?: unknown };
          };
          return {
            ...withSession(properties.sessionID),
            correlation: {
              ...(typeof properties.tool?.callID === "string" ? { toolCallId: properties.tool.callID } : {}),
            },
            event: "permission.request",
            tool: classifyOpenCodeTool(
              typeof properties.permission === "string" ? properties.permission : "unknown",
              properties.metadata,
            ),
          };
        }
        default:
          throw new OpenCodeDecodeError(`unmapped bus event "${busEvent?.type}"`);
      }
    }
    default:
      throw new OpenCodeDecodeError(`unmapped native callback "${native.hook}"`);
  }
}
