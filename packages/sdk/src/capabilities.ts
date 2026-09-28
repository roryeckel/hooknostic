import type { HookEventName } from "./events.js";

/**
 * The complete registry of event-scoped semantic capability identifiers.
 *
 * Capability IDs are stable strings and are event-scoped by construction to
 * prevent false equivalence (blocking a pending tool call is not the same
 * semantic as "blocking" after a tool already ran). Using an event implicitly
 * requires its `<event>.observe` capability; every other capability must be
 * declared by the hook that relies on it.
 */
export const ALL_CAPABILITY_IDS = [
  "session.start.observe",
  "session.start.context.add",

  "session.end.observe",

  "prompt.before.observe",
  "prompt.before.block",
  "prompt.before.context.add",

  "model.request.before.observe",
  "model.request.before.context.add",

  "tool.before.observe",
  "tool.before.block",
  "tool.before.requestApproval",
  "tool.before.input.replace",
  "tool.before.context.add",

  "tool.after.observe",
  "tool.after.output.replace",
  "tool.after.blockContinuation",
  "tool.after.context.add",

  "tool.error.observe",
  "tool.error.context.add",

  "permission.request.observe",
  "permission.request.block",
  "permission.request.context.add",

  "context.compact.before.observe",
  "context.compact.before.block",
  "context.compact.before.context.add",

  "context.compact.after.observe",

  "agent.start.observe",

  "agent.stop.observe",
  "agent.stop.prevent",
  "agent.stop.notify",

  "turn.stop.observe",
  "turn.stop.prevent",
  "turn.stop.notify",
] as const;

export type CapabilityId = (typeof ALL_CAPABILITY_IDS)[number];

/** All capability IDs scoped to a single normalized event. */
export type CapabilityIdForEvent<E extends HookEventName> = Extract<CapabilityId, `${E}.${string}`>;

/** The implicit observation capability of an event. */
export type ObserveCapability<E extends HookEventName> = `${E}.observe` & CapabilityId;

/**
 * Capabilities a hook may declare for an event — everything scoped to the
 * event except `observe`, which is implied by using the event at all.
 */
export type DeclarableCapability<E extends HookEventName> = Exclude<CapabilityIdForEvent<E>, `${E}.observe`>;

/** Distributes over `C`, so a union of ids strips to a union of suffixes. */
type StripEvent<C, E extends string> = C extends `${E}.${infer Suffix}` ? Suffix : never;

/**
 * A declarable capability spelled relative to its event: inside
 * `hook("tool.before", …)`, `"block"` means `"tool.before.block"`. The event
 * already scopes the hook, so restating it in every key is noise.
 */
export type CapabilitySuffix<E extends HookEventName> = StripEvent<DeclarableCapability<E>, E>;

/**
 * How a hook may name one of its event's capabilities: the full id or the
 * event-relative suffix. Authoring sugar only -- `hook()` canonicalizes to full
 * ids, which is all the compiler, the runtime, and every report ever see.
 */
export type CapabilityKey<E extends HookEventName> = DeclarableCapability<E> | CapabilitySuffix<E>;

/** The full capability id a key names at event `E`. */
export type CanonicalCapability<E extends HookEventName, K extends string> =
  K extends DeclarableCapability<E> ? K : Extract<DeclarableCapability<E>, `${E}.${K}`>;

/** Both spellings of every capability the keys `K` name at event `E`. */
export type CapabilitySpellings<E extends HookEventName, K extends string> =
  CanonicalCapability<E, K> | StripEvent<CanonicalCapability<E, K>, E>;

const CAPABILITY_SET: ReadonlySet<string> = new Set(ALL_CAPABILITY_IDS);

export function isCapabilityId(value: string): value is CapabilityId {
  return CAPABILITY_SET.has(value);
}

/**
 * Resolve an authored capability key to a full id at `event`.
 *
 * A registered id passes through untouched even when it belongs to another
 * event, so the compiler's scope check still reports it by its real name. No
 * event-relative suffix is itself a registered id, so the two spellings cannot
 * collide. An unknown key comes back as an unregistered `<event>.<key>` string,
 * which every consumer already rejects.
 */
export function canonicalCapability(event: HookEventName, key: string): string {
  return isCapabilityId(key) ? key : `${event}.${key}`;
}

/** The implicit `<event>.observe` capability for an event name. */
export function observeCapability(event: HookEventName): CapabilityId {
  const id = `${event}.observe`;
  if (!isCapabilityId(id)) {
    // Unreachable while every event in the registry has an observe entry;
    // guards against drift between the event taxonomy and the registry.
    throw new Error(`missing observe capability for event "${event}"`);
  }
  return id;
}

/** All registered capability IDs scoped to an event, observe included. */
export function capabilitiesForEvent(event: HookEventName): CapabilityId[] {
  const prefix = `${event}.`;
  return ALL_CAPABILITY_IDS.filter((id) => id.startsWith(prefix));
}
