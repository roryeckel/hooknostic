import type { HookEventName, ToolScopedEventName } from "./events.js";
import { HOOK_EVENT_NAMES, isToolScopedEvent } from "./events.js";

/**
 * Each event's own optional fields, as paths into the event (ADR-0027). The
 * correlation ids are added per event below. Required fields are not listed:
 * every decoder must supply them, so there is nothing to rate.
 */
export const OPTIONAL_EVENT_FIELDS = {
  "session.start": ["how"],
  "session.end": ["reason"],
  "prompt.before": [],
  "model.request.before": [],
  "tool.before": [],
  "tool.after": [],
  "tool.error": ["error.message"],
  "permission.request": [],
  "context.compact.before": ["trigger"],
  "context.compact.after": [],
  "agent.start": ["agent.id", "agent.type"],
  "agent.stop": ["agent.id", "agent.type", "lastMessage"],
  "turn.stop": ["lastMessage"],
} as const satisfies Record<HookEventName, readonly string[]>;

/** Correlation ids every event may carry; `toolCallId` only where there is a tool. */
const CORRELATION_FIELDS = ["correlation.turnId", "correlation.agentId", "correlation.parentAgentId"] as const;
const TOOL_CORRELATION_FIELD = "correlation.toolCallId";

/** An optional field of event `E`, spelled as a path relative to the event. */
export type EventField<E extends HookEventName> =
  | (typeof OPTIONAL_EVENT_FIELDS)[E][number]
  | (typeof CORRELATION_FIELDS)[number]
  | (E extends ToolScopedEventName ? typeof TOOL_CORRELATION_FIELD : never);

/** The full, event-scoped id of an optional field, e.g. `"turn.stop.lastMessage"`. */
export type EventFieldId = { [E in HookEventName]: `${E}.${EventField<E>}` }[HookEventName];

/** The fields of event `E`, as full ids. */
export type EventFieldIdForEvent<E extends HookEventName> = `${E}.${EventField<E>}` & EventFieldId;

/**
 * How a hook may name one of its event's fields: event-relative
 * (`"lastMessage"`) or in full (`"turn.stop.lastMessage"`). `hook()` stores
 * the full id either way.
 */
export type FieldKey<E extends HookEventName> = EventField<E> | EventFieldIdForEvent<E>;

/** The event-relative paths of an event's optional fields. */
export function fieldsForEvent(event: HookEventName): string[] {
  return [
    ...OPTIONAL_EVENT_FIELDS[event],
    ...CORRELATION_FIELDS,
    ...(isToolScopedEvent(event) ? [TOOL_CORRELATION_FIELD] : []),
  ];
}

/** Every registered field id, grouped by event in vocabulary order. */
export const ALL_EVENT_FIELD_IDS: readonly EventFieldId[] = HOOK_EVENT_NAMES.flatMap((event) =>
  fieldsForEvent(event).map((path) => `${event}.${path}` as EventFieldId),
);

const FIELD_SET: ReadonlySet<string> = new Set(ALL_EVENT_FIELD_IDS);

export function isEventFieldId(value: string): value is EventFieldId {
  return FIELD_SET.has(value);
}

/**
 * Resolve an authored field key to a full id at `event`. A registered id passes
 * through, even one of another event, so the compiler's scope check still
 * reports it by its real name. No event-relative path starts with an event
 * name, so the two spellings cannot collide.
 */
export function canonicalField(event: HookEventName, key: string): string {
  return isEventFieldId(key) ? key : `${event}.${key}`;
}

/** The event-relative path of a field id, e.g. `"correlation.turnId"`. */
export function fieldPath(id: EventFieldId): string {
  const event = HOOK_EVENT_NAMES.find(
    (name) => id.startsWith(`${name}.`) && fieldsForEvent(name).includes(id.slice(name.length + 1)),
  );
  if (event === undefined) throw new Error(`unregistered field id "${id}"`);
  return id.slice(event.length + 1);
}

/** The event a field id is scoped to. */
export function fieldEvent(id: EventFieldId): HookEventName {
  const path = fieldPath(id);
  return id.slice(0, id.length - path.length - 1) as HookEventName;
}

/** The value at a field's path in an event, or `undefined` when absent. */
export function readEventField(event: object, path: string): unknown {
  let value: unknown = event;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
