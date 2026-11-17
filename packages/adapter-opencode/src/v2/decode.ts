import type { InvocationContext } from "@hooknostic/core";
import type { HookEvent } from "@hooknostic/sdk";

import { dialectOfStatedShell } from "../shell-statement.js";
import { classifyOpenCodeV2Tool } from "./toolmap.js";

export interface OpenCodeV2NativeEvent {
  hook: string;
  directory: string;
  event: Record<string, unknown>;
}

/**
 * What the shim learned beside the callback, handed to the decoder separately
 * so `event.raw` stays the envelope the callback received (ADR-0027).
 */
export interface OpenCodeV2Enrichment {
  /**
   * What the shim saw of the execution a completion ends, gathered when a
   * turn.stop hook declares a turn field, or an agent.stop hook declares
   * lastMessage: the prompt hook's ids for the prompt that started it, and
   * the `session.text.ended` data of its last assistant message that produced
   * text. The completion event itself carries only the session id.
   */
  execution?: OpenCodeV2Execution;
  /**
   * The shell name the harness last stated for this session in its `shell`
   * tool description, heard on the `context` hook (ADR-0029). No tool hook
   * names the interpreter, so this is the only source of `tool.shell.dialect`.
   */
  shell?: unknown;
  /**
   * Set when the session was created as a child: its `session.created`
   * carried a `parentID`, and the `agent` it runs. That `session.created`
   * then decodes as `agent.start`, and a succeeded or failed completion as
   * `agent.stop`, both under the parent's session. The completion itself
   * names only the child.
   */
  child?: OpenCodeV2Child;
  /**
   * Set when the completing session is a known subagent child, for its own
   * `turn.stop`: the agent ids Copilot attaches to a subagent's stop. Known
   * from its `session.created`, or found by `session.get` when its prompt
   * reached this plugin instance.
   */
  subagent?: OpenCodeV2Child;
}

export interface OpenCodeV2Child {
  parentID: string;
  agent?: unknown;
}

export interface OpenCodeV2Execution {
  prompt?: { sessionID?: unknown; messageID?: unknown };
  text?: Record<string, unknown>[];
}
export class OpenCodeV2DecodeError extends Error {}
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The finished execution's turn fields. Text segments are joined in ordinal
 * order, and only the last assistant message's: OpenCode 2 starts a new
 * assistant message per model step (captured on 2.0.18), so the last one
 * holds what the model said last.
 */
function turnFields(execution: OpenCodeV2Execution | undefined): { lastMessage?: string; turnId?: string } {
  const messageID = record(execution?.prompt)["messageID"];
  const segments = (execution?.text ?? []).map(record);
  const last = segments.at(-1)?.["assistantMessageID"];
  const lastMessage = segments
    .filter((segment) => segment["assistantMessageID"] === last)
    .sort((a, b) => Number(a["ordinal"] ?? 0) - Number(b["ordinal"] ?? 0))
    .map((segment) => segment["text"])
    .filter((text): text is string => typeof text === "string" && text !== "")
    .join("\n");
  return {
    ...(lastMessage !== "" ? { lastMessage } : {}),
    ...(typeof messageID === "string" ? { turnId: messageID } : {}),
  };
}

export function decodeOpenCodeV2(
  raw: unknown,
  invocation: InvocationContext,
  enrichment: OpenCodeV2Enrichment = {},
): HookEvent {
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
    const shellDialect = dialectOfStatedShell(enrichment.shell);
    const tool = classifyOpenCodeV2Tool(
      event.tool,
      structuredClone(event.input),
      shellDialect !== undefined ? { shellDialect } : undefined,
    );
    if (native.hook === "execute.before") return { ...base, event: "tool.before", tool };
    if (event.status === "error") {
      const message = record(event.error).message;
      return { ...base, event: "tool.error", tool, error: typeof message === "string" ? { message } : {} };
    }
    if (event.status !== "completed") throw new OpenCodeV2DecodeError("unknown v2 tool status");
    return { ...base, event: "tool.after", tool, output: structuredClone(record(event.result).content) };
  }
  if (native.hook === "prompt")
    return {
      ...base,
      ...(typeof event.messageID === "string" ? { correlation: { ...base.correlation, turnId: event.messageID } } : {}),
      event: "prompt.before",
      prompt: String(record(event.prompt).text ?? ""),
    };
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
    if (event.type === "session.created") {
      // A child's creation is also its subagent's start, reported under the
      // parent as agent.stop is. Every field is read from this one event.
      if (typeof sessionID === "string" && enrichment.child !== undefined) {
        const { parentID, agent } = enrichment.child;
        return {
          ...base,
          session: { ...base.session, id: parentID },
          correlation: { agentId: sessionID, parentAgentId: parentID },
          event: "agent.start",
          agent: { id: sessionID, ...(typeof agent === "string" ? { type: agent } : {}) },
        };
      }
      return { ...base, event: "session.start" };
    }
    if (
      ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(
        String(event.type),
      )
    ) {
      const { lastMessage, turnId } = turnFields(enrichment.execution);
      // A child's own completion is also the subagent's stop, reported under
      // the parent as on Claude and Copilot. An interrupted child is left
      // unclaimed: interruption was not probed.
      if (
        enrichment.child !== undefined &&
        typeof sessionID === "string" &&
        event.type !== "session.execution.interrupted"
      ) {
        const { parentID, agent } = enrichment.child;
        return {
          ...base,
          session: { id: parentID, cwd: base.session.cwd },
          correlation: { agentId: sessionID, parentAgentId: parentID },
          event: "agent.stop",
          agent: { id: sessionID, ...(typeof agent === "string" ? { type: agent } : {}) },
          ...(lastMessage !== undefined ? { lastMessage } : {}),
        };
      }
      // A subagent child's own stop also says which agent it is, as on Copilot.
      const subagent =
        enrichment.subagent !== undefined && typeof sessionID === "string"
          ? { agentId: sessionID, parentAgentId: enrichment.subagent.parentID }
          : {};
      return {
        ...base,
        correlation: { ...base.correlation, ...(turnId !== undefined ? { turnId } : {}), ...subagent },
        event: "turn.stop",
        ...(lastMessage !== undefined ? { lastMessage } : {}),
      };
    }
    if (event.type === "session.compaction.ended") return { ...base, event: "context.compact.after" };
  }
  throw new OpenCodeV2DecodeError(`unmapped v2 callback ${native.hook}`);
}
