import { describe, expect, it } from "vitest";

import type { HookDefinition } from "@hooknostic/sdk";
import { block, definePlugin, hook, replaceInput } from "@hooknostic/sdk";

import { buildPluginIR, hookAppliesToTarget } from "./ir.js";

function examplePlugin() {
  return definePlugin({
    name: "example",
    version: "1.0.0",
    hooks: [
      hook("tool.before", {
        id: "protect-shell",
        match: { kind: "shell" },
        capabilities: {
          "tool.before.block": "required",
          "tool.before.input.replace": "optional",
        },
        async run(event, ctx) {
          const { command = "" } = event.tool.input as { command?: string };
          if (command.includes("rm -rf /")) return block("no");
          if (ctx.capabilities.has("tool.before.input.replace")) return replaceInput({ command });
          return;
        },
      }),
      hook("session.start", {
        id: "bootstrap",
        targets: { include: ["claude", "codex"] },
        async run() {},
      }),
    ],
  });
}

describe("buildPluginIR authoring round-trip", () => {
  // Every field on HookSpec has to survive the schema, and the schema is
  // .strict(). `timeoutMs` was added to the type, the IR and the dispatcher but
  // not here, so authoring it the documented way failed the build with HN501
  // while both of its unit tests passed -- they reached the IR by mutating it
  // after this function, and the dispatcher by constructing HookDefinitions by
  // hand. Neither crossed the seam a user crosses.
  it("carries a per-hook timeout declared through hook() all the way to the IR", () => {
    const { ir, diagnostics } = buildPluginIR(
      definePlugin({
        name: "budgets",
        hooks: [
          hook("turn.stop", {
            id: "slow",
            timeoutMs: 899_000,
            async run() {
              return;
            },
          }),
          hook("tool.before", {
            id: "fast",
            async run() {
              return;
            },
          }),
        ],
      }),
    );
    expect(diagnostics).toEqual([]);
    expect(ir?.hooks.map((h) => h.timeoutMs)).toEqual([899_000, undefined]);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["past the Node timer clamp", 2_147_483_648],
  ])("rejects a %s budget rather than emitting one that cannot work", (_label, timeoutMs) => {
    const { diagnostics } = buildPluginIR(
      definePlugin({
        name: "budgets",
        hooks: [
          hook("tool.before", {
            id: "bad",
            timeoutMs,
            async run() {
              return;
            },
          }),
        ],
      }),
    );
    expect(diagnostics.some((d) => d.code === "HN501" && d.severity === "error")).toBe(true);
  });

  it("carries event-relative capability keys to the IR as full ids", () => {
    const { ir, diagnostics } = buildPluginIR(
      definePlugin({
        name: "relative",
        hooks: [
          hook("turn.stop", {
            id: "stop",
            capabilities: { prevent: "required", "turn.stop.notify": "optional" },
            async run() {},
          }),
        ],
      }),
    );
    expect(diagnostics).toEqual([]);
    expect(ir?.hooks[0]?.capabilities).toEqual({ "turn.stop.prevent": "required", "turn.stop.notify": "optional" });
  });

  it("reports a type-bypassed foreign id by its real name and an unknown key as HN501", () => {
    const foreign = buildPluginIR(
      definePlugin({
        name: "foreign",
        // Untyped callers: a full id from another event must pass through
        // canonicalization untouched so the scope check can name it.
        hooks: [
          hook("tool.after", { id: "t", capabilities: { "tool.before.block": "required" } as never, async run() {} }),
        ],
      }),
    );
    expect(foreign.diagnostics[0]).toMatchObject({ code: "HN501", hookId: "t", capability: "tool.before.block" });

    const unknown = buildPluginIR(
      definePlugin({
        name: "unknown",
        hooks: [hook("tool.before", { id: "u", capabilities: { bogus: "required" } as never, async run() {} })],
      }),
    );
    expect(unknown.ir).toBeUndefined();
    expect(unknown.diagnostics.every((d) => d.code === "HN501")).toBe(true);
  });
});

