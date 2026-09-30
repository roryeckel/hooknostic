import type { ToolInvocation } from "./tools.js";

/**
 * The normalized event vocabulary. Names describe lifecycle *meaning*, not
 * vendor nomenclature. Events are not added merely because one vendor exposes
 * them; vendor-specific surfaces stay adapter extension events.
 */
export const HOOK_EVENT_NAMES = [
  "session.start",
  "session.end",
  "prompt.before",
  "model.request.before",
  "tool.before",
  "tool.after",
  "tool.error",
  "permission.request",
  "context.compact.before",
  "context.compact.after",
  "agent.start",
  "agent.stop",
  "turn.stop",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export function isHookEventName(value: string): value is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * Canonical event envelope. Optional identifiers are intentional: adapters
 * must not invent IDs when the native harness does not provide them.
 */
export interface BaseHookEvent {
  schemaVersion: 1;
  event: HookEventName;

  harness: {
    /** Adapter/harness identifier, e.g. "claude", "codex", "opencode". */
    id: string;
    version?: string;
    /** The vendor's own event name (escape hatch). */
    nativeEvent: string;
  };

  session: {
    id?: string;
    cwd: string;
  };

  correlation: {
    turnId?: string;
    toolCallId?: string;
    agentId?: string;
    /**
     * The name of the agent the event ran in, exactly as the harness reports
     * it (ADR-0030): a subagent's name inside one -- plugin-qualified when a
     * package delivered it -- and the name of a defined agent a session runs
     * as, where the harness reports it; a harness that names every agent also
     * names its own primary agent. Absent when the harness does not say, which
     * on some harnesses means the main agent; never inferred.
     */
    agentType?: string;
    parentAgentId?: string;
  };

  /** The unmodified native payload (escape hatch). */
  raw: unknown;
}

export interface SessionStartEvent extends BaseHookEvent {
  event: "session.start";
  /** Vendor-reported start reason where available (e.g. "startup", "resume"). */
  how?: string;
}

export interface SessionEndEvent extends BaseHookEvent {
  event: "session.end";
  reason?: string;
}

export interface PromptBeforeEvent extends BaseHookEvent {
  event: "prompt.before";
  prompt: string;
}

/**
 * Before each request to the model, when the system prompt is being assembled.
 *
 * NOT once per session: a single user turn produces several of these (the
 * assistant step, plus title generation and summarization requests), so a
 * handler here runs on the latency path of every request. Use `session.start`
 * for once-per-session work.
 */
export interface ModelRequestBeforeEvent extends BaseHookEvent {
  event: "model.request.before";
}

export interface ToolBeforeEvent extends BaseHookEvent {
  event: "tool.before";
  tool: ToolInvocation;
}

export interface ToolAfterEvent extends BaseHookEvent {
  event: "tool.after";
  tool: ToolInvocation;
  /** Tool output/response as reported by the harness. */
  output: unknown;
}

export interface ToolErrorEvent extends BaseHookEvent {
  event: "tool.error";
  tool: ToolInvocation;
  error: {
    message?: string;
  };
}

export interface PermissionRequestEvent extends BaseHookEvent {
  event: "permission.request";
  tool: ToolInvocation;
}

export interface ContextCompactBeforeEvent extends BaseHookEvent {
  event: "context.compact.before";
  /** Vendor-reported trigger where available (e.g. "manual", "auto"). */
  trigger?: string;
}

export interface ContextCompactAfterEvent extends BaseHookEvent {
  event: "context.compact.after";
}

export interface AgentStartEvent extends BaseHookEvent {
  event: "agent.start";
  agent: {
    id?: string;
    type?: string;
  };
}

export interface AgentStopEvent extends BaseHookEvent {
  event: "agent.stop";
  agent: {
    id?: string;
    type?: string;
  };
  lastMessage?: string;
}

export interface TurnStopEvent extends BaseHookEvent {
  event: "turn.stop";
  lastMessage?: string;
}

export interface HookEventMap {
  "session.start": SessionStartEvent;
  "session.end": SessionEndEvent;
  "prompt.before": PromptBeforeEvent;
  "model.request.before": ModelRequestBeforeEvent;
  "tool.before": ToolBeforeEvent;
  "tool.after": ToolAfterEvent;
  "tool.error": ToolErrorEvent;
  "permission.request": PermissionRequestEvent;
  "context.compact.before": ContextCompactBeforeEvent;
  "context.compact.after": ContextCompactAfterEvent;
  "agent.start": AgentStartEvent;
  "agent.stop": AgentStopEvent;
  "turn.stop": TurnStopEvent;
}

export type HookEvent = HookEventMap[HookEventName];

/** Events whose payload carries a normalized ToolInvocation. */
export const TOOL_SCOPED_EVENTS = [
  "tool.before",
  "tool.after",
  "tool.error",
  "permission.request",
] as const satisfies readonly HookEventName[];

export type ToolScopedEventName = (typeof TOOL_SCOPED_EVENTS)[number];

export function isToolScopedEvent(event: HookEventName): event is ToolScopedEventName {
  return (TOOL_SCOPED_EVENTS as readonly HookEventName[]).includes(event);
}

/**
 * Events a hook may scope to the agents they run in (ADR-0030): the ones that
 * happen inside a subagent, and its own lifecycle. Each has an
 * `<event>.agent.identity` capability.
 */
export const AGENT_SCOPED_EVENTS = [
  ...TOOL_SCOPED_EVENTS,
  "agent.start",
  "agent.stop",
] as const satisfies readonly HookEventName[];

export type AgentScopedEventName = (typeof AGENT_SCOPED_EVENTS)[number];

export function isAgentScopedEvent(event: HookEventName): event is AgentScopedEventName {
  return (AGENT_SCOPED_EVENTS as readonly HookEventName[]).includes(event);
}
