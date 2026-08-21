import type { CapabilityId } from "./capabilities.js";
import { isCapabilityId } from "./capabilities.js";
import type { HookEventName } from "./events.js";

/**
 * Effects are semantic actions a hook asks the harness to perform. Every
 * effect maps to an event-scoped capability; returning an effect whose
 * capability was not declared (or is unsupported on the executing target) is
 * a runtime contract violation (HN401).
 *
 * There is deliberately no `allow()` effect: returning no effect means
 * continue, which avoids vendor-specific nuances around permission bypass.
 */

export interface BlockEffect {
  readonly kind: "block";
  readonly reason: string;
}

export interface RequestApprovalEffect {
  readonly kind: "requestApproval";
  readonly reason?: string;
}

export interface ReplaceInputEffect {
  readonly kind: "replaceInput";
  readonly input: unknown;
}

export interface ReplaceOutputEffect {
  readonly kind: "replaceOutput";
  readonly output: unknown;
}

export interface AddContextEffect {
  readonly kind: "addContext";
  readonly context: string;
}

export interface PreventStopEffect {
  readonly kind: "preventStop";
  readonly reason?: string;
}

export interface BlockContinuationEffect {
  readonly kind: "blockContinuation";
  readonly reason: string;
}

export type Effect =
  | BlockEffect
  | RequestApprovalEffect
  | ReplaceInputEffect
  | ReplaceOutputEffect
  | AddContextEffect
  | PreventStopEffect
  | BlockContinuationEffect;

export type EffectKind = Effect["kind"];

/** Effect helpers. */

export function block(reason: string): BlockEffect {
  return { kind: "block", reason };
}

export function requestApproval(reason?: string): RequestApprovalEffect {
  return reason === undefined
    ? { kind: "requestApproval" }
    : { kind: "requestApproval", reason };
}

export function replaceInput(input: unknown): ReplaceInputEffect {
  return { kind: "replaceInput", input };
}

export function replaceOutput(output: unknown): ReplaceOutputEffect {
  return { kind: "replaceOutput", output };
}

export function addContext(context: string): AddContextEffect {
  return { kind: "addContext", context };
}

export function preventStop(reason?: string): PreventStopEffect {
  return reason === undefined ? { kind: "preventStop" } : { kind: "preventStop", reason };
}

export function blockContinuation(reason: string): BlockContinuationEffect {
  return { kind: "blockContinuation", reason };
}

/**
 * The capability suffix each effect kind maps to. Combined with the event an
 * effect is returned from, this yields the event-scoped capability the hook
 * must have declared.
 */
const EFFECT_CAPABILITY_SUFFIX: Record<EffectKind, string> = {
  block: "block",
  requestApproval: "requestApproval",
  replaceInput: "input.replace",
  replaceOutput: "output.replace",
  addContext: "context.add",
  preventStop: "prevent",
  blockContinuation: "blockContinuation",
};

/**
 * Resolve the capability an effect requires when returned from `event`.
 * Returns `undefined` when the effect has no registered capability at that
 * event (i.e. the effect is structurally impossible there).
 */
export function capabilityForEffect(
  event: HookEventName,
  kind: EffectKind,
): CapabilityId | undefined {
  const id = `${event}.${EFFECT_CAPABILITY_SUFFIX[kind]}`;
  return isCapabilityId(id) ? id : undefined;
}

/**
 * Type-level mapping from a capability ID to the effect it licenses. Suffix
 * checks are ordered so that longer suffixes are not shadowed by shorter ones.
 */
export type EffectForCapability<Id extends CapabilityId> = Id extends `${string}.input.replace`
  ? ReplaceInputEffect
  : Id extends `${string}.output.replace`
    ? ReplaceOutputEffect
    : Id extends `${string}.context.add`
      ? AddContextEffect
      : Id extends `${string}.requestApproval`
        ? RequestApprovalEffect
        : Id extends `${string}.blockContinuation`
          ? BlockContinuationEffect
          : Id extends `${string}.prevent`
            ? PreventStopEffect
            : Id extends `${string}.block`
              ? BlockEffect
              : never;

/** Terminal effects stop remaining handlers for a dispatch (ADR-0003). */
export function isTerminalEffect(effect: Effect): boolean {
  return (
    effect.kind === "block" ||
    effect.kind === "requestApproval" ||
    effect.kind === "preventStop" ||
    effect.kind === "blockContinuation"
  );
}
