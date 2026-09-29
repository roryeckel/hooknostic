import type { InvocationContext } from "@hooknostic/core";
import type { HookEvent } from "@hooknostic/sdk";

import { classifyOpenCodeV2Tool } from "./toolmap.js";

export interface OpenCodeV2NativeEvent {
  hook: string;
  directory: string;
  event: Record<string, unknown>;
}
export class OpenCodeV2DecodeError extends Error {}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function decodeOpenCodeV2(raw: unknown, invocation: InvocationContext): HookEvent {
  const native = record(raw);
  if (typeof native.hook !== "string" || typeof native.directory !== "string" || !native.event)
    throw new OpenCodeV2DecodeError("v2 invocation requires hook, directory and event");
  const event = record(native.event);
  const data = native.hook === "event" ? record(event.data) : event;
  const sessionID = data.sessionID;
  const location = record(event.location);
  const base = {
    schemaVersion: 1 as const,
    harness: {
      id: "opencode",
      nativeEvent: native.hook,
      ...(invocation.harnessVersion ? { version: invocation.harnessVersion } : {}),
    },
    session: {
      ...(typeof sessionID === "string" ? { id: sessionID } : {}),
      cwd: typeof location.directory === "string" ? location.directory : native.directory,
    },
    correlation: { ...(typeof event.id === "string" && native.hook !== "event" ? { toolCallId: event.id } : {}) },
    raw,
  };
  if (native.hook === "execute.before" || native.hook === "execute.after") {
    if (typeof event.tool !== "string") throw new OpenCodeV2DecodeError("v2 tool event has no tool name");
    const tool = classifyOpenCodeV2Tool(event.tool, structuredClone(event.input));
    // v2 names the running agent on every tool event: the subagent inside one,
    // the primary agent otherwise (ADR-0028, fixtures tool-read-in-subagent-*).
    const scoped =
      typeof event.agent === "string"
        ? { ...base, correlation: { ...base.correlation, agentType: event.agent } }
        : base;
    if (native.hook === "execute.before") return { ...scoped, event: "tool.before", tool };
    if (event.status === "error") {
      const message = record(event.error).message;
      return { ...scoped, event: "tool.error", tool, error: typeof message === "string" ? { message } : {} };
    }
    if (event.status !== "completed") throw new OpenCodeV2DecodeError("unknown v2 tool status");
    return { ...scoped, event: "tool.after", tool, output: structuredClone(record(event.result).content) };
  }
  if (native.hook === "prompt")
    return { ...base, event: "prompt.before", prompt: String(record(event.prompt).text ?? "") };
  if (["context", "title", "generate"].includes(native.hook)) return { ...base, event: "model.request.before" };
  if (native.hook === "compaction") return { ...base, event: "context.compact.before" };
  if (native.hook === "evaluate" && event.effect === "ask")
    return {
      ...base,
      event: "permission.request",
      correlation: {
        ...(typeof record(event.source).id === "string" ? { toolCallId: record(event.source).id as string } : {}),
      },
      // A permission action/resource is not a tool name/input. Keep it in raw.
      tool: { kind: "other", nativeName: "unknown", input: undefined },
    };
  if (native.hook === "event") {
    if (event.type === "session.created") return { ...base, event: "session.start" };
    if (
      ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(
        String(event.type),
      )
    )
      return { ...base, event: "turn.stop" };
    if (event.type === "session.compaction.ended") return { ...base, event: "context.compact.after" };
  }
  throw new OpenCodeV2DecodeError(`unmapped v2 callback ${native.hook}`);
}
