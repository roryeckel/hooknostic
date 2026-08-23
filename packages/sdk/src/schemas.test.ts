import { describe, expect, it } from "vitest";
import {
  baseHookEventSchema,
  block,
  capabilityForEffect,
  capabilitiesForEvent,
  effectSchema,
  hooknosticConfigSchema,
  isTerminalEffect,
  leastCapable,
  meetsMinimum,
  observeCapability,
  pluginSpecSchema,
  replaceInput,
  addContext,
  requestApproval,
  preventStop,
  blockContinuation,
  replaceOutput,
  HOOK_EVENT_NAMES,
  ALL_CAPABILITY_IDS,
  hook,
  isJsonValue,
  findNonJsonPath,
} from "./index.js";

describe("support levels", () => {
  it("orders exact > emulated > approximate > unsupported", () => {
    expect(meetsMinimum("exact", "emulated")).toBe(true);
    expect(meetsMinimum("emulated", "emulated")).toBe(true);
    expect(meetsMinimum("approximate", "emulated")).toBe(false);
    expect(meetsMinimum("unsupported", "approximate")).toBe(false);
    expect(leastCapable("exact", "approximate")).toBe("approximate");
    expect(leastCapable("unsupported", "emulated")).toBe("unsupported");
  });
});

describe("capability registry", () => {
  it("has an observe capability for every normalized event", () => {
    for (const event of HOOK_EVENT_NAMES) {
      expect(observeCapability(event)).toBe(`${event}.observe`);
    }
  });

  it("scopes every registered capability to a normalized event", () => {
    for (const id of ALL_CAPABILITY_IDS) {
      const owner = HOOK_EVENT_NAMES.find((e) => id.startsWith(`${e}.`));
      expect(owner, `capability ${id} has no owning event`).toBeDefined();
    }
  });

  it("lists capabilities per event", () => {
    expect(capabilitiesForEvent("tool.before")).toEqual([
      "tool.before.observe",
      "tool.before.block",
      "tool.before.requestApproval",
      "tool.before.input.replace",
      "tool.before.context.add",
    ]);
  });
});

describe("effect → capability mapping", () => {
  it("maps every helper to its event-scoped capability", () => {
    expect(capabilityForEffect("tool.before", "block")).toBe("tool.before.block");
    expect(capabilityForEffect("tool.before", "replaceInput")).toBe(
      "tool.before.input.replace",
    );
    expect(capabilityForEffect("tool.before", "requestApproval")).toBe(
      "tool.before.requestApproval",
    );
    expect(capabilityForEffect("tool.after", "replaceOutput")).toBe(
      "tool.after.output.replace",
    );
    expect(capabilityForEffect("tool.after", "blockContinuation")).toBe(
      "tool.after.blockContinuation",
    );
    expect(capabilityForEffect("session.start", "addContext")).toBe(
      "session.start.context.add",
    );
    expect(capabilityForEffect("turn.stop", "preventStop")).toBe("turn.stop.prevent");
    expect(capabilityForEffect("agent.stop", "preventStop")).toBe("agent.stop.prevent");
  });

  it("returns undefined for structurally impossible effects", () => {
    expect(capabilityForEffect("session.end", "block")).toBeUndefined();
    expect(capabilityForEffect("tool.before", "replaceOutput")).toBeUndefined();
    expect(capabilityForEffect("tool.after", "replaceInput")).toBeUndefined();
    expect(capabilityForEffect("session.start", "preventStop")).toBeUndefined();
  });

  it("classifies terminal effects per ADR-0003", () => {
    expect(isTerminalEffect(block("x"))).toBe(true);
    expect(isTerminalEffect(requestApproval())).toBe(true);
    expect(isTerminalEffect(preventStop())).toBe(true);
    expect(isTerminalEffect(blockContinuation("x"))).toBe(true);
    expect(isTerminalEffect(replaceInput({}))).toBe(false);
    expect(isTerminalEffect(replaceOutput({}))).toBe(false);
    expect(isTerminalEffect(addContext("x"))).toBe(false);
  });
});

