import type { Effect } from "@hooknostic/sdk";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Payload constraints that apply with or without a live Pi invocation. */
export function validatePiEffect(effect: Effect): string | undefined {
  if (effect.kind === "replaceInput" && !isPlainRecord(effect.input)) {
    return "pi cannot apply a replacement that is not a plain object";
  }
  return undefined;
}
