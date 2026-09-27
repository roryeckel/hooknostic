import { describe, expect, it, vi } from "vitest";

import type { PluginSpec } from "@hooknostic/sdk";
import { definePlugin, hook } from "@hooknostic/sdk";

import { piCapabilityProfiles } from "./profile.js";
import { createHooknosticExtension, type PiExtensionApi } from "./shim.js";

const LEVELS = Object.fromEntries(Object.entries(piCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]));

const INVOCATION = { targetId: "pi", harnessVersion: "0.84.4" };

function pluginWith(hooks: PluginSpec["hooks"]): PluginSpec {
  return definePlugin({ name: "p", hooks });
}

/** A pi-shaped ExtensionAPI double that records subscriptions. */
function fakePi(): PiExtensionApi & { subscriptions: Map<string, unknown[]> } {
  const subscriptions = new Map<string, unknown[]>();
  return {
    subscriptions,
    on: (event, handler) => {
      const list = subscriptions.get(event) ?? [];
      list.push(handler);
      subscriptions.set(event, list);
    },
    sendMessage: vi.fn(),
  };
}

async function fire(
  pi: ReturnType<typeof fakePi>,
  event: string,
  payload: unknown,
  ctx: { cwd: string } = { cwd: "C:/project" },
): Promise<unknown> {
  const handlers = (pi as unknown as { subscriptions: Map<string, unknown[]> }).subscriptions.get(event);
  if (handlers === undefined || handlers.length === 0) throw new Error(`no handler for ${event}`);
  const handler = handlers[handlers.length - 1] as (e: unknown, c: unknown) => Promise<unknown>;
  return handler(payload, ctx);
}

