/**
 * Support fidelity levels for a capability on a given target, ordered
 * `exact > emulated > approximate > unsupported`.
 */
export const SUPPORT_LEVELS = ["exact", "emulated", "approximate", "unsupported"] as const;

export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

/** How strongly a hook depends on a declared capability. */
export type RequirementLevel = "required" | "optional";

const RANK: Record<SupportLevel, number> = {
  exact: 3,
  emulated: 2,
  approximate: 1,
  unsupported: 0,
};

/** Numeric fidelity rank; higher is more faithful. */
export function supportRank(level: SupportLevel): number {
  return RANK[level];
}

/** True when `actual` meets or exceeds the `minimum` fidelity. */
export function meetsMinimum(actual: SupportLevel, minimum: SupportLevel): boolean {
  return RANK[actual] >= RANK[minimum];
}

/** The least-capable of two support levels (used for profile intersections). */
export function leastCapable(a: SupportLevel, b: SupportLevel): SupportLevel {
  return RANK[a] <= RANK[b] ? a : b;
}