describe("canonical schemas", () => {
  const envelope = {
    schemaVersion: 1,
    event: "tool.before",
    harness: { id: "claude", version: "2.1.238", nativeEvent: "PreToolUse" },
    session: { id: "s-1", cwd: "C:/repo" },
    correlation: { toolCallId: "toolu_1" },
    raw: { anything: true, extra_vendor_field: [1, 2, 3] },
  };

  it("validates a canonical event envelope and passes through event payload fields", () => {
    const parsed = baseHookEventSchema.parse({
      ...envelope,
      tool: { kind: "shell", nativeName: "Bash", input: { command: "ls" } },
    });
    expect((parsed as Record<string, unknown>).tool).toBeDefined();
  });

  it("rejects a wrong schema version and unknown envelope sub-fields", () => {
    expect(() => baseHookEventSchema.parse({ ...envelope, schemaVersion: 2 })).toThrow();
    expect(() =>
      baseHookEventSchema.parse({
        ...envelope,
        harness: { ...envelope.harness, invented: true },
      }),
    ).toThrow();
  });

  it("validates effects strictly", () => {
    expect(effectSchema.parse(block("no"))).toEqual({ kind: "block", reason: "no" });
    expect(() => effectSchema.parse({ kind: "block" })).toThrow();
    expect(() => effectSchema.parse({ kind: "allow" })).toThrow();
    expect(() => effectSchema.parse({ kind: "block", reason: "x", extra: 1 })).toThrow();
  });

  it("validates config and rejects unknown keys", () => {
    const config = {
      entry: "./src/hooks.ts",
      compatibility: { minimum: "emulated", onBelowMinimum: "error" },
      targets: {
        claude: { version: ">=2.1 <3", mode: "plugin", output: "./dist/claude" },
      },
    };
    expect(hooknosticConfigSchema.parse(config).entry).toBe("./src/hooks.ts");
    expect(() =>
      hooknosticConfigSchema.parse({ ...config, daemon: true }),
    ).toThrow();
    expect(() =>
      hooknosticConfigSchema.parse({
        ...config,
        targets: { claude: { version: ">=2.1 <3", mode: "service", output: "./x" } },
      }),
    ).toThrow();
  });

  it("validates authored plugin structure", () => {
    const plugin = {
      name: "p",
      hooks: [
        hook("tool.before", {
          id: "h",
          capabilities: { "tool.before.block": "required" },
          async run() {},
        }),
      ],
    };
    expect(pluginSpecSchema.parse(plugin).hooks).toHaveLength(1);
    expect(() =>
      pluginSpecSchema.parse({
        name: "p",
        hooks: [{ event: "tool.before", id: "h", capabilities: {}, run: "not-a-fn" }],
      }),
    ).toThrow();
    expect(() =>
      pluginSpecSchema.parse({
        name: "p",
        hooks: [
          {
            event: "tool.before",
            id: "h",
            capabilities: { "made.up.capability": "required" },
            run: () => undefined,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("effect payload JSON rule", () => {
  const cyclic: Record<string, unknown> = { command: "ls" };
  cyclic["self"] = cyclic;

  it("accepts canonical JSON payloads", () => {
    const input = { command: "ls", args: [1, "a", null, true, { nested: [] }] };
    expect(effectSchema.parse(replaceInput(input))).toEqual({ kind: "replaceInput", input });
    expect(effectSchema.safeParse(replaceOutput("plain text")).success).toBe(true);
    expect(effectSchema.safeParse(replaceOutput(null)).success).toBe(true);
    expect(effectSchema.safeParse(replaceOutput([])).success).toBe(true);
  });

  it("rejects payloads that JSON serialization would drop, throw on, or transform", () => {
    const symbolKey = Symbol("hidden");
    const symbolProperty = { command: "ls", [symbolKey]: "dropped" };
    const nonEnumerableProperty = Object.defineProperty(
      { command: "ls" },
      "hidden",
      { value: "dropped" },
    );
    const arrayProperty = Object.assign(["ls"], { hidden: "dropped" });
    const cases: [string, unknown][] = [
      ["undefined", undefined],
      ["function", () => 1],
      ["symbol", Symbol("s")],
      ["bigint", 10n],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["Date", new Date(0)],
      ["Map", new Map()],
      ["cycle", cyclic],
      ["nested undefined", { nested: { deep: [undefined] } }],
      ["class instance", new (class Thing {})()],
      ["accessor", { get changesAfterValidation() { return 1; } }],
      ["toJSON", Object.defineProperty({}, "toJSON", { value: () => ({ ok: true }) })],
      ["symbol-keyed property", symbolProperty],
      ["non-enumerable property", nonEnumerableProperty],
      ["non-index array property", arrayProperty],
    ];
    for (const [label, payload] of cases) {
      expect(effectSchema.safeParse(replaceInput(payload)).success, label).toBe(false);
      expect(effectSchema.safeParse(replaceOutput(payload)).success, label).toBe(false);
    }
    const nested = effectSchema.safeParse(replaceOutput({ a: { b: [1, { c: 1n }] } }));
    expect(nested.success).toBe(false);
    if (!nested.success) expect(nested.error.issues[0]?.message).toContain("$.a.b[1].c");
  });

  it("exposes the JSON predicate and the offending path", () => {
    expect(isJsonValue({ ok: [1, "two", null, { deep: true }] })).toBe(true);
    expect(isJsonValue(undefined)).toBe(false);
    expect(findNonJsonPath({ when: new Date(0) })).toBe("$.when");
    expect(findNonJsonPath(cyclic)).toBe("$.self");
    expect(findNonJsonPath([1, [2, [Number.NaN]]])).toBe("$[1][1][0]");
  });

  it("rejects values that throw while being inspected", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("not inspectable");
        },
      },
    );
    expect(findNonJsonPath(hostile)).toBe("$");
    expect(isJsonValue(hostile)).toBe(false);
    expect(effectSchema.safeParse(replaceInput(hostile)).success).toBe(false);
  });
});