describe("buildPluginIR", () => {
  it("produces a deterministic, serializable IR", () => {
    const a = buildPluginIR(examplePlugin());
    const b = buildPluginIR(examplePlugin());
    expect(a.diagnostics).toEqual([]);
    expect(a.ir).toBeDefined();
    expect(JSON.stringify(a.ir)).toBe(JSON.stringify(b.ir));
    expect(a.ir).toEqual({
      name: "example",
      version: "1.0.0",
      hooks: [
        {
          index: 0,
          event: "tool.before",
          id: "protect-shell",
          match: { kind: "shell" },
          capabilities: {
            "tool.before.block": "required",
            "tool.before.input.replace": "optional",
          },
        },
        {
          index: 1,
          event: "session.start",
          id: "bootstrap",
          targets: { include: ["claude", "codex"] },
          capabilities: {},
        },
      ],
    });
  });

  it("rejects duplicate hook ids with HN501", () => {
    const plugin = definePlugin({
      name: "dup",
      hooks: [
        hook("session.start", { id: "same", async run() {} }),
        hook("session.end", { id: "same", async run() {} }),
      ],
    });
    const result = buildPluginIR(plugin);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "HN501",
      severity: "error",
      hookId: "same",
    });
  });

  it("rejects non-plugin values with HN501", () => {
    for (const bad of [null, 42, "plugin", { hooks: [] }, { name: "x" }]) {
      const result = buildPluginIR(bad);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics.every((d) => d.code === "HN501")).toBe(true);
    }
  });

  it("rejects matchers on non-tool events (bypassing the type layer)", () => {
    const plugin = definePlugin({
      name: "bad-match",
      hooks: [hook("session.start", { id: "s", async run() {} })],
    });
    plugin.hooks[0]!.match = { kind: "shell" };
    const result = buildPluginIR(plugin);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "HN501", hookId: "s" });
  });

  it("carries an agent scope declared through hook() to the IR (ADR-0030)", () => {
    const { ir, diagnostics } = buildPluginIR(
      definePlugin({
        name: "scoped",
        hooks: [hook("tool.before", { id: "reviewer", agents: { include: ["reviewer"] }, async run() {} })],
      }),
    );
    expect(diagnostics).toEqual([]);
    expect(ir?.hooks[0]).toMatchObject({
      agents: { include: ["reviewer"] },
      capabilities: { "tool.before.agent.identity": "required" },
    });
  });

  it.each(["include", "exclude"] as const)(
    "requires agent identity for a plain %s scope without mutating its capabilities",
    (scope) => {
      const capabilities = Object.freeze({ "tool.before.block": "required" as const });
      const definition: HookDefinition = {
        event: "tool.before",
        id: "plain-reviewer",
        agents: { [scope]: ["reviewer"] },
        capabilities,
        async run() {},
      };

      const { ir, diagnostics } = buildPluginIR(definePlugin({ name: "plain-scoped", hooks: [definition] }));

      expect(diagnostics).toEqual([]);
      expect(ir?.hooks[0]?.capabilities).toEqual({
        "tool.before.block": "required",
        "tool.before.agent.identity": "required",
      });
      expect(definition.capabilities).toBe(capabilities);
      expect(definition.capabilities).toEqual({ "tool.before.block": "required" });
    },
  );

  it("requires agent identity when a scope is added after hook() construction", () => {
    const definition = hook("agent.stop", { id: "late-scope", async run() {} });
    definition.agents = { exclude: ["reviewer"] };

    const { ir, diagnostics } = buildPluginIR(definePlugin({ name: "late-scoped", hooks: [definition] }));

    expect(diagnostics).toEqual([]);
    expect(ir?.hooks[0]?.capabilities).toEqual({ "agent.stop.agent.identity": "required" });
    expect(definition.capabilities).toEqual({});
  });

  it("rejects optional agent identity in a plain scoped definition with HN501", () => {
    const definition: HookDefinition = {
      event: "tool.before",
      id: "optional-scoped-identity",
      agents: { exclude: ["reviewer"] },
      capabilities: Object.freeze({ "tool.before.agent.identity": "optional" }),
      async run() {},
    };

    const { ir, diagnostics } = buildPluginIR(definePlugin({ name: "contradictory-scope", hooks: [definition] }));

    expect(ir).toBeUndefined();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "HN501",
        severity: "error",
        hookId: definition.id,
        event: "tool.before",
        capability: "tool.before.agent.identity",
      }),
    ]);
    expect(definition.capabilities).toEqual({ "tool.before.agent.identity": "optional" });
  });

  it("preserves explicit required scoped identity and optional unscoped identity", () => {
    const definitions: HookDefinition[] = [
      {
        event: "tool.before",
        id: "explicit-scoped-identity",
        agents: { include: ["reviewer"] },
        capabilities: Object.freeze({ "tool.before.agent.identity": "required" }),
        async run() {},
      },
      {
        event: "tool.before",
        id: "unscoped-identity-probe",
        capabilities: Object.freeze({ "tool.before.agent.identity": "optional" }),
        async run() {},
      },
    ];

    const { ir, diagnostics } = buildPluginIR(definePlugin({ name: "explicit-identity", hooks: definitions }));

    expect(diagnostics).toEqual([]);
    expect(ir?.hooks.map((definition) => definition.capabilities)).toEqual([
      { "tool.before.agent.identity": "required" },
      { "tool.before.agent.identity": "optional" },
    ]);
    expect(definitions.map((definition) => definition.capabilities)).toEqual([
      { "tool.before.agent.identity": "required" },
      { "tool.before.agent.identity": "optional" },
    ]);
  });

  it("rejects an agent scope on an event no harness attributes to an agent (bypassing the type layer)", () => {
    const plugin = definePlugin({
      name: "bad-agents",
      hooks: [hook("session.start", { id: "s", async run() {} })],
    });
    plugin.hooks[0]!.agents = { include: ["reviewer"] };
    const result = buildPluginIR(plugin);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "HN501", hookId: "s" });
  });

  it("rejects an empty agents.include, which could never run", () => {
    const result = buildPluginIR(
      definePlugin({
        name: "empty-agents",
        hooks: [hook("tool.before", { id: "t", agents: { include: [] }, async run() {} })],
      }),
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "HN501", hookId: "t" });
  });

  it("rejects capabilities scoped to a different event (bypassing the type layer)", () => {
    const plugin = definePlugin({
      name: "bad-scope",
      hooks: [hook("tool.after", { id: "t", async run() {} })],
    });
    (plugin.hooks[0]!.capabilities as Record<string, string>)["tool.before.block"] = "required";
    const result = buildPluginIR(plugin);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({
      code: "HN501",
      hookId: "t",
      capability: "tool.before.block",
    });
  });
});

describe("hookAppliesToTarget", () => {
  it("honors include/exclude scoping", () => {
    expect(hookAppliesToTarget({}, "claude")).toBe(true);
    expect(hookAppliesToTarget({ targets: { include: ["claude"] } }, "claude")).toBe(true);
    expect(hookAppliesToTarget({ targets: { include: ["claude"] } }, "codex")).toBe(false);
    expect(hookAppliesToTarget({ targets: { exclude: ["opencode"] } }, "opencode")).toBe(false);
    expect(hookAppliesToTarget({ targets: { exclude: ["opencode"] } }, "claude")).toBe(true);
  });
});
