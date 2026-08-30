/**
 * Compile-time contract tests. The `@ts-expect-error` directives are enforced
 * by `pnpm typecheck` (tsc errors if a directive stops erroring), so this file
 * proves that undeclared effects and mis-scoped capabilities fail the build.
 */
import { describe, expect, it } from "vitest";
import {
  addContext,
  block,
  definePlugin,
  hook,
  notify,
  preventStop,
  replaceInput,
  replaceOutput,
} from "./index.js";

describe("compile-time hook contracts", () => {
  it("accepts declared effects and rejects undeclared ones", () => {
    const ok = hook("tool.before", {
      id: "declared-effects",
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        if (ctx.capabilities.has("tool.before.input.replace")) {
          return replaceInput({ command: "pnpm install" });
        }
        return block(`no ${event.tool.nativeName}`);
      },
    });

    const undeclared = hook("tool.before", {
      id: "undeclared-effect",
      capabilities: { "tool.before.block": "required" },
      // @ts-expect-error replaceInput requires declaring tool.before.input.replace
      async run() {
        return replaceInput({ command: "x" });
      },
    });

    const noCapabilities = hook("session.end", {
      id: "observe-only",
      // @ts-expect-error observe-only hooks may not return effects
      async run() {
        return block("nope");
      },
    });

    expect(ok.id).toBe("declared-effects");
    expect(undeclared.id).toBe("undeclared-effect");
    expect(noCapabilities.id).toBe("observe-only");
  });

  it("rejects capabilities scoped to a different event", () => {
    const wrongScope = hook("tool.after", {
      id: "wrong-scope",
      capabilities: {
        // @ts-expect-error tool.before.block is not a tool.after capability
        "tool.before.block": "required",
      },
      async run() {},
    });
    expect(wrongScope.id).toBe("wrong-scope");
  });

  it("rejects effects that are structurally impossible on the event", () => {
    const h = hook("session.start", {
      id: "session-context",
      capabilities: { "session.start.context.add": "optional" },
      async run(event, ctx) {
        if (!ctx.capabilities.has("session.start.context.add")) return;
        return addContext(`cwd: ${event.session.cwd}`);
      },
    });

    const bad = hook("session.start", {
      id: "session-cannot-prevent",
      capabilities: { "session.start.context.add": "optional" },
      // @ts-expect-error preventStop is not licensed by session.start capabilities
      async run() {
        return preventStop();
      },
    });

    expect(h.id).toBe("session-context");
    expect(bad.id).toBe("session-cannot-prevent");
  });

  it("scopes output replacement to tool.after", () => {
    const h = hook("tool.after", {
      id: "redact-output",
      capabilities: { "tool.after.output.replace": "required" },
      async run(event) {
        return replaceOutput({ redactedFrom: event.tool.nativeName });
      },
    });
    expect(h.id).toBe("redact-output");
  });

  it("only allows tool matchers on tool-scoped events", () => {
    const ok = hook("tool.before", {
      id: "match-shell",
      match: { kind: "shell" },
      async run() {},
    });

    const bad = hook("turn.stop", {
      id: "no-match-here",
      // @ts-expect-error turn.stop is not tool-scoped
      match: { kind: "shell" },
      async run() {},
    });

    expect(ok.match).toEqual({ kind: "shell" });
    expect(bad.id).toBe("no-match-here");
  });

  it("scopes notify to the stop events", () => {
    const ok = hook("turn.stop", {
      id: "notifier",
      capabilities: { "turn.stop.notify": "optional" },
      async run(_event, ctx) {
        if (ctx.capabilities.has("turn.stop.notify")) return notify("idle check skipped");
        return;
      },
    });

    const wrongEvent = hook("tool.before", {
      id: "notify-on-tool",
      capabilities: {
        // @ts-expect-error notify is not available on tool.before
        "tool.before.notify": "optional",
      },
      async run() {},
    });

    // The case that catches a botched EffectForCapability ladder edit: the
    // capability is real, but it does not license this effect.
    const undeclared = hook("turn.stop", {
      id: "notify-undeclared",
      capabilities: { "turn.stop.prevent": "required" },
      // @ts-expect-error notify requires declaring turn.stop.notify
      async run() {
        return notify("unannounced");
      },
    });

    expect([ok.id, wrongEvent.id, undeclared.id]).toEqual([
      "notifier",
      "notify-on-tool",
      "notify-undeclared",
    ]);
  });

  it("erases to a uniform HookDefinition inside definePlugin", () => {
    const plugin = definePlugin({
      name: "typed-plugin",
      hooks: [
        hook("tool.before", {
          id: "a",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return block("no");
          },
        }),
        hook("turn.stop", {
          id: "b",
          capabilities: { "turn.stop.prevent": "optional" },
          async run(_event, ctx) {
            if (ctx.capabilities.has("turn.stop.prevent")) return preventStop("keep going");
            return;
          },
        }),
      ],
    });
    expect(plugin.hooks.map((h) => h.id)).toEqual(["a", "b"]);
  });
});
