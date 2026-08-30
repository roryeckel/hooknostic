import { describe, expect, it } from "vitest";
import type { RuntimePolicy } from "@hooknostic/sdk";
import type { HookIR } from "./ir.js";
import { hooksByNativeEvent, nativeTimeoutSeconds } from "./native-timeout.js";

const RUNTIME: Required<RuntimePolicy> = {
  onHookError: "continue",
  timeoutMs: 5_000,
  contextCharLimit: 16_000,
  notifyCharLimit: 2_000,
};

function ir(partial: Partial<HookIR> & Pick<HookIR, "event" | "id">): HookIR {
  return { index: 0, capabilities: {}, ...partial };
}

const NATIVE: Record<string, string | undefined> = {
  "tool.before": "PreToolUse",
  "turn.stop": "Stop",
  "tool.error": undefined, // no native name on this target
};

describe("hooksByNativeEvent", () => {
  it("groups by native event and drops what the target cannot name", () => {
    const grouped = hooksByNativeEvent(
      [
        ir({ event: "tool.before", id: "a" }),
        ir({ event: "tool.before", id: "b" }),
        ir({ event: "turn.stop", id: "c" }),
        ir({ event: "tool.error", id: "unmapped" }),
      ],
      "any",
      (event) => NATIVE[event],
    );
    expect([...grouped.keys()]).toEqual(["PreToolUse", "Stop"]);
    expect(grouped.get("PreToolUse")?.map((h) => h.id)).toEqual(["a", "b"]);
    // Every returned group is non-empty, which is what lets nativeTimeoutSeconds
    // drop its zero-guard instead of clamping.
    for (const reaching of grouped.values()) expect(reaching.length).toBeGreaterThan(0);
  });

  it("honours target scoping", () => {
    const grouped = hooksByNativeEvent(
      [
        ir({ event: "tool.before", id: "everywhere" }),
        ir({ event: "tool.before", id: "elsewhere", targets: { include: ["other"] } }),
        ir({ event: "turn.stop", id: "not-here", targets: { exclude: ["mine"] } }),
      ],
      "mine",
      (event) => NATIVE[event],
    );
    expect([...grouped.keys()]).toEqual(["PreToolUse"]);
    expect(grouped.get("PreToolUse")?.map((h) => h.id)).toEqual(["everywhere"]);
  });
});

describe("nativeTimeoutSeconds", () => {
  it("covers every hook on the event, not just one", () => {
    // The defect this exists for: sized for one handler, the harness kills the
    // process while the dispatcher is legitimately inside handler two, and the
    // response is absent rather than partial.
    expect(nativeTimeoutSeconds([ir({ event: "tool.before", id: "a" })], RUNTIME)).toBe(6);
    expect(
      nativeTimeoutSeconds(
        [ir({ event: "tool.before", id: "a" }), ir({ event: "tool.before", id: "b" })],
        RUNTIME,
      ),
    ).toBe(11);
  });

  it("lets a hook lower its own budget below the global default", () => {
    // The direction the first version got wrong. A `Math.max(total, global)`
    // clamp reads like a zero-guard and is really a floor: under a 900s global
    // these two 50ms guards would have emitted 901s, making per-hook budgets
    // inert in exactly the direction they exist for.
    const generous: Required<RuntimePolicy> = { ...RUNTIME, timeoutMs: 900_000 };
    const guards = [
      ir({ event: "tool.before", id: "grep", timeoutMs: 50 }),
      ir({ event: "tool.before", id: "pyright", timeoutMs: 50 }),
    ];
    expect(nativeTimeoutSeconds(guards, generous)).toBe(2);
  });

  it("raises one hook without inflating its neighbour", () => {
    const mixed = [
      ir({ event: "turn.stop", id: "lint", timeoutMs: 330_000 }),
      ir({ event: "turn.stop", id: "quick" }),
    ];
    expect(nativeTimeoutSeconds(mixed, RUNTIME)).toBe(336);
  });

  it("falls back to the policy budget for hooks that declare none", () => {
    expect(
      nativeTimeoutSeconds(
        [ir({ event: "turn.stop", id: "declared", timeoutMs: 1_000 }), ir({ event: "turn.stop", id: "inherits" })],
        RUNTIME,
      ),
    ).toBe(7);
  });
});
