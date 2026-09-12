import { describe, expect, it } from "vitest";

import type { HookResult } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import { applyClaude } from "./apply.js";
import { claudeHarness } from "./harness.js";

const INVOCATION = { targetId: "claude", harnessVersion: claudeHarness.referenceVersion };

function result(partial: Partial<HookResult> & Pick<HookResult, "event">): HookResult {
  return { schemaVersion: 1, effects: [], errors: [], ...partial };
}

describe("applyClaude", () => {
  it("encodes tool.before block as a permissionDecision deny", async () => {
    const native = await applyClaude(
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
    expect(native).toEqual(loadFixture("claude", "2.1", "pre-tool-block.output.json"));
  });

  it("block wins over an earlier rewrite in the same dispatch", async () => {
    // Cross-adapter agreement: Codex and OpenCode both suppress a recorded
    // rewrite on a terminal deny. The prior test that appeared to cover this
    // (serialization.test.ts) used a cyclic rewrite that dispatch rejected
    // before it was ever recorded -- vacuous against any mutant here.
    const native = await applyClaude(
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
    const hookSpecific = (native.body as Record<string, unknown>)["hookSpecificOutput"] as Record<string, unknown>;
    expect(hookSpecific["permissionDecision"]).toBe("deny");
    expect(hookSpecific["updatedInput"]).toBeUndefined();
  });

  it("encodes input replacement as updatedInput", async () => {
    const native = await applyClaude(
      result({
        event: "tool.before",
        effects: [
          {
            hookId: "rewrite",
            effect: {
              kind: "replaceInput",
              input: { command: "pnpm install", description: "Echo fixture string" },
            },
          },
        ],
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual(loadFixture("claude", "2.1", "pre-tool-rewrite.output.json"));
  });

  it("joins accumulated context into additionalContext", async () => {
    const native = await applyClaude(
      result({
        event: "tool.before",
        effects: [
          { hookId: "a", effect: { kind: "addContext", context: "repo: hooknostic" } },
          { hookId: "b", effect: { kind: "addContext", context: "branch: master" } },
        ],
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual(loadFixture("claude", "2.1", "pre-tool-context.output.json"));
  });

  it("encodes requestApproval as permissionDecision ask", async () => {
    const native = await applyClaude(
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
    expect(native).toEqual(loadFixture("claude", "2.1", "pre-tool-approval.output.json"));
  });

  it("encodes preventStop as an exit-0 decision (honored on Stop/SubagentStop)", async () => {
    for (const event of ["turn.stop", "agent.stop"] as const) {
      const native = await applyClaude(
        result({
          event,
          effects: [
            {
              hookId: "continue",
              effect: {
                kind: "preventStop",
                reason: "Tests have not been run yet; keep working.",
              },
            },
          ],
          terminatedBy: "continue",
        }),
        {},
        INVOCATION,
      );
      expect(native).toEqual(loadFixture("claude", "2.1", "stop-prevent.output.json"));
    }
  });

  it("encodes notify as a top-level systemMessage", async () => {
    for (const event of ["turn.stop", "agent.stop"] as const) {
      const native = await applyClaude(
        result({
          event,
          effects: [
            {
              hookId: "notice",
              effect: {
                kind: "notify",
                message: "hooknostic: 3 files are still uncommitted.",
              },
            },
          ],
        }),
        {},
        INVOCATION,
      );
      expect(native).toEqual(loadFixture("claude", "2.1", "stop-notify.output.json"));
    }
  });

  it("carries a notification through a terminal preventStop", async () => {
    // The composition the JSON encoding exists for: exit 2 cannot carry a body,
    // so under the old encoding this notice was unreachable. Verified live on
    // 2.1.250 — the reason reaches the model, the notice reaches only the user.
    const native = await applyClaude(
      result({
        event: "turn.stop",
        effects: [
          {
            hookId: "notice",
            effect: { kind: "notify", message: "hooknostic: 3 files are still uncommitted." },
          },
          {
            hookId: "continue",
            effect: {
              kind: "preventStop",
              reason: "Tests have not been run yet; keep working.",
            },
          },
        ],
        terminatedBy: "continue",
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual(loadFixture("claude", "2.1", "stop-notify-prevent.output.json"));
  });

  it("joins multiple notifications in declaration order", async () => {
    const native = await applyClaude(
      result({
        event: "turn.stop",
        effects: [
          { hookId: "a", effect: { kind: "notify", message: "first" } },
          { hookId: "b", effect: { kind: "notify", message: "second" } },
        ],
      }),
      {},
      INVOCATION,
    );
    expect(native).toEqual({ exitCode: 0, body: { systemMessage: "first\nsecond" } });
  });

  it("encodes blockContinuation approximately via exit 2 stderr", async () => {
    const native = await applyClaude(
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
    expect(native).toEqual(loadFixture("claude", "2.1", "post-tool-block-continuation.output.json"));
  });

  it("encodes prompt.before and compact blocks via exit 2", async () => {
    for (const event of ["prompt.before", "context.compact.before"] as const) {
      const native = await applyClaude(
        result({
          event,
          effects: [{ hookId: "g", effect: { kind: "block", reason: "not allowed" } }],
          terminatedBy: "g",
        }),
        {},
        INVOCATION,
      );
      expect(native).toEqual({ exitCode: 2, stderr: "not allowed" });
    }
  });

  it("encodes permission.request block as hookSpecificOutput.decision.behavior deny (permissionDecision is ignored on that event)", async () => {
    const native = await applyClaude(
      result({
        event: "permission.request",
        effects: [{ hookId: "g", effect: { kind: "block", reason: "nope" } }],
        terminatedBy: "g",
      }),
      {},
      INVOCATION,
    );
    expect(native.exitCode).toBe(0);
    expect(native.body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "nope" },
      },
    });
  });

  it("emits a clean exit 0 with no body when there are no effects", async () => {
    const native = await applyClaude(result({ event: "session.end" }), {}, INVOCATION);
    expect(native).toEqual({ exitCode: 0 });
  });
});
