import { describe, expect, it } from "vitest";

import { dispatch } from "@hooknostic/runtime";
import { block, definePlugin, hook, updateShell } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import { applyClaude } from "./apply.js";
import { decodeClaude } from "./decode.js";
import { claudeHarness } from "./harness.js";
import { claudeCapabilityProfiles } from "./profile.js";
import { claudeShellCodec } from "./toolmap.js";

const INVOCATION = { targetId: "claude", harnessVersion: claudeHarness.referenceVersion };

const LEVELS = Object.fromEntries(
  Object.entries(claudeCapabilityProfiles[0]!.matrix).map(([id, entry]) => [id, entry.level]),
);

/** Appendix-A style plugin used for the golden round-trip. */
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
        const raw = (event.tool.input as { command?: unknown }).command;
        const command = event.tool.shell?.command ?? (typeof raw === "string" ? raw : "");
        if (command.includes("rm -rf /")) return block("Refusing destructive root deletion");
        if (
          ctx.capabilities.has("tool.before.input.replace") &&
          event.tool.shell !== undefined &&
          command.startsWith("npm ")
        ) {
          // Sibling keys (description) are preserved by the codec, so the
          // existing output fixture is unchanged from the replaceInput days.
          return updateShell({ command: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),
  ],
});

async function roundTrip(nativeInput: unknown) {
  const event = decodeClaude(nativeInput, INVOCATION);
  const result = await dispatch(plugin.hooks, event, {
    targetId: "claude",
    harness: event.harness,
    capabilities: LEVELS,
    shellCodec: claudeShellCodec,
  });
  return applyClaude(result, nativeInput, INVOCATION);
}

describe("golden round-trip: native fixture → decode → handlers → apply → native result", () => {
  it("blocks a destructive shell command", async () => {
    const input = loadFixture<Record<string, unknown>>("claude", "2.1", "pre-tool-bash.input.json");
    const native = await roundTrip({
      ...input,
      tool_input: { command: "rm -rf / --no-preserve-root" },
    });
    expect(native).toEqual({
      exitCode: 0,
      body: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Refusing destructive root deletion",
        },
      },
    });
  });

  it("rewrites npm to pnpm", async () => {
    const input = loadFixture<Record<string, unknown>>("claude", "2.1", "pre-tool-bash.input.json");
    const native = await roundTrip({
      ...input,
      tool_input: { command: "npm install", description: "Echo fixture string" },
    });
    expect(native).toEqual(loadFixture("claude", "2.1", "pre-tool-rewrite.output.json"));
  });

  it("continues unchanged for benign commands", async () => {
    const native = await roundTrip(loadFixture("claude", "2.1", "pre-tool-bash.input.json"));
    expect(native).toEqual({ exitCode: 0 });
  });

  it("ignores non-shell tools via the matcher", async () => {
    const native = await roundTrip(loadFixture("claude", "2.1", "pre-tool-read.input.json"));
    expect(native).toEqual({ exitCode: 0 });
  });
});
