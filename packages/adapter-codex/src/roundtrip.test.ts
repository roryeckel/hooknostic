import { describe, expect, it } from "vitest";
import { block, definePlugin, hook, replaceInput } from "@hooknostic/sdk";
import { dispatch } from "@hooknostic/runtime";
import { loadFixture } from "@hooknostic/testkit";
import { applyCodex } from "./apply.js";
import { decodeCodex } from "./decode.js";
import { codexCapabilityProfiles } from "./profile.js";

const INVOCATION = { targetId: "codex", harnessVersion: "0.148.0" };
const LEVELS = Object.fromEntries(
  Object.entries(codexCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]),
);

const plugin = definePlugin({
  name: "roundtrip",
  hooks: [
    hook("tool.before", {
      id: "protect-and-normalize-shell",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        const input = event.tool.input as { command?: string };
        const command = input.command ?? "";
        if (command.includes("rm -rf /")) return block("Refusing destructive root deletion");
        if (ctx.capabilities.has("tool.before.input.replace") && command.startsWith("npm ")) {
          return replaceInput({ command: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),
  ],
});

async function roundTrip(nativeInput: unknown) {
  const event = decodeCodex(nativeInput, INVOCATION);
  const result = await dispatch(plugin.hooks, event, {
    targetId: "codex",
    harness: event.harness,
    capabilities: LEVELS,
  });
  return applyCodex(result, nativeInput, INVOCATION);
}

describe("golden round-trip (codex)", () => {
  it("blocks a destructive shell command", async () => {
    const input = loadFixture<Record<string, unknown>>(
      "codex",
      "0.148",
      "pre-tool-bash.input.json",
    );
    const native = await roundTrip({ ...input, tool_input: { command: "rm -rf /" } });
    expect(native).toEqual(loadFixture("codex", "0.148", "pre-tool-block.output.json"));
  });

  it("rewrites npm to pnpm through the allow+updatedInput protocol", async () => {
    const input = loadFixture<Record<string, unknown>>(
      "codex",
      "0.148",
      "pre-tool-bash.input.json",
    );
    const native = await roundTrip({ ...input, tool_input: { command: "npm install" } });
    expect(native).toEqual(loadFixture("codex", "0.148", "pre-tool-rewrite.output.json"));
  });

  it("continues unchanged for benign commands", async () => {
    const native = await roundTrip(loadFixture("codex", "0.148", "pre-tool-bash.input.json"));
    expect(native).toEqual({ exitCode: 0 });
  });
});
