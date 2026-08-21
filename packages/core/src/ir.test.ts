import { describe, expect, it } from "vitest";
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
          if (ctx.capabilities.has("tool.before.input.replace"))
            return replaceInput({ command });
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

  it("rejects capabilities scoped to a different event (bypassing the type layer)", () => {
    const plugin = definePlugin({
      name: "bad-scope",
      hooks: [hook("tool.after", { id: "t", async run() {} })],
    });
    (plugin.hooks[0]!.capabilities as Record<string, string>)["tool.before.block"] =
      "required";
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
    expect(hookAppliesToTarget({ targets: { exclude: ["opencode"] } }, "opencode")).toBe(
      false,
    );
    expect(hookAppliesToTarget({ targets: { exclude: ["opencode"] } }, "claude")).toBe(true);
  });
});
