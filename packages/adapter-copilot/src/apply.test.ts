import { describe, expect, it } from "vitest";

import type { HookResult } from "@hooknostic/sdk";

import { applyCopilot } from "./apply.js";
import { copilotHarness } from "./harness.js";

const INVOCATION = { targetId: "copilot", harnessVersion: copilotHarness.referenceVersion };

function result(partial: Partial<HookResult> & Pick<HookResult, "event">): HookResult {
  return { schemaVersion: 1, effects: [], errors: [], ...partial };
}

describe("applyCopilot", () => {
  it("encodes tool.before block as a top-level permissionDecision deny", async () => {
    const native = await applyCopilot(
      result({
        event: "tool.before",
        effects: [{ hookId: "guard", effect: { kind: "block", reason: "refusing rm -rf" } }],
        terminatedBy: "guard",
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual({
      exitCode: 0,
      body: { permissionDecision: "deny", permissionDecisionReason: "refusing rm -rf" },
    });
  });

  it("drops a rewrite and context recorded before a terminal deny", async () => {
    const native = await applyCopilot(
      result({
        event: "tool.before",
        effects: [
          { hookId: "rewrite", effect: { kind: "replaceInput", input: { command: "echo rewritten" } } },
          { hookId: "context", effect: { kind: "addContext", context: "token" } },
          { hookId: "guard", effect: { kind: "block", reason: "no" } },
        ],
        terminatedBy: "guard",
      }),
      {},
      INVOCATION,
    );
    expect(native.body).toEqual({ permissionDecision: "deny", permissionDecisionReason: "no" });
  });

  it("encodes requestApproval as permissionDecision ask with its reason", async () => {
    const native = await applyCopilot(
      result({
        event: "tool.before",
        effects: [{ hookId: "ask", effect: { kind: "requestApproval", reason: "needs review" } }],
        terminatedBy: "ask",
      }),
      {},
      INVOCATION,
    );
    expect(native.body).toEqual({ permissionDecision: "ask", permissionDecisionReason: "needs review" });
  });

  it("encodes a rewrite as modifiedArgs and keeps context beside it", async () => {
    const native = await applyCopilot(
      result({
        event: "tool.before",
        effects: [
          { hookId: "rewrite", effect: { kind: "replaceInput", input: { command: "echo rewritten" } } },
          { hookId: "context", effect: { kind: "addContext", context: "first" } },
          { hookId: "context2", effect: { kind: "addContext", context: "second" } },
        ],
      }),
      {},
      INVOCATION,
    );
    expect(native.body).toEqual({ modifiedArgs: { command: "echo rewritten" }, additionalContext: "first\n\nsecond" });
  });

  it("encodes permission.request block as behavior deny with message", async () => {
    const native = await applyCopilot(
      result({
        event: "permission.request",
        effects: [{ hookId: "deny", effect: { kind: "block", reason: "denied by policy" } }],
        terminatedBy: "deny",
      }),
      {},
      INVOCATION,
    );
    expect(native.body).toEqual({ behavior: "deny", message: "denied by policy" });
  });

  it("encodes tool.after output replacement as a success result and keeps context", async () => {
    const native = await applyCopilot(
      result({
        event: "tool.after",
        effects: [
          { hookId: "replace", effect: { kind: "replaceOutput", output: "hooknostic-replaced" } },
          { hookId: "context", effect: { kind: "addContext", context: "guidance" } },
        ],
      }),
      {},
      INVOCATION,
    );
    expect(native.body).toEqual({
      modifiedResult: { resultType: "success", textResultForLlm: "hooknostic-replaced" },
      additionalContext: "guidance",
    });
  });

  it("JSON-encodes a non-string replacement because the native field is text", async () => {
    const native = await applyCopilot(
      result({
        event: "tool.after",
        effects: [{ hookId: "replace", effect: { kind: "replaceOutput", output: { ok: true } } }],
      }),
      {},
      INVOCATION,
    );
    expect(native.body).toEqual({
      modifiedResult: { resultType: "success", textResultForLlm: '{"ok":true}' },
    });
  });

  it("encodes tool.error and session.start context as additionalContext", async () => {
    for (const event of ["tool.error", "session.start"] as const) {
      const native = await applyCopilot(
        result({
          event,
          effects: [{ hookId: "context", effect: { kind: "addContext", context: "token" } }],
        }),
        {},
        INVOCATION,
      );
      expect(native).toEqual({ exitCode: 0, body: { additionalContext: "token" } });
    }
  });

  it("encodes preventStop on turn.stop and agent.stop as decision block", async () => {
    for (const event of ["turn.stop", "agent.stop"] as const) {
      const native = await applyCopilot(
        result({
          event,
          effects: [{ hookId: "continue", effect: { kind: "preventStop", reason: "keep working" } }],
          terminatedBy: "continue",
        }),
        {},
        INVOCATION,
      );
      expect(native).toEqual({ exitCode: 0, body: { decision: "block", reason: "keep working" } });
    }
  });

  it("ignores notify, which has no captured user-facing channel on these events", async () => {
    const native = await applyCopilot(
      result({
        event: "turn.stop",
        effects: [{ hookId: "notice", effect: { kind: "notify", message: "uncommitted files" } }],
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual({ exitCode: 0 });
  });

  it("emits a clean exit 0 with no body when there are no effects", async () => {
    const native = await applyCopilot(result({ event: "session.end" }), {}, INVOCATION);
    expect(native).toEqual({ exitCode: 0 });
  });

  it("never encodes an intentional deny as a non-zero exit", async () => {
    // Copilot fails closed on ANY non-zero preToolUse exit, but a crash and a
    // deliberate deny must not look alike, and exit 2 cannot carry a reason.
    const native = await applyCopilot(
      result({
        event: "tool.before",
        effects: [{ hookId: "guard", effect: { kind: "block", reason: "no" } }],
        terminatedBy: "guard",
      }),
      {},
      INVOCATION,
    );
    expect(native.exitCode).toBe(0);
  });
});
