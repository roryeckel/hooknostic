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
        claude: { version: ">=2.1", mode: "plugin", output: "./dist/claude" },
      },
    };
    expect(hooknosticConfigSchema.parse(config).entry).toBe("./src/hooks.ts");
    expect(() =>
      hooknosticConfigSchema.parse({ ...config, daemon: true }),
    ).toThrow();
    expect(() =>
      hooknosticConfigSchema.parse({
        ...config,
        targets: { claude: { version: ">=2.1", mode: "service", output: "./x" } },
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
