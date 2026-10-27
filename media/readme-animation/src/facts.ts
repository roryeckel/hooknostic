// Typed view of src/facts.json, which scripts/extract-facts.mjs derives from
// the adapter registry and captured fixtures. Never edit the JSON by hand.
import facts from "./facts.json";

export type Level = "exact" | "emulated" | "approximate" | "unsupported";

export interface Harness {
  name: string;
  grades: Record<string, Level>;
  commandKey: string;
}

export const CAPABILITIES: readonly string[] = facts.capabilities;
export const HARNESSES = facts.harnesses as Harness[];

export const LEVELS: readonly Level[] = ["exact", "emulated", "approximate", "unsupported"];

// The compiler's default compatibility minimum (README, docs/concepts.md): a
// required capability graded below it fails `check` with HN201.
export const DEFAULT_MINIMUM: Level = "emulated";
export const meetsMinimum = (level: Level) => LEVELS.indexOf(level) <= LEVELS.indexOf(DEFAULT_MINIMUM);

// What the animated hook declares; the code card shows the same object.
export const HOOK_NEEDS: Record<string, "required" | "optional"> = {
  "tool.before.block": "required",
  "tool.before.input.replace": "optional",
};