describe("createHooknosticExtension", () => {
  it("registers only the native events the plugin's hooks require", () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(pluginWith([hook("tool.before", { id: "g", async run() {} })]), {
      ...INVOCATION,
      capabilities: LEVELS,
    });
    extension(pi);
    const subscribed = [...(pi as unknown as { subscriptions: Map<string, unknown[]> }).subscriptions.keys()];
    expect(subscribed).toEqual(["tool_call"]);
  });

  it("registers session_compact and session_compact_failed for context.compact.after", () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([hook("context.compact.after", { id: "g", async run() {} })]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    const subscribed = [...(pi as unknown as { subscriptions: Map<string, unknown[]> }).subscriptions.keys()];
    expect(subscribed.sort()).toEqual(["session_compact", "session_compact_failed"]);
  });

  it("blocks a tool call by returning the native block result", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("tool.before", {
          id: "g",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return { kind: "block", reason: "no destructive commands" };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    const result = (await fire(pi, "tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "c1",
      input: { command: "rm -rf /" },
    })) as Record<string, unknown>;
    expect(result).toEqual({ block: true, reason: "no destructive commands" });
  });

  it("applies input replacement in place, preserving the live event.input identity", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("tool.before", {
          id: "r",
          capabilities: { "tool.before.input.replace": "required" },
          async run() {
            return { kind: "replaceInput", input: { command: "pnpm test" } };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    const liveInput = { command: "npm test", extra: "field" };
    const result = (await fire(pi, "tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "c1",
      input: liveInput,
    })) as Record<string, unknown>;
    // pi executes the live object: the replacement must land on it, and the
    // stale key must be gone (pi performs no re-validation).
    expect(result).toBeUndefined();
    expect(liveInput).toEqual({ command: "pnpm test" });
  });

  it("keeps raw tool input mutations away from pi's live input", async () => {
    const pi = fakePi();
    let observedToolInput: unknown;
    let observedRaw: unknown;
    const extension = createHooknosticExtension(
      pluginWith([
        hook("tool.before", {
          id: "inspect",
          async run(event) {
            const raw = event.raw as {
              event: {
                input: { command: string; nested: { flag: string } };
                extra: { nested: { flag: string } };
              };
            };
            observedRaw = structuredClone(raw);
            raw.event.input.command = "rm -rf /";
            raw.event.input.nested.flag = "changed";
            raw.event.extra.nested.flag = "changed";
            observedToolInput = event.tool.input;
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    const liveInput = { command: "pnpm test", nested: { flag: "original" } };
    const extra = { nested: { flag: "original" } };
    const payload = { type: "tool_call", toolName: "bash", toolCallId: "c1", input: liveInput, extra };
    await fire(pi, "tool_call", payload);
    expect(observedRaw).toEqual({ event: payload, ctx: { cwd: "C:/project" } });
    expect(liveInput).toEqual({ command: "pnpm test", nested: { flag: "original" } });
    expect(extra).toEqual({ nested: { flag: "original" } });
    expect(observedToolInput).toEqual({ command: "pnpm test", nested: { flag: "original" } });
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("replaces tool output through the handler result", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("tool.after", {
          id: "r",
          capabilities: { "tool.after.output.replace": "required" },
          async run() {
            return { kind: "replaceOutput", output: "[redacted]" };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    const result = (await fire(pi, "tool_result", {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "c1",
      input: { command: "cat .env" },
      content: [{ type: "text", text: "SECRET=1" }],
      isError: false,
    })) as Record<string, unknown>;
    expect(result).toEqual({ content: [{ type: "text", text: "[redacted]" }] });
  });

  it("injects prompt context as a before_agent_start message result", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("prompt.before", {
          id: "c",
          capabilities: { "prompt.before.context.add": "required" },
          async run() {
            return { kind: "addContext", context: "mind the layout" };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    const result = (await fire(pi, "before_agent_start", {
      type: "before_agent_start",
      prompt: "go",
      systemPrompt: "base",
    })) as Record<string, unknown>;
    expect(result).toEqual({
      message: { customType: "hooknostic", content: "mind the layout", display: false },
    });
  });

  it("returns merged messages for model-request context", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("model.request.before", {
          id: "c",
          capabilities: { "model.request.before.context.add": "required" },
          async run() {
            return { kind: "addContext", context: "arch: hexagonal" };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const result = (await fire(pi, "context", { type: "context", messages })) as Record<string, unknown>;
    // pi honors the handler's return value on this event (verified by
    // effect): the merged array rides back as {messages}, with the context
    // as a custom AgentMessage -- pi's converter drops system-role entries
    // (observed live on 0.84.4), and the custom shape is the channel the
    // model verifiably sees.
    expect(result).toEqual({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "custom", customType: "hooknostic", content: "arch: hexagonal", display: false },
      ],
    });
    // The handed copy is left untouched (it is a deep copy pi discards).
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("cancels compaction by returning {cancel: true}", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("context.compact.before", {
          id: "g",
          capabilities: { "context.compact.before.block": "required" },
          async run() {
            return { kind: "block", reason: "state would be lost" };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    const result = (await fire(pi, "session_before_compact", {
      type: "session_before_compact",
      reason: "manual",
      preparation: {},
    })) as Record<string, unknown>;
    expect(result).toEqual({ cancel: true });
  });

  it("delivers only preventStop through sendMessage", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("turn.stop", {
          id: "n",
          capabilities: { "turn.stop.notify": "optional" },
          async run() {
            return { kind: "notify", message: "checkpoint saved" };
          },
        }),
        hook("turn.stop", {
          id: "p",
          capabilities: { "turn.stop.prevent": "required" },
          async run() {
            return { kind: "preventStop", reason: "run the tests" };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    await fire(pi, "agent_settled", { type: "agent_settled" });
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "hooknostic", content: "run the tests", display: false },
      { triggerTurn: true },
    );
  });

  it("rejects an optional notify effect instead of posting a hidden model message", async () => {
    const pi = fakePi();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const extension = createHooknosticExtension(
        pluginWith([
          hook("turn.stop", {
            id: "n",
            capabilities: { "turn.stop.notify": "optional" },
            async run() {
              return { kind: "notify", message: "user-only notice" };
            },
          }),
        ]),
        { ...INVOCATION, capabilities: LEVELS },
      );
      extension(pi);
      await fire(pi, "agent_settled", { type: "agent_settled" });
      expect(pi.sendMessage).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("HN401"));
    } finally {
      error.mockRestore();
    }
  });

  it("fails open when the shim itself throws", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("tool.before", {
          id: "g",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return { kind: "block", reason: "deliberate" };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    // A dispatch crash (e.g. malformed native event) must not deny the call.
    const result = await fire(pi, "tool_call", "not the expected envelope shape");
    expect(result).toBeUndefined();
  });

  it("is stateless across invocations (ADR-0002)", async () => {
    // Two sequential tool calls: the second must see the first's effects
    // exactly through its own event, never through residue on the extension.
    const seen: string[] = [];
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("tool.before", {
          id: "g",
          async run(event) {
            seen.push((event.tool as { input: { command: string } }).input.command);
            return undefined;
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    );
    extension(pi);
    await fire(pi, "tool_call", { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "a" } });
    await fire(pi, "tool_call", { type: "tool_call", toolName: "bash", toolCallId: "c2", input: { command: "b" } });
    expect(seen).toEqual(["a", "b"]);
  });
});
