import { describe, expect, it } from "vitest";

import type { RuntimePolicy } from "@hooknostic/sdk";

import type { HookIR } from "./ir.js";
import { assertNativeTimeoutFits, hooksByNativeEvent, nativeTimeoutSeconds } from "./native-timeout.js";

const RUNTIME: Required<RuntimePolicy> = {
  onHookError: "continue",
  timeoutMs: 5_000,
  processAllowanceMs: 5_000,
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
    expect(nativeTimeoutSeconds([ir({ event: "tool.before", id: "a" })], RUNTIME)).toBe(10);
    expect(
      nativeTimeoutSeconds([ir({ event: "tool.before", id: "a" }), ir({ event: "tool.before", id: "b" })], RUNTIME),
    ).toBe(15);
  });

  it("adds the process allowance once per event, not once per hook", () => {
    // One dispatcher process serves every hook on the event, so its start is
    // paid once. Adding it per hook would multiply the deadline by the number
    // of guards (17s here, not 7s).
    const two = [
      ir({ event: "tool.before", id: "a", timeoutMs: 1_000 }),
      ir({ event: "tool.before", id: "b", timeoutMs: 1_000 }),
    ];
    expect(nativeTimeoutSeconds(two, RUNTIME)).toBe(7);
  });

  it("takes only the process allowance a harness cap leaves", () => {
    // Codex clamps SessionEnd to 3s. A 2s budget still gets its 1s of start;
    // the handler budgets are not reduced to make room. 3s is the ceiling, and
    // a 5s budget leaves nothing to take -- assertNativeTimeoutFits refuses it.
    expect(
      nativeTimeoutSeconds([ir({ event: "session.end", id: "quick", timeoutMs: 2_000 })], RUNTIME, {
        ceilingSeconds: 3,
      }),
    ).toBe(3);
    expect(
      nativeTimeoutSeconds([ir({ event: "session.end", id: "tight", timeoutMs: 2_900 })], RUNTIME, {
        ceilingSeconds: 3,
      }),
    ).toBe(3);
    expect(
      nativeTimeoutSeconds([ir({ event: "session.end", id: "over", timeoutMs: 5_000 })], RUNTIME, {
        ceilingSeconds: 3,
      }),
    ).toBe(5);
  });

  it("does not spend a loose harness cap as extra allowance", () => {
    // Claude clamps SessionEnd at 60s. Taking the whole headroom under the cap
    // would emit 60s for a 5s hook and hold a wedged teardown for a minute. The
    // allowance is the policy's, or less when the cap leaves less room -- never
    // the cap itself.
    expect(
      nativeTimeoutSeconds([ir({ event: "session.end", id: "claude", timeoutMs: 5_000 })], RUNTIME, {
        ceilingSeconds: 60,
      }),
    ).toBe(10);
    const small: Required<RuntimePolicy> = { ...RUNTIME, processAllowanceMs: 500 };
    expect(
      nativeTimeoutSeconds([ir({ event: "session.end", id: "small", timeoutMs: 1_000 })], small, {
        ceilingSeconds: 60,
      }),
    ).toBe(2);
  });

  it("lets a hook lower its own budget below the global default", () => {
    // The direction the first version got wrong. A `Math.max(total, global)`
    // clamp reads like a zero-guard and is really a floor: under a 900s global
    // these two 50ms guards would have emitted 901s, making per-hook budgets
    // inert in exactly the direction they exist for. The start-up allowance is
    // not a floor on the handler budgets -- 100ms of handler stays 100ms.
    const generous: Required<RuntimePolicy> = { ...RUNTIME, timeoutMs: 900_000 };
    const guards = [
      ir({ event: "tool.before", id: "grep", timeoutMs: 50 }),
      ir({ event: "tool.before", id: "pyright", timeoutMs: 50 }),
    ];
    expect(nativeTimeoutSeconds(guards, generous)).toBe(6);
  });

  it("raises one hook without inflating its neighbour", () => {
    const mixed = [ir({ event: "turn.stop", id: "lint", timeoutMs: 330_000 }), ir({ event: "turn.stop", id: "quick" })];
    expect(nativeTimeoutSeconds(mixed, RUNTIME)).toBe(340);
  });

  it("falls back to the policy budget for hooks that declare none", () => {
    expect(
      nativeTimeoutSeconds(
        [ir({ event: "turn.stop", id: "declared", timeoutMs: 1_000 }), ir({ event: "turn.stop", id: "inherits" })],
        RUNTIME,
      ),
    ).toBe(11);
  });
});

describe("assertNativeTimeoutFits", () => {
  const CEILINGS = { SessionEnd: 3 };

  it("refuses a budget the harness will not grant", () => {
    // codex-cli clamps SessionEnd to 3s (SESSION_END_MAX_TIMEOUT_SEC). Asking
    // for 6 and being given 3 kills the dispatch before it answers -- the same
    // failure nativeTimeoutSeconds prevents, arriving from the other side.
    expect(() => assertNativeTimeoutFits("SessionEnd", 6, CEILINGS, "codex-cli")).toThrow(/grants at most 3s/);
  });

  it("names the fix, not just the problem", () => {
    expect(() => assertNativeTimeoutFits("SessionEnd", 6, CEILINGS, "codex-cli")).toThrow(/Lower the hooks' timeoutMs/);
  });

  it("allows a budget at the ceiling, and any event without one", () => {
    expect(() => assertNativeTimeoutFits("SessionEnd", 3, CEILINGS, "codex-cli")).not.toThrow();
    expect(() => assertNativeTimeoutFits("PreToolUse", 901, CEILINGS, "codex-cli")).not.toThrow();
  });
});
