import { describe, expect, it } from "vitest";
import { addContext, block, definePlugin, hook, replaceInput, replaceOutput } from "@hooknostic/sdk";
import { opencodeCapabilityProfiles } from "./profile.js";
import { createHooknosticHooks } from "./shim.js";

const LEVELS = Object.fromEntries(
  Object.entries(opencodeCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]),
);

const PLUGIN_INPUT = { directory: "C:/project", worktree: "C:/project" };

function smokePlugin() {
  return definePlugin({
    name: "shim-test",
    hooks: [
      hook("tool.before", {
        id: "guard",
        match: { kind: "shell" },
        capabilities: {
          "tool.before.block": "required",
          "tool.before.input.replace": "optional",
        },
        async run(event, ctx) {
          const { command = "" } = event.tool.input as { command?: string };
          if (command.includes("rm -rf /")) return block("blocked by guard");
          if (ctx.capabilities.has("tool.before.input.replace") && command.startsWith("npm ")) {
            return replaceInput({ command: command.replace(/^npm /, "pnpm ") });
          }
        },
      }),
      hook("tool.after", {
        id: "redact",
        capabilities: { "tool.after.output.replace": "required" },
        async run(event) {
          if (typeof event.output === "string" && event.output.includes("SECRET")) {
            return replaceOutput(event.output.replaceAll("SECRET", "[redacted]"));
          }
        },
      }),
      hook("permission.request", {
        id: "deny-mkdir",
        capabilities: { "permission.request.block": "required" },
        async run(event) {
          const title = (event.tool.input as { title?: string }).title ?? "";
          if (title.includes("mkdir")) return block("no new directories");
        },
      }),
      hook("context.compact.before", {
        id: "compact-note",
        capabilities: { "context.compact.before.context.add": "required" },
        async run() {
          return addContext("hooknostic compaction note");
        },
      }),
      hook("turn.stop", { id: "observe-idle", async run() {} }),
    ],
  });
}

function hooks() {
  return createHooknosticHooks(smokePlugin(), { capabilities: LEVELS }, PLUGIN_INPUT);
}

describe("createHooknosticHooks", () => {
  it("registers only the callbacks the plugin needs", () => {
    expect(Object.keys(hooks()).sort()).toEqual([
      "event",
      "experimental.session.compacting",
      "permission.ask",
      "tool.execute.after",
      "tool.execute.before",
    ]);
  });

  it("blocks by throwing inside tool.execute.before", async () => {
    const h = hooks();
    await expect(
      h["tool.execute.before"]!(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "rm -rf /" } },
      ),
    ).rejects.toThrow("blocked by guard");
  });

  it("rewrites input by mutating output.args", async () => {
    const h = hooks();
    const output = { args: { command: "npm install" } };
    await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, output);
    expect(output.args).toEqual({ command: "pnpm install" });
  });

  it("preserves a replacement that aliases the live arguments object", async () => {
    const plugin = definePlugin({
      name: "aliased-replacement",
      hooks: [
        hook("tool.before", {
          id: "alias",
          capabilities: { "tool.before.input.replace": "required" },
          async run(event) {
            const input = event.tool.input as { command: string };
            input.command = "pnpm install";
            return replaceInput(input);
          },
        }),
      ],
    });
    const h = createHooknosticHooks(plugin, { capabilities: LEVELS }, PLUGIN_INPUT);
    const output = { args: { command: "npm install" } };
    await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, output);
    expect(output.args).toEqual({ command: "pnpm install" });
  });

  it("replaces tool output by mutating output.output", async () => {
    const h = hooks();
    const output = { title: "t", output: "token SECRET here", metadata: {} };
    await h["tool.execute.after"]!(
      { tool: "bash", sessionID: "s", callID: "c", args: {} },
      output,
    );
    expect(output.output).toBe("token [redacted] here");
  });

  it("applies cyclic output replacements without throwing", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const plugin = definePlugin({
      name: "cyclic-output",
      hooks: [
        hook("tool.after", {
          id: "replace-cycle",
          capabilities: { "tool.after.output.replace": "required" },
          async run() {
            return replaceOutput(cyclic);
          },
        }),
      ],
    });
    const h = createHooknosticHooks(plugin, { capabilities: LEVELS }, PLUGIN_INPUT);
    const output = { output: "before" };
    await expect(
      h["tool.execute.after"]!(
        { tool: "bash", sessionID: "s", callID: "c", args: {} },
        output,
      ),
    ).resolves.toBeUndefined();
    expect(output.output).toBe("[object Object]");
  });

  it("denies permissions by mutating output.status", async () => {
    const h = hooks();
    const output = { status: "ask" };
    await h["permission.ask"]!(
      { id: "p", type: "bash", sessionID: "s", callID: "c", title: "mkdir x", metadata: {}, time: {} },
      output,
    );
    expect(output.status).toBe("deny");
  });

  it("appends compaction context", async () => {
    const h = hooks();
    const output = { context: ["existing"] };
    await h["experimental.session.compacting"]!({ sessionID: "s" }, output);
    expect(output.context).toEqual(["existing", "hooknostic compaction note"]);
  });

  it("ignores unmapped bus events without throwing (fail-open)", async () => {
    const h = hooks();
    await expect(
      h["event"]!({ event: { type: "message.part.updated" } }, undefined),
    ).resolves.toBeUndefined();
  });

  it("is invocation-stateless across repeated dispatches in one module lifetime", async () => {
    const h = hooks(); // one persistent hooks object, as in a real session
    for (let i = 0; i < 3; i++) {
      const output = { args: { command: "npm install" } };
      await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: `c${i}` }, output);
      // Identical behavior every time: nothing accumulates across invocations.
      expect(output.args).toEqual({ command: "pnpm install" });
    }
    await expect(
      h["tool.execute.before"]!(
        { tool: "bash", sessionID: "s", callID: "c9" },
        { args: { command: "rm -rf /" } },
      ),
    ).rejects.toThrow("blocked by guard");
  });
});
