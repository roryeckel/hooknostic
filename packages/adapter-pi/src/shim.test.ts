import { describe, expect, it, vi } from "vitest";

import type { PluginSpec } from "@hooknostic/sdk";
import { definePlugin, hook, notify } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import type { PiEnrichment, PiNativeEvent } from "./decode.js";
import { piHarness } from "./harness.js";
import { piCapabilityProfiles } from "./profile.js";
import { createHooknosticExtension, type PiExtensionApi } from "./shim.js";

const LEVELS = Object.fromEntries(Object.entries(piCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]));

const INVOCATION = { targetId: "pi", harnessVersion: piHarness.referenceVersion };

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
  ctx: PiNativeEvent["ctx"] = { cwd: "C:/project" },
): Promise<unknown> {
  const handlers = (pi as unknown as { subscriptions: Map<string, unknown[]> }).subscriptions.get(event);
  if (handlers === undefined || handlers.length === 0) throw new Error(`no handler for ${event}`);
  const handler = handlers[handlers.length - 1] as (e: unknown, c: unknown) => Promise<unknown>;
  return handler(payload, ctx);
}

describe("createHooknosticExtension", () => {
  it.each([
    { fixture: "tool-call-bash", portable: "tool.before", native: "tool_call" },
    { fixture: "agent-settled-resumed", portable: "turn.stop", native: "agent_settled" },
  ] as const)("preserves the captured callback context in raw: $fixture", async ({ fixture, portable, native }) => {
    const input = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, `${fixture}.input.json`);
    const pi = fakePi();
    let observedRaw: unknown;
    createHooknosticExtension(
      pluginWith([
        hook(portable, {
          id: "inspect",
          async run(event) {
            observedRaw = event.raw;
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    )(pi);

    await fire(pi, native, input.event, input.ctx);
    expect(input.ctx.mode).toEqual(expect.any(String));
    expect(observedRaw).toEqual(input);
  });

  it("hands hooks an MCP tool only on a target within the 1.x line", async () => {
    const fixture = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, "tool-result-mcp.input.json");
    const { toolSource } = loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, "tool-result-mcp.enrichment.json");
    const seen: unknown[] = [];
    for (const nativeMcp of [undefined, false]) {
      const pi = { ...fakePi(), getAllTools: () => [{ name: "mcp__probe__probe_echo", sourceInfo: toolSource }] };
      createHooknosticExtension(
        pluginWith([
          hook("tool.after", {
            id: "observe",
            async run(event) {
              seen.push({ kind: event.tool.kind, mcp: event.tool.mcp });
            },
          }),
        ]),
        { capabilities: LEVELS, ...INVOCATION, ...(nativeMcp === undefined ? {} : { nativeMcp }) },
      )(pi);
      await fire(pi, "tool_result", fixture.event, fixture.ctx);
    }
    expect(seen).toEqual([
      { kind: "mcp", mcp: { server: "probe", tool: "probe_echo" } },
      { kind: "other", mcp: undefined },
    ]);
  });

  it("takes the MCP split only from a tool pi's MCP extension registered", async () => {
    // tool-result-mcp-shadow: another extension's tool under the native name.
    const fixture = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, "tool-result-mcp-shadow.input.json");
    const source = (name: string) =>
      loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, `${name}.enrichment.json`).toolSource;
    const registered = (sourceInfo: unknown) => () => [
      { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
      { name: "mcp__probe__probe_echo", sourceInfo },
    ];
    const cases: [string, PiExtensionApi["getAllTools"]][] = [
      ["native", registered(source("tool-result-mcp"))],
      ["extension", registered(source("tool-result-mcp-shadow"))],
      ["unregistered", () => []],
      [
        "unreadable",
        () => {
          throw new Error("runtime not bound");
        },
      ],
      ["absent", undefined],
    ];
    const seen: Record<string, unknown> = {};
    for (const [label, getAllTools] of cases) {
      const pi = { ...fakePi(), ...(getAllTools === undefined ? {} : { getAllTools }) };
      createHooknosticExtension(
        pluginWith([
          hook("tool.after", {
            id: "observe",
            async run(event) {
              seen[label] = { kind: event.tool.kind, mcp: event.tool.mcp };
            },
          }),
        ]),
        { capabilities: LEVELS, ...INVOCATION },
      )(pi);
      await fire(pi, "tool_result", fixture.event, fixture.ctx);
    }
    expect(seen).toEqual({
      native: { kind: "mcp", mcp: { server: "shadow", tool: "echo" } },
      extension: { kind: "mcp", mcp: undefined },
      unregistered: { kind: "mcp", mcp: undefined },
      unreadable: { kind: "mcp", mcp: undefined },
      absent: { kind: "mcp", mcp: undefined },
    });
  });

  it("reads tool sources only for MCP-named results on the 1.x line", async () => {
    const bash = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, "tool-result-bash.input.json");
    const mcp = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, "tool-result-mcp.input.json");
    for (const nativeMcp of [undefined, false]) {
      const getAllTools = vi.fn(() => []);
      const pi = { ...fakePi(), getAllTools };
      createHooknosticExtension(pluginWith([hook("tool.after", { id: "observe", async run() {} })]), {
        capabilities: LEVELS,
        ...INVOCATION,
        ...(nativeMcp === undefined ? {} : { nativeMcp }),
      })(pi);
      await fire(pi, "tool_result", bash.event, bash.ctx);
      await fire(pi, "tool_result", mcp.event, mcp.ctx);
      expect(getAllTools).toHaveBeenCalledTimes(nativeMcp === false ? 0 : 1);
    }
  });

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
            return { kind: "block" as const, reason: "no destructive commands" };
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
            return { kind: "replaceInput" as const, input: { command: "pnpm test" } };
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

  it.each([null, "not an argument object", ["not", "an", "object"]])(
    "rejects an input replacement pi cannot apply in place: %j",
    async (replacement) => {
      const pi = fakePi();
      const seen: unknown[] = [];
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        createHooknosticExtension(
          pluginWith([
            hook("tool.before", {
              id: "invalid",
              capabilities: { "tool.before.input.replace": "required" },
              async run() {
                return { kind: "replaceInput" as const, input: replacement };
              },
            }),
            hook("tool.before", {
              id: "observe",
              async run(event) {
                seen.push(structuredClone(event.tool.input));
              },
            }),
          ]),
          { ...INVOCATION, capabilities: LEVELS },
        )(pi);
        const input = { command: "original" };
        const payload = { type: "tool_call", toolName: "bash", toolCallId: "c1", input };
        expect(await fire(pi, "tool_call", payload)).toBeUndefined();
        expect(payload.input).toBe(input);
        expect(input).toEqual({ command: "original" });
        expect(seen).toEqual([{ command: "original" }]);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("HN401"));
      } finally {
        error.mockRestore();
      }
    },
  );

  it("blocks under onHookError: block when pi cannot apply a replacement", async () => {
    const pi = fakePi();
    const input = { command: "original" };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createHooknosticExtension(
        pluginWith([
          hook("tool.before", {
            id: "invalid",
            capabilities: { "tool.before.input.replace": "required" },
            async run() {
              return { kind: "replaceInput" as const, input: null };
            },
          }),
        ]),
        { ...INVOCATION, capabilities: LEVELS, policy: { onHookError: "block" } },
      )(pi);
      expect(await fire(pi, "tool_call", { type: "tool_call", toolName: "bash", input })).toEqual({
        block: true,
        reason: expect.stringContaining("cannot apply"),
      });
      expect(input).toEqual({ command: "original" });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("HN401"));
    } finally {
      error.mockRestore();
    }
  });

  it("applies a captured updateShell rewrite through the same live input object", async () => {
    const pi = fakePi();
    createHooknosticExtension(
      pluginWith([
        hook("tool.before", {
          id: "rewrite",
          capabilities: { "tool.before.input.replace": "required" },
          async run() {
            return { kind: "updateShell" as const, command: "pnpm test" };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    )(pi);
    const input = { command: "npm test", timeout: 10 };
    const payload = { type: "tool_call", toolName: "bash", input };
    expect(await fire(pi, "tool_call", payload)).toBeUndefined();
    expect(payload.input).toBe(input);
    expect(input).toEqual({ command: "pnpm test", timeout: 10 });
  });

  it.each(["replaceInput", "updateShell"] as const)(
    "rejects %s when pi's live input cannot be mutated",
    async (kind) => {
      const pi = fakePi();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        createHooknosticExtension(
          pluginWith([
            hook("tool.before", {
              id: "rewrite",
              capabilities: { "tool.before.input.replace": "required" },
              async run() {
                return kind === "replaceInput"
                  ? { kind: "replaceInput" as const, input: { command: "new" } }
                  : { kind: "updateShell" as const, command: "new" };
              },
            }),
          ]),
          { ...INVOCATION, capabilities: LEVELS },
        )(pi);
        const input = Object.freeze({ command: "original" });
        const payload = { type: "tool_call", toolName: "bash", input };
        expect(await fire(pi, "tool_call", payload)).toBeUndefined();
        expect(payload.input).toBe(input);
        expect(input).toEqual({ command: "original" });
        expect(error).toHaveBeenCalledWith(expect.stringContaining("HN401"));
      } finally {
        error.mockRestore();
      }
    },
  );

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
            return { kind: "replaceOutput" as const, output: "[redacted]" };
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

  it("keeps raw and normalized tool results away from pi's live payload", async () => {
    const pi = fakePi();
    let observed: unknown;
    createHooknosticExtension(
      pluginWith([
        hook("tool.after", {
          id: "inspect",
          async run(event) {
            const raw = event.raw as { event: { input: { command: string }; content: { text: string }[] } };
            raw.event.input.command = "changed through raw";
            raw.event.content[0]!.text = "changed through raw";
            (event.tool.input as { command: string }).command = "changed through tool";
            (event.output as { text: string }[])[0]!.text = "changed through output";
            observed = {
              rawInput: raw.event.input.command,
              rawOutput: raw.event.content[0]!.text,
              toolInput: (event.tool.input as { command: string }).command,
              output: (event.output as { text: string }[])[0]!.text,
            };
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    )(pi);
    const input = { command: "cat .env" };
    const content = [{ type: "text", text: "SECRET=1" }];
    const payload = { type: "tool_result", toolName: "bash", input, content, isError: false };
    expect(await fire(pi, "tool_result", payload)).toBeUndefined();
    expect(observed).toEqual({
      rawInput: "changed through raw",
      rawOutput: "changed through raw",
      toolInput: "changed through tool",
      output: "changed through output",
    });
    expect(input).toEqual({ command: "cat .env" });
    expect(content).toEqual([{ type: "text", text: "SECRET=1" }]);
  });

  it("injects prompt context as a before_agent_start message result", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("prompt.before", {
          id: "c",
          capabilities: { "prompt.before.context.add": "required" },
          async run() {
            return { kind: "addContext" as const, context: "mind the layout" };
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

  it("runs no prompt hook for a captured custom-message run and injects nothing into it", async () => {
    // pi >=1.2 fires before_agent_start for the turn.stop prevent continuation;
    // pi adds a returned message to that run too, so a stray result would
    // inject prompt context into a turn no user prompt started.
    const pi = fakePi();
    const run = vi.fn(async () => ({ kind: "addContext" as const, context: "mind the layout" }));
    createHooknosticExtension(
      pluginWith([hook("prompt.before", { id: "c", capabilities: { "prompt.before.context.add": "required" }, run })]),
      { ...INVOCATION, capabilities: LEVELS },
    )(pi);
    for (const fixture of ["before-agent-start-custom", "before-agent-start-isolated"] as const) {
      const input = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, `${fixture}.input.json`);
      const result = await fire(pi, "before_agent_start", input.event, input.ctx);
      if (fixture === "before-agent-start-custom") {
        expect(result).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ message: { customType: "hooknostic", content: "mind the layout", display: false } });
        expect(run).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("returns merged messages for model-request context", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("model.request.before", {
          id: "c",
          capabilities: { "model.request.before.context.add": "required" },
          async run() {
            return { kind: "addContext" as const, context: "arch: hexagonal" };
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

  it("keeps raw context message mutations away from pi's live messages", async () => {
    const pi = fakePi();
    createHooknosticExtension(
      pluginWith([
        hook("model.request.before", {
          id: "inspect",
          async run(event) {
            const raw = event.raw as { event: { messages: { content: { text: string }[] }[] } };
            raw.event.messages[0]!.content[0]!.text = "changed";
            raw.event.messages.push({ content: [{ text: "injected" }] });
          },
        }),
      ]),
      { ...INVOCATION, capabilities: LEVELS },
    )(pi);
    const messages = [{ role: "user", content: [{ type: "text", text: "original" }] }];
    expect(await fire(pi, "context", { type: "context", messages })).toBeUndefined();
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "original" }] }]);
  });

  it("fails open before dispatch when a live context payload cannot be cloned", async () => {
    const pi = fakePi();
    const run = vi.fn();
    createHooknosticExtension(pluginWith([hook("model.request.before", { id: "observe", run })]), {
      ...INVOCATION,
      capabilities: LEVELS,
    })(pi);
    const messages = [{ role: "user", content: "original" }];
    expect(await fire(pi, "context", { type: "context", messages, uncloneable: () => {} })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(messages).toEqual([{ role: "user", content: "original" }]);
  });

  it("cancels compaction by returning {cancel: true}", async () => {
    const pi = fakePi();
    const extension = createHooknosticExtension(
      pluginWith([
        hook("context.compact.before", {
          id: "g",
          capabilities: { "context.compact.before.block": "required" },
          async run() {
            return { kind: "block" as const, reason: "state would be lost" };
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
            return { kind: "notify" as const, message: "checkpoint saved" };
          },
        }),
        hook("turn.stop", {
          id: "p",
          capabilities: { "turn.stop.prevent": "required" },
          async run() {
            return { kind: "preventStop" as const, reason: "run the tests" };
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

  describe("session.start notify", () => {
    function noticePlugin() {
      return pluginWith([
        hook("session.start", {
          id: "n",
          capabilities: { "session.start.notify": "optional" },
          async run() {
            return [notify("first"), notify("second")];
          },
        }),
      ]);
    }
    const options = {
      ...INVOCATION,
      capabilities: { ...LEVELS, "session.start.notify": "approximate" as const },
      minimumCapabilityLevel: "approximate" as const,
    };
    const start = { type: "session_start", reason: "startup" };

    it("shows notices through ctx.ui at warning level and posts nothing into the session", async () => {
      const pi = fakePi();
      const notifyUi = vi.fn();
      createHooknosticExtension(noticePlugin(), options)(pi);
      await fire(pi, "session_start", start, { cwd: "C:/project", ui: { notify: notifyUi } } as PiNativeEvent["ctx"]);
      expect(notifyUi.mock.calls).toEqual([
        ["first", "warning"],
        ["second", "warning"],
      ]);
      expect(pi.sendMessage).not.toHaveBeenCalled();
    });

    it("is a silent no-op without a UI, and survives a throwing one", async () => {
      const pi = fakePi();
      createHooknosticExtension(noticePlugin(), options)(pi);
      await expect(fire(pi, "session_start", start)).resolves.toBeUndefined();
      const throwing = {
        cwd: "C:/project",
        ui: {
          notify: () => {
            throw new Error("no ui");
          },
        },
      } as PiNativeEvent["ctx"];
      await expect(fire(pi, "session_start", start, throwing)).resolves.toBeUndefined();
    });
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
              return { kind: "notify" as const, message: "user-only notice" };
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
            return { kind: "block" as const, reason: "deliberate" };
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
