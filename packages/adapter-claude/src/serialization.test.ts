import { describe, expect, it } from "vitest";
import type { ToolBeforeEvent } from "@hooknostic/sdk";
import { block, definePlugin, hook, replaceInput } from "@hooknostic/sdk";
import { dispatch } from "@hooknostic/runtime";
import { applyClaude } from "./apply.js";
import { claudeCapabilityProfiles } from "./profile.js";

const LEVELS = Object.fromEntries(
  Object.entries(claudeCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]),
);

function preToolUse(): ToolBeforeEvent {
  return {
    schemaVersion: 1,
    event: "tool.before",
    harness: { id: "claude", version: "2.1.238", nativeEvent: "PreToolUse" },
    session: { id: "s", cwd: "C:/repo" },
    correlation: { toolCallId: "toolu_1" },
    raw: {},
    tool: { kind: "shell", nativeName: "Bash", input: { command: "rm -rf /" } },
  };
}

describe("Claude response serialization", () => {
  it("keeps a terminal deny serializable when an earlier hook returned a non-JSON replacement", async () => {
    const cyclic: Record<string, unknown> = { command: "rm -rf /" };
    cyclic["self"] = cyclic;
    const plugin = definePlugin({
      name: "p",
      hooks: [
        hook("tool.before", {
          id: "rewrite",
          capabilities: { "tool.before.input.replace": "required" },
          async run() {
            return replaceInput(cyclic);
          },
        }),
        hook("tool.before", {
          id: "guard",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return block("Refusing destructive root deletion");
          },
        }),
      ],
    });
    const result = await dispatch(plugin.hooks, preToolUse(), {
      targetId: "claude",
      harness: { id: "claude", version: "2.1.238" },
      capabilities: LEVELS,
    });
    expect(result.errors.map((e) => e.hookId)).toEqual(["rewrite"]);

    const native = await applyClaude(result, {}, { targetId: "claude" });
    // Exactly what the command shim writes to stdout: it must serialize, and
    // the denial must survive — previously a cyclic updatedInput made
    // JSON.stringify throw and the shim exited 0 (fail-open) without it.
    const body = JSON.parse(JSON.stringify(native.body)) as {
      hookSpecificOutput: Record<string, unknown>;
    };
    expect(body.hookSpecificOutput["permissionDecision"]).toBe("deny");
    expect(body.hookSpecificOutput["updatedInput"]).toBeUndefined();
    expect(native.exitCode).toBe(0);
  });
});
