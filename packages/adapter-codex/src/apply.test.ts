import { describe, expect, it } from "vitest";

import type { HookResult } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import { applyCodex } from "./apply.js";
import { codexHarness } from "./harness.js";

const INVOCATION = { targetId: "codex", harnessVersion: codexHarness.referenceVersion };

function result(partial: Partial<HookResult> & Pick<HookResult, "event">): HookResult {
  return { schemaVersion: 1, effects: [], errors: [], ...partial };
}

describe("applyCodex", () => {
  it("encodes tool.before block as permissionDecision deny", async () => {
    const native = await applyCodex(
      result({
        event: "tool.before",
        effects: [
          {
            hookId: "guard",
            effect: { kind: "block", reason: "Refusing destructive root deletion" },
          },
        ],
        terminatedBy: "guard",
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual(loadFixture("codex", "0.148", "pre-tool-block.output.json"));
  });

  it("encodes input replacement as allow + updatedInput per the 0.148 protocol", async () => {
    const native = await applyCodex(
      result({
        event: "tool.before",
        effects: [
          {
            hookId: "rewrite",
            effect: { kind: "replaceInput", input: { command: "pnpm install" } },
          },
        ],
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual(loadFixture("codex", "0.148", "pre-tool-rewrite.output.json"));
  });

  it("encodes requestApproval as permissionDecision ask", async () => {
    const native = await applyCodex(
      result({
        event: "tool.before",
        effects: [
          {
            hookId: "ask",
            effect: {
              kind: "requestApproval",
              reason: "Database mutation requires explicit approval",
            },
          },
        ],
        terminatedBy: "ask",
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual(loadFixture("codex", "0.148", "pre-tool-ask.output.json"));
  });

  it("block wins over an earlier rewrite in the same dispatch", async () => {
    const native = await applyCodex(
      result({
        event: "tool.before",
        effects: [
          { hookId: "rewrite", effect: { kind: "replaceInput", input: { command: "x" } } },
          { hookId: "guard", effect: { kind: "block", reason: "no" } },
        ],
        terminatedBy: "guard",
      }),
      {},
      INVOCATION,
    );
    const hookSpecific = (native.body as Record<string, any>)["hookSpecificOutput"];
    expect(hookSpecific.permissionDecision).toBe("deny");
    expect(hookSpecific.updatedInput).toBeUndefined();
  });

  it("encodes preventStop and blockContinuation as decision block", async () => {
    for (const [event, fixture] of [
      ["turn.stop", "stop-prevent.output.json"],
      ["agent.stop", "stop-prevent.output.json"],
    ] as const) {
      const native = await applyCodex(
        result({
          event,
          effects: [
            {
              hookId: "h",
              effect: {
                kind: "preventStop",
                reason: "Tests have not been run yet; keep working.",
              },
            },
          ],
          terminatedBy: "h",
        }),
        {},
        INVOCATION,
      );
      expect(native).toEqual(loadFixture("codex", "0.148", fixture));
    }

    const cont = await applyCodex(
      result({
        event: "tool.after",
        effects: [
          {
            hookId: "halt",
            effect: {
              kind: "blockContinuation",
              reason: "Output contained credentials; do not proceed.",
            },
          },
        ],
        terminatedBy: "halt",
      }),
      {},
      INVOCATION,
    );
    expect(cont).toEqual(loadFixture("codex", "0.148", "post-tool-block-continuation.output.json"));
  });

  it("encodes permission.request block via decision.behavior deny", async () => {
    const native = await applyCodex(
      result({
        event: "permission.request",
        effects: [{ hookId: "g", effect: { kind: "block", reason: "Blocked by policy hook" } }],
        terminatedBy: "g",
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual(loadFixture("codex", "0.148", "permission-deny.output.json"));
  });

  it("encodes MCP output replacement via updatedMCPToolOutput", async () => {
    const native = await applyCodex(
      result({
        event: "tool.after",
        effects: [{ hookId: "redact", effect: { kind: "replaceOutput", output: "[redacted]" } }],
      }),
      {},
      INVOCATION,
    );
    expect(native.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedMCPToolOutput: "[redacted]",
      },
    });
  });

  it("emits a clean exit 0 when there is nothing to say", async () => {
    expect(await applyCodex(result({ event: "session.end" }), {}, INVOCATION)).toEqual({
      exitCode: 0,
    });
  });
});
