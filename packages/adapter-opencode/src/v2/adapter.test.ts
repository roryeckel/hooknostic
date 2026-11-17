import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeCapabilities, buildPluginIR, resolveTargetAdapter } from "@hooknostic/core";
import {
  addContext,
  block,
  definePlugin,
  hook,
  notify,
  preventStop,
  replaceInput,
  replaceOutput,
} from "@hooknostic/sdk";
import { describeAdapterContract } from "@hooknostic/testkit";

import { opencodeHarness } from "../harness.js";
import { opencodeAdapter } from "../index.js";
import { decodeOpenCodeV2 } from "./decode.js";
import { opencodeV2Harness } from "./harness.js";
import { setupOpenCodeV2 } from "./shim.js";
import { classifyOpenCodeV2Tool } from "./toolmap.js";

const target = { id: "modern", version: opencodeV2Harness.recommendedRange, delivery: "project" as const, output: "." };
const facade = opencodeAdapter();
const adapter = resolveTargetAdapter(facade, target).adapter!;
const fixtures = fileURLToPath(new URL("../../../../fixtures/opencode/2.0/", import.meta.url));
describeAdapterContract(adapter, { fixturesDir: fixtures });

// #236: the shim shares its live instances through globalThis, which outlives
// every test in this file; a test's cleanup hands its sessions to the next.
const instancesRegistry = Symbol.for("hooknostic.opencode.v2.instances/1");
const resetInstances = () => void delete (globalThis as Record<symbol, unknown>)[instancesRegistry];
beforeEach(resetInstances);
afterEach(resetInstances);

describe("OpenCode family selection", () => {
  it("selects complete implementations from named target ranges", () => {
    const detect = vi.fn(async () => ({ installed: true, version: opencodeHarness.referenceVersion }));
    const registered = { ...facade, detect };
    expect(resolveTargetAdapter(registered, target).adapter!.harness).toBe(opencodeV2Harness);
    expect(detect).not.toHaveBeenCalled();
    expect(adapter.harness).toBe(opencodeV2Harness);
    const v1 = resolveTargetAdapter(facade, { ...target, version: opencodeHarness.recommendedRange }).adapter!;
    expect(v1.harness).toBe(opencodeHarness);
    expect(adapter.shellCodec).not.toBe(v1.shellCodec);
    expect(adapter.agentPluginProjector).not.toBe(v1.agentPluginProjector);
    expect(
      resolveTargetAdapter(facade, { ...target, version: opencodeV2Harness.referenceVersion }).adapter!.harness,
    ).toBe(opencodeV2Harness);
  });
  it.each([">=1 <3", ">=3 <4", "2.0.0", "*", "garbage"])("rejects unsupported range %s", (version) => {
    expect(resolveTargetAdapter(facade, { ...target, version })).toMatchObject({
      diagnostics: [{ code: "HN203", severity: "error" }],
    });
  });
  it("analyzes both named targets with their own capabilities", () => {
    const plugin = definePlugin({
      name: "families",
      hooks: [hook("prompt.before", { id: "guard", capabilities: { "prompt.before.block": "required" }, run() {} })],
    });
    const result = analyzeCapabilities(
      buildPluginIR(plugin).ir!,
      {
        entry: "hooks.ts",
        targets: {
          legacy: { adapter: "opencode", version: opencodeHarness.recommendedRange, delivery: "project", output: "v1" },
          modern: {
            adapter: "opencode",
            version: opencodeV2Harness.recommendedRange,
            delivery: "project",
            output: "v2",
          },
        },
      },
      { opencode: facade },
    );
    expect(result.targets.modern?.ok).toBe(true);
    expect(result.targets.legacy?.ok).toBe(false);
  });
});

describe("field acceptance across families (ADR-0027)", () => {
  // tool.error.error.message is exact on v2 and never produced on v1, so an
  // acceptance of it names a real shortfall of the opencode adapter -- in
  // either scope, whichever family the target selects.
  const plugin = buildPluginIR(definePlugin({ name: "p", hooks: [hook("prompt.before", { id: "p", run() {} })] })).ir!;
  const verdict = (accepted: string, scope: "global" | "target") => {
    const accept = [accepted] as `${string}:tool.error.error.message`[];
    const result = analyzeCapabilities(
      plugin,
      {
        entry: "hooks.ts",
        ...(scope === "global" ? { compatibility: { accept } } : {}),
        targets: {
          modern: {
            adapter: "opencode",
            version: opencodeV2Harness.recommendedRange,
            delivery: "project",
            output: "v2",
            ...(scope === "target" ? { compatibility: { accept } } : {}),
          },
        },
      },
      { opencode: facade },
    );
    return result.diagnostics.filter((d) => d.code === "HN501").length === 0;
  };
  it.each([
    ["opencode:tool.error.error.message", true],
    ["opencode:turn.stop.correlation.parentAgentId", true],
    ["opencode:tool.before.correlation.toolCallId", false],
    ["claude:turn.stop.lastMessage", false],
  ])("gives %s the same verdict globally and on the target", (accepted, valid) => {
    expect(verdict(accepted, "global")).toBe(valid);
    expect(verdict(accepted, "target")).toBe(valid);
  });
});

describe("v2 captured boundary", () => {
  it("preserves own __proto__ data and live input identity when replacing tool arguments", async () => {
    const replacement = JSON.parse('{"__proto__":{"injected":"yes"},"command":"echo safe"}');
    let callback: ((event: Record<string, unknown>) => Promise<void>) | undefined;
    const cleanup = await setupOpenCodeV2(
      definePlugin({
        name: "data-keys",
        hooks: [
          hook("tool.before", {
            id: "replace",
            capabilities: { "tool.before.input.replace": "required" },
            run() {
              return replaceInput(replacement);
            },
          }),
        ],
      }),
      { capabilities: { "tool.before.observe": "exact", "tool.before.input.replace": "exact" } },
      {
        location: { directory: "." },
        session: { hook: async () => ({ dispose: async () => {} }) },
        tool: {
          hook: async (_name, fn) => {
            callback = fn;
            return { dispose: async () => {} };
          },
        },
        event: { async *subscribe() {} },
      },
    );
    const input = { command: "old", stale: true };
    const prototype = Object.getPrototypeOf(input);
    const native = { tool: "shell", sessionID: "session", id: "call", input };
    try {
      await callback!(native);
      expect(native.input).toBe(input);
      expect(Object.getPrototypeOf(input)).toBe(prototype);
      expect(Object.getOwnPropertyDescriptor(input, "__proto__")).toEqual({
        value: { injected: "yes" },
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expect(input).not.toHaveProperty("injected");
      expect(input.stale).toBeUndefined();
      expect(input.command).toBe("echo safe");
    } finally {
      await cleanup();
    }
  });

  describe("handler errors", () => {
    // Fail-open is the contract; fail-silent is not. In-process, the report's
    // only channel is console.error, as on v1 and Pi.
    type Callback = (event: Record<string, unknown>) => Promise<void>;
    const setup = async (hooks: Parameters<typeof definePlugin>[0]["hooks"]) => {
      const callbacks: { tool?: Callback; permission?: Callback } = {};
      const registration = { dispose: async () => {} };
      const cleanup = await setupOpenCodeV2(
        definePlugin({ name: "handler-errors", hooks }),
        {
          capabilities: {
            "tool.before.observe": "exact",
            "tool.before.block": "exact",
            "permission.request.observe": "exact",
            "permission.request.block": "exact",
          },
        },
        {
          location: { directory: "." },
          session: { hook: async () => registration },
          tool: {
            hook: async (_name, fn) => {
              callbacks.tool = fn;
              return registration;
            },
          },
          permission: {
            hook: async (_name, fn) => {
              callbacks.permission = fn;
              return registration;
            },
          },
          event: { async *subscribe() {} },
        },
      );
      return { callbacks, cleanup };
    };
    const throwing = (event: "tool.before" | "permission.request") =>
      hook(event, {
        id: "boom",
        run() {
          throw new Error("handler exploded");
        },
      });
    const guard = (event: "tool.before" | "permission.request") =>
      hook(event, {
        id: "guard",
        capabilities: { block: "required" },
        run() {
          return block("blocked by guard");
        },
      });
    // Spy and setup both inside the try, so a setup that rejects cannot leak
    // a mocked console.error into later tests.
    const withErrorSpy = async (
      hooks: Parameters<typeof definePlugin>[0]["hooks"],
      body: (callbacks: { tool?: Callback; permission?: Callback }) => Promise<void>,
    ) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const ready = await setup(hooks);
        cleanup = ready.cleanup;
        await body(ready.callbacks);
        expect(error).toHaveBeenCalledWith(expect.stringContaining("[boom]: handler exploded"));
        // A hook's failure, or the block after it, is never a Hooknostic defect.
        expect(error).not.toHaveBeenCalledWith(expect.stringMatching(/^hooknostic internal/));
      } finally {
        error.mockRestore();
        await cleanup?.();
      }
    };

    it("reports a throwing handler on console.error and lets the call through", async () => {
      const input = { command: "echo hi" };
      await withErrorSpy([throwing("tool.before")], async ({ tool }) => {
        await expect(tool!({ tool: "shell", sessionID: "session", id: "call", input })).resolves.toBeUndefined();
        expect(input).toEqual({ command: "echo hi" });
      });
    });

    it("reports a failed handler even when a later hook blocks", async () => {
      await withErrorSpy([throwing("tool.before"), guard("tool.before")], async ({ tool }) => {
        await expect(
          tool!({ tool: "shell", sessionID: "session", id: "call", input: { command: "echo hi" } }),
        ).rejects.toThrow("blocked by guard");
      });
    });

    it("reports a failed handler on the permission deny path", async () => {
      const raw = JSON.parse(readFileSync(fixtures + "permission-ask.input.json", "utf8"));
      await withErrorSpy([throwing("permission.request"), guard("permission.request")], async ({ permission }) => {
        const native = structuredClone(raw.event);
        await expect(permission!(native)).resolves.toBeUndefined();
        expect(native).toMatchObject({ effect: "deny", message: expect.stringContaining("blocked by guard") });
      });
    });
  });

  describe("internal errors (#180)", () => {
    // Reports gain a stack under HOOKNOSTIC_DEBUG; the lines asserted here have none.
    beforeEach(() => {
      vi.stubEnv("HOOKNOSTIC_DEBUG", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // OpenCode 2.x fails closed on any plugin throw in these domains
    // (.capture/opencode-v2-plugin-throw), so the shim's own defects must not
    // reach it: they are reported and the call proceeds as if no hook ran.
    // Deliberate blocks still throw. Each trigger is a host object the shim
    // cannot apply to, which escaped every callback before the fix.
    type Callback = (event: Record<string, unknown>) => Promise<void>;
    const capabilities = {
      "tool.before.observe": "exact",
      "tool.before.block": "exact",
      "tool.before.input.replace": "exact",
      "tool.after.observe": "exact",
      "tool.after.output.replace": "exact",
      "prompt.before.observe": "exact",
      "prompt.before.block": "exact",
      "model.request.before.observe": "approximate",
      "model.request.before.context.add": "approximate",
      "context.compact.before.observe": "approximate",
      "permission.request.observe": "exact",
      "permission.request.block": "exact",
      "turn.stop.observe": "approximate",
    } as const;
    const fixture = (name: string) =>
      structuredClone(JSON.parse(readFileSync(fixtures + name, "utf8")).event) as Record<string, unknown>;
    const internal = (hook: string) => new RegExp(`^hooknostic internal \\[${hook.replace(".", "\\.")}\\]: `, "m");
    // Spy and setup both inside the try, as for handler errors.
    const withSpy = async (
      hooks: Parameters<typeof definePlugin>[0]["hooks"],
      body: (callbacks: Record<string, Callback>, reports: () => string[]) => Promise<void>,
      options: {
        events?: (options: { signal: AbortSignal }) => AsyncIterable<Record<string, unknown>>;
        console?: () => void;
      } = {},
    ) => {
      const error = vi.spyOn(console, "error").mockImplementation(options.console ?? (() => {}));
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const callbacks: Record<string, Callback> = {};
        const register = (domain: string) => async (name: string, fn: Callback) => {
          callbacks[`${domain}:${name}`] = fn;
          return { dispose: async () => {} };
        };
        cleanup = await setupOpenCodeV2(
          definePlugin({ name: "internal-errors", hooks }),
          { capabilities },
          {
            location: { directory: "." },
            session: { hook: register("session") },
            tool: { hook: register("tool") },
            permission: { hook: register("permission") },
            event: { subscribe: options.events ?? async function* () {} },
          },
        );
        await body(callbacks, () => error.mock.calls.map((call) => String(call[0])));
      } finally {
        error.mockRestore();
        await cleanup?.();
      }
    };
    const rewrite = hook("tool.before", {
      id: "rewrite",
      capabilities: { "tool.before.input.replace": "required" },
      run: () => replaceInput({ command: "echo rewritten" }),
    });
    const frozenCall = () => ({
      tool: "shell",
      sessionID: "session",
      id: "call",
      input: Object.freeze({ command: "echo original" }),
    });
    const guard = (event: "tool.before" | "prompt.before" | "permission.request") =>
      hook(event, { id: "guard", capabilities: { block: "required" }, run: () => block("blocked by guard") });

    it("T1: lets a tool call through when its rewrite cannot be applied, and reports it", async () => {
      await withSpy([rewrite], async (callbacks, reports) => {
        const native = frozenCall();
        await expect(callbacks["tool:execute.before"]!(native)).resolves.toBeUndefined();
        expect(native.input).toEqual({ command: "echo original" });
        expect(reports().filter((line) => internal("execute.before").test(line))).toHaveLength(1);
      });
    });

    it("T2: keeps a ran tool's result when its replacement cannot be applied, and reports it", async () => {
      const replace = hook("tool.after", {
        id: "replace",
        capabilities: { "tool.after.output.replace": "required" },
        run: () => replaceOutput("replaced"),
      });
      await withSpy([replace], async (callbacks, reports) => {
        const native = fixture("tool-after.input.json");
        const result = Object.freeze({ ...(native.result as object) });
        native.result = result;
        await expect(callbacks["tool:execute.after"]!(native)).resolves.toBeUndefined();
        expect(native.result).toBe(result);
        expect(result).not.toHaveProperty("content", "replaced");
        expect(reports().filter((line) => internal("execute.after").test(line))).toHaveLength(1);
      });
    });

    it.each([
      ["prompt", "prompt.input.json"],
      ["context", "context.input.json"],
      ["title", "title.input.json"],
      ["generate", "generate.input.json"],
      ["compaction", "compaction.input.json"],
    ])("T3: guards the whole %s callback, not only its dispatch, against a hostile host object", async (name, file) => {
      const hooks = [
        hook("prompt.before", { id: "prompt", run() {} }),
        hook("model.request.before", { id: "request", run() {} }),
        hook("context.compact.before", { id: "compact", run() {} }),
        // A tool hook makes the context listener read the stated shell too.
        hook("tool.before", { id: "tool", run() {} }),
      ];
      await withSpy(hooks, async (callbacks, reports) => {
        const native = fixture(file);
        Object.defineProperty(native, "sessionID", {
          get() {
            throw new Error("host refused");
          },
        });
        await expect(callbacks[`session:${name}`]!(native)).resolves.toBeUndefined();
        expect(reports().some((line) => internal(name).test(line) && line.includes("host refused"))).toBe(true);
      });
    });

    it("T3b: runs the compaction pass after one that failed internally", async () => {
      const compact = vi.fn();
      const hooks = [
        hook("model.request.before", {
          id: "request",
          capabilities: { "model.request.before.context.add": "required" },
          run: () => addContext("extra"),
        }),
        hook("context.compact.before", { id: "compact", run: compact }),
      ];
      await withSpy(hooks, async (callbacks, reports) => {
        const native = fixture("compaction.input.json");
        // Only the model.request.before pass writes to it.
        native.system = Object.freeze([...(native.system as unknown[])]);
        await expect(callbacks["session:compaction"]!(native)).resolves.toBeUndefined();
        expect(compact).toHaveBeenCalledTimes(1);
        expect(reports().filter((line) => internal("compaction").test(line))).toHaveLength(1);
      });
    });

    it("T4: leaves an ask to the host when a deny cannot be applied, and reports it", async () => {
      await withSpy([guard("permission.request")], async (callbacks, reports) => {
        const native = Object.freeze(fixture("permission-ask.input.json"));
        await expect(callbacks["permission:evaluate"]!(native)).resolves.toBeUndefined();
        expect(native.effect).toBe("ask");
        expect(reports().filter((line) => internal("evaluate").test(line))).toHaveLength(1);
      });
    });

    // A deny half written is a denial: the host reads only `effect`. So a
    // write that throws partway leaves the evaluation as the host made it.
    it.each([
      ["T4b: a message setter that throws", "message"],
      ["T4c: an effect setter that stores the value, then throws", "effect"],
    ] as const)("%s leaves the host's effect in place, and reports it", async (_name, key) => {
      await withSpy([guard("permission.request")], async (callbacks, reports) => {
        const native = fixture("permission-ask.input.json");
        let stored = native[key];
        Object.defineProperty(native, key, {
          get: () => stored,
          set(value) {
            stored = value;
            throw new Error(`host refused ${key}`);
          },
        });
        await expect(callbacks["permission:evaluate"]!(native)).resolves.toBeUndefined();
        expect(native.effect).toBe("ask");
        expect(
          reports().filter((line) => internal("evaluate").test(line) && line.includes(`host refused ${key}`)),
        ).toHaveLength(1);
      });
    });

    it("T5: keeps the subscription alive past an event it cannot read", async () => {
      const created = { type: "session.created", data: { sessionID: "ses_s", location: { directory: "." } } };
      const hostile = { type: "session.execution.succeeded" };
      Object.defineProperty(hostile, "data", {
        get() {
          throw new Error("host refused");
        },
      });
      const good = { type: "session.execution.succeeded", data: { sessionID: "ses_s" } };
      const stops = vi.fn();
      await withSpy(
        [hook("turn.stop", { id: "stop", run: stops })],
        async (_callbacks, reports) => {
          await vi.waitFor(() => expect(stops).toHaveBeenCalledTimes(1));
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(stops).toHaveBeenCalledTimes(1);
          expect(reports().filter((line) => internal("event").test(line))).toHaveLength(1);
        },
        {
          events: async function* () {
            yield* [created, hostile, good];
          },
        },
      );
    });

    it("T5b: reports an event whose dispatch throws, and runs the next one", async () => {
      const created = { type: "session.created", data: { sessionID: "ses_s", location: { directory: "." } } };
      const good = { type: "session.execution.succeeded", data: { sessionID: "ses_s" } };
      // Read only once queued: run looks for the stated shell on the envelope.
      const hostile = { ...good };
      Object.defineProperty(hostile, "sessionID", {
        get() {
          throw new Error("host refused");
        },
      });
      const stops = vi.fn();
      await withSpy(
        [hook("turn.stop", { id: "stop", run: stops })],
        async (_callbacks, reports) => {
          await vi.waitFor(() => expect(stops).toHaveBeenCalledTimes(1));
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(stops).toHaveBeenCalledTimes(1);
          expect(
            reports().filter((line) => internal("event").test(line) && line.includes("host refused")),
          ).toHaveLength(1);
        },
        {
          events: async function* () {
            yield* [created, hostile, good];
          },
        },
      );
    });

    // A revoked proxy makes `instanceof` itself throw, so telling a block
    // apart from an internal error must not.
    const revoked = () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    const throwingRevoked = <T extends object>(target: T, key: string): T =>
      Object.defineProperty(target, key, {
        get() {
          throw revoked();
        },
      });

    it("T9: fails open on a thrown revoked proxy, and reports it", async () => {
      await withSpy([rewrite], async (callbacks, reports) => {
        const native = throwingRevoked(frozenCall(), "sessionID");
        await expect(callbacks["tool:execute.before"]!(native)).resolves.toBeUndefined();
        expect(reports()).toContain("hooknostic internal [execute.before]: uninspectable thrown value");
      });
    });

    it("T9c: reports a revoked proxy the decoder meets as itself, not as the decode check's TypeError", async () => {
      await withSpy([rewrite], async (callbacks, reports) => {
        const native = throwingRevoked(frozenCall(), "id");
        await expect(callbacks["tool:execute.before"]!(native)).resolves.toBeUndefined();
        expect(reports()).toEqual(["hooknostic internal [execute.before]: uninspectable thrown value"]);
      });
    });

    it("T9b: keeps the session's queue running past a thrown revoked proxy", async () => {
      const created = { type: "session.created", data: { sessionID: "ses_s", location: { directory: "." } } };
      const good = { type: "session.execution.succeeded", data: { sessionID: "ses_s" } };
      const hostile = throwingRevoked({ ...good }, "sessionID");
      const stops = vi.fn();
      await withSpy(
        [hook("turn.stop", { id: "stop", run: stops })],
        async (_callbacks, reports) => {
          await vi.waitFor(() => expect(stops).toHaveBeenCalledTimes(1));
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(stops).toHaveBeenCalledTimes(1);
          expect(reports()).toContain("hooknostic internal [event]: uninspectable thrown value");
        },
        {
          events: async function* () {
            yield* [created, hostile, good];
          },
        },
      );
    });

    it("T6: still throws a deliberate block, and does not report it", async () => {
      await withSpy([guard("tool.before"), guard("prompt.before")], async (callbacks, reports) => {
        await expect(callbacks["tool:execute.before"]!(frozenCall())).rejects.toThrow("blocked by guard");
        await expect(callbacks["session:prompt"]!(fixture("prompt.input.json"))).rejects.toThrow("blocked by guard");
        expect(reports().filter((line) => /^hooknostic internal/m.test(line))).toEqual([]);
      });
    });

    it("T7: fails open even when the report itself cannot be written", async () => {
      await withSpy(
        [rewrite],
        async (callbacks) => {
          const native = frozenCall();
          await expect(callbacks["tool:execute.before"]!(native)).resolves.toBeUndefined();
          expect(native.input).toEqual({ command: "echo original" });
        },
        {
          console: () => {
            throw new Error("console is gone");
          },
        },
      );
    });

    it("T8: reports a subscription that fails, but not one ended by cleanup", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const subscribe = async (body: (options: { signal: AbortSignal }) => Promise<void>) => {
        const cleanup = await setupOpenCodeV2(
          definePlugin({ name: "subscription", hooks: [hook("turn.stop", { id: "stop", run() {} })] }),
          { capabilities },
          {
            location: { directory: "." },
            session: { hook: async () => ({ dispose: async () => {} }) },
            tool: { hook: async () => ({ dispose: async () => {} }) },
            event: {
              async *subscribe(options) {
                await body(options);
                yield* [];
              },
            },
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        await cleanup();
        return error.mock.calls.map((call) => String(call[0])).filter((line) => internal("event").test(line));
      };
      try {
        expect(
          await subscribe(async () => {
            throw new Error("stream broke");
          }),
        ).toEqual(["hooknostic internal [event]: stream broke"]);
        error.mockClear();
        expect(
          await subscribe(async ({ signal }) => {
            await new Promise((resolve) => signal.addEventListener("abort", resolve));
            throw new Error("aborted");
          }),
        ).toEqual([]);
      } finally {
        error.mockRestore();
      }
    });
  });

  it("registers error-only hooks and disposes their registration", async () => {
    let callback: ((event: Record<string, unknown>) => Promise<void>) | undefined;
    const dispose = vi.fn(async () => {});
    const run = vi.fn();
    const cleanup = await setupOpenCodeV2(
      definePlugin({ name: "error-only", hooks: [hook("tool.error", { id: "error", run })] }),
      { capabilities: { "tool.error.observe": "approximate" } },
      {
        location: { directory: "." },
        session: { hook: async () => ({ dispose }) },
        tool: {
          hook: async (name, fn) => {
            expect(name).toBe("execute.after");
            callback = fn;
            return { dispose };
          },
        },
        event: { async *subscribe() {} },
      },
    );
    expect(callback).toBeDefined();
    const raw = JSON.parse(readFileSync(fixtures + "tool-read-error.input.json", "utf8"));
    await callback!(raw.event);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tool.error", error: { message: raw.event.error.message } }),
      expect.anything(),
    );
    await cleanup();
    // The tool hook, and the context listener an error hook's tool view needs.
    expect(dispose).toHaveBeenCalledTimes(2);
  });
  it("does not infer MCP ownership from a connected server namespace", () => {
    const catalog = JSON.parse(readFileSync(fixtures + "mcp-identity/tool.registry.json", "utf8")).event;
    const servers = JSON.parse(readFileSync(fixtures + "mcp-identity/mcp.registry.json", "utf8")).event.data;
    expect(servers).toEqual([{ name: "hooknostic", status: { status: "connected" } }]);
    for (const name of ["hooknostic_echo", "custom_echo"]) {
      const tool = catalog.find((tool: { name: string }) => tool.name === name);
      expect(tool).toMatchObject({ id: `hooknostic_${name}`, options: { namespace: "hooknostic", codemode: true } });
      expect(classifyOpenCodeV2Tool(tool.id, {})).toEqual({ kind: "other", nativeName: tool.id, input: {} });
    }
  });
  describe("the stated shell (ADR-0029)", () => {
    // The sentence as 2.0.20 delivered it for each configuration (.capture/shell-dialects).
    const context = (sessionID: string, shell?: string) => ({
      sessionID,
      agent: "build",
      tools:
        shell === undefined
          ? { read: { description: "Read a file." } }
          : { shell: { description: `Execute a shell command. Commands run on Linux using ${shell}. Quote paths.` } },
    });
    async function listening(
      events: readonly ("tool.before" | "tool.after" | "tool.error" | "model.request.before")[],
    ) {
      const seen: unknown[] = [];
      const callbacks: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
      const register = async (name: string, fn: (event: Record<string, unknown>) => Promise<void>) => {
        callbacks[name] = fn;
        return { dispose: async () => {} };
      };
      const cleanup = await setupOpenCodeV2(
        definePlugin({
          name: "dialect",
          hooks: events.map((event) =>
            hook(event, {
              id: event,
              run(received) {
                seen.push("tool" in received ? received.tool.shell?.dialect : received.event);
              },
            }),
          ),
        }),
        { capabilities: Object.fromEntries(events.map((event) => [`${event}.observe`, "exact"])) },
        {
          location: { directory: "." },
          session: { hook: register },
          tool: { hook: register },
          event: { async *subscribe() {} },
        },
      );
      const call = (sessionID: string, tool = "shell") =>
        callbacks["execute.before"]!({ tool, sessionID, id: "call", input: { command: "ls" } });
      return { seen, callbacks, call, cleanup };
    }

    it("reaches the tool events of the session it was stated for", async () => {
      const { seen, callbacks, call, cleanup } = await listening(["tool.before", "tool.after"]);
      await call("one");
      await callbacks["context"]!(context("one", "zsh"));
      await callbacks["context"]!(context("two", "cmd"));
      await call("one");
      await call("two");
      await call("three");
      await callbacks["execute.after"]!({
        tool: "shell",
        sessionID: "one",
        id: "call",
        input: { command: "ls" },
        status: "completed",
        result: { content: [] },
      });
      await cleanup();
      expect(seen).toEqual([undefined, "posix", "cmd", undefined, "posix"]);
    });

    it("is replaced by every request, so an unmapped or missing statement leaves no dialect", async () => {
      const { seen, callbacks, call, cleanup } = await listening(["tool.before"]);
      await callbacks["context"]!(context("one", "pwsh"));
      await call("one");
      // tcsh is a real captured answer; a request offering no shell tool states nothing.
      await callbacks["context"]!(context("one", "tcsh"));
      await call("one");
      await callbacks["context"]!(context("one", "pwsh"));
      await callbacks["context"]!(context("one"));
      await call("one");
      await callbacks["context"]!(context("one", "pwsh"));
      await call("one", "read");
      await cleanup();
      expect(seen).toEqual(["powershell", undefined, undefined, undefined]);
    });

    it("reaches a view that a rewrite creates", async () => {
      // The call arrives with an input that has no shell view, so the decoder
      // has nothing to attach the dialect to; dispatch must still know it when
      // a hook's rewrite produces the first view.
      const seen: unknown[] = [];
      const callbacks: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
      const register = async (name: string, fn: (event: Record<string, unknown>) => Promise<void>) => {
        callbacks[name] = fn;
        return { dispose: async () => {} };
      };
      const cleanup = await setupOpenCodeV2(
        definePlugin({
          name: "late-view",
          hooks: [
            hook("tool.before", {
              id: "fill",
              capabilities: { "tool.before.input.replace": "required" },
              run(event) {
                seen.push(event.tool.shell?.dialect);
                return replaceInput({ command: "ls" });
              },
            }),
            hook("tool.before", {
              id: "read",
              run(event) {
                seen.push(event.tool.shell?.dialect);
              },
            }),
          ],
        }),
        { capabilities: { "tool.before.observe": "exact", "tool.before.input.replace": "exact" } },
        {
          location: { directory: "." },
          session: { hook: register },
          tool: { hook: register },
          event: { async *subscribe() {} },
        },
      );
      await callbacks["context"]!(context("one", "zsh"));
      await callbacks["execute.before"]!({ tool: "shell", sessionID: "one", id: "call", input: { script: "ls" } });
      await cleanup();
      expect(seen).toEqual([undefined, "posix"]);
    });

    it("fails open, and to unknown, when the request's tools cannot be read", async () => {
      // The listener sits in the host's model-request path: throwing there would
      // fail the request over a dialect, and keeping the old one would be stale.
      const { seen, callbacks, call, cleanup } = await listening(["tool.before"]);
      await callbacks["context"]!(context("one", "zsh"));
      const unreadable = {
        sessionID: "one",
        get tools(): unknown {
          throw new Error("live object went away");
        },
      };
      await expect(callbacks["context"]!(unreadable)).resolves.toBeUndefined();
      await call("one");
      await cleanup();
      expect(seen).toEqual([undefined]);
    });

    it("keeps a bounded number of sessions, forgetting the one stated longest ago", async () => {
      const { seen, callbacks, call, cleanup } = await listening(["tool.before"]);
      await callbacks["context"]!(context("first", "zsh"));
      await callbacks["context"]!(context("second", "zsh"));
      for (let index = 0; index < 255; index += 1) await callbacks["context"]!(context(`filler-${index}`, "bash"));
      await call("first");
      await call("second");
      await cleanup();
      expect(seen).toEqual([undefined, "posix"]);
    });

    it("counts a session from its latest statement, so one still making requests is not the one forgotten", async () => {
      // Every model request restates the shell, and that is what makes the
      // bound safe: only a session silent for 256 others' statements loses its
      // dialect, never one in the middle of a turn.
      const { seen, callbacks, call, cleanup } = await listening(["tool.before"]);
      await callbacks["context"]!(context("busy", "zsh"));
      await callbacks["context"]!(context("idle", "zsh"));
      await callbacks["context"]!(context("busy", "zsh"));
      for (let index = 0; index < 255; index += 1) await callbacks["context"]!(context(`filler-${index}`, "bash"));
      await call("busy");
      await call("idle");
      await cleanup();
      expect(seen).toEqual(["posix", undefined]);
    });

    it("listens without dispatching when no hook asked for model requests", async () => {
      const tools = await listening(["tool.error"]);
      expect(Object.keys(tools.callbacks).sort()).toEqual(["context", "execute.after"]);
      await tools.callbacks["context"]!(context("one", "zsh"));
      expect(tools.seen).toEqual([]);
      await tools.cleanup();
      // With a model-request hook the same callback also dispatches, once.
      const both = await listening(["tool.before", "model.request.before"]);
      expect(Object.keys(both.callbacks).sort()).toEqual([
        "compaction",
        "context",
        "execute.before",
        "generate",
        "title",
      ]);
      await both.callbacks["context"]!(context("one", "zsh"));
      await both.call("one");
      expect(both.seen).toEqual(["model.request.before", "posix"]);
      await both.cleanup();
      // And a plugin with neither registers no context listener at all.
      const neither = await listening([]);
      expect(Object.keys(neither.callbacks)).toEqual([]);
      await neither.cleanup();
    });

    it("gives the shell view the stated dialect, and never makes a view to carry one", () => {
      const reported = { shellDialect: "cmd" } as const;
      expect(classifyOpenCodeV2Tool("shell", { command: "dir" }, reported).shell).toEqual({
        command: "dir",
        commandKey: "command",
        cwdKey: "workdir",
        dialect: "cmd",
      });
      expect(classifyOpenCodeV2Tool("shell", { command: 42 }, reported).shell).toBeUndefined();
      for (const name of ["Shell", "read", "execute", "bash"])
        expect(classifyOpenCodeV2Tool(name, { command: "dir" }, reported), name).toEqual(
          classifyOpenCodeV2Tool(name, { command: "dir" }),
        );
    });
  });
  it("keeps unknown and Code Mode tools raw without guessing an MCP identity", () => {
    const input = { code: "return tools.example.echo({})" };
    for (const name of ["execute", "skill", "constructor", "example_echo", "READ"])
      expect(classifyOpenCodeV2Tool(name, input)).toEqual({ kind: "other", nativeName: name, input });
    expect(classifyOpenCodeV2Tool("execute", input).input).toBe(input);
  });
  for (const file of readdirSync(fixtures).filter((name) => name.endsWith(".input.json"))) {
    it(file, () => {
      const raw = JSON.parse(readFileSync(fixtures + file, "utf8"));
      const canonical = JSON.parse(readFileSync(fixtures + file.replace(".input.", ".canonical."), "utf8"));
      // What the shim learned beside the callback, if the case needs any (ADR-0027).
      const enrichment = existsSync(fixtures + file.replace(".input.", ".enrichment."))
        ? JSON.parse(readFileSync(fixtures + file.replace(".input.", ".enrichment."), "utf8"))
        : {};
      const original = structuredClone(raw);
      const decoded = decodeOpenCodeV2(
        raw,
        { targetId: target.id, harnessVersion: opencodeV2Harness.referenceVersion },
        enrichment,
      );
      expect(decoded).toEqual({ ...canonical, raw });
      expect(decoded.raw).toBe(raw);
      expect(decoded.raw).toEqual(original);
    });
  }
  describe("turn.stop posting", () => {
    const bus = (name: string) => JSON.parse(readFileSync(fixtures + name, "utf8")).event as Record<string, unknown>;
    const withSession = (event: Record<string, unknown>, sessionID: string) => ({
      ...event,
      data: { ...(event.data as object), sessionID },
    });
    const succeeded = bus("execution-succeeded.input.json");
    const top = (succeeded.data as { sessionID: string }).sessionID;
    const childCreated = bus("session-created-child.input.json");
    const child = (childCreated.data as { sessionID: string }).sessionID;
    const directory = (childCreated.data as { location: { directory: string } }).location.directory;
    // A top-level creation in the captured location: the child's envelope without its parent.
    const created = (sessionID: string, location = directory) => {
      const { parentID: _parent, ...data } = childCreated.data as Record<string, unknown>;
      return {
        ...childCreated,
        location: { directory: location },
        data: { ...data, sessionID, location: { directory: location } },
      };
    };
    const capabilities = {
      "turn.stop.observe": "approximate",
      "turn.stop.prevent": "approximate",
      "turn.stop.notify": "approximate",
      "session.start.observe": "approximate",
    } as const;
    const context = (
      events: Record<string, unknown>[],
      synthetic: (input: unknown) => unknown,
      prompts: Record<string, (event: Record<string, unknown>) => Promise<void>> = {},
    ) => ({
      location: { directory },
      session: {
        hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void>) => {
          prompts[name] = callback;
          return { dispose: async () => {} };
        },
        synthetic,
      },
      tool: { hook: vi.fn() },
      event: {
        async *subscribe() {
          yield* events;
        },
      },
    });
    const stopping = definePlugin({
      name: "stop",
      hooks: [
        hook("turn.stop", {
          id: "notice",
          capabilities: { "turn.stop.notify": "required" },
          run: () => notify("notice"),
        }),
        hook("turn.stop", {
          id: "prevent",
          capabilities: { "turn.stop.prevent": "required" },
          run: () => preventStop("keep working"),
        }),
      ],
    });

    it("admits notices before the prevention, only after a succeeded top-level execution", async () => {
      const posts: unknown[] = [];
      const cleanup = await setupOpenCodeV2(
        stopping,
        { capabilities },
        context(
          [
            created(top),
            childCreated,
            withSession(succeeded, child),
            withSession(bus("execution-interrupted-user.input.json"), top),
            withSession(bus("execution-failed.input.json"), top),
            succeeded,
          ],
          async (input) => {
            posts.push(input);
          },
        ),
      );
      await vi.waitFor(() => expect(posts).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cleanup();
      expect(posts).toEqual([
        { sessionID: top, text: "notice", resume: false },
        { sessionID: top, text: "keep working", resume: true },
      ]);
    });

    it("still prevents when the notice before it fails to post", async () => {
      const synthetic = vi.fn().mockRejectedValueOnce(new Error("server gone")).mockResolvedValue(undefined);
      const cleanup = await setupOpenCodeV2(stopping, { capabilities }, context([created(top), succeeded], synthetic));
      await vi.waitFor(() => expect(synthetic).toHaveBeenCalledTimes(2));
      await cleanup();
      expect(synthetic).toHaveBeenLastCalledWith({ sessionID: top, text: "keep working", resume: true });
    });

    it("does not hold another session's events behind a running turn.stop hook", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const seen: string[] = [];
      const cleanup = await setupOpenCodeV2(
        definePlugin({
          name: "slow",
          hooks: [
            hook("turn.stop", {
              id: "slow",
              async run(event) {
                seen.push(`stop:${event.session.id}`);
                await gate;
              },
            }),
            hook("session.start", {
              id: "start",
              run(event) {
                seen.push(`start:${event.session.id}`);
              },
            }),
          ],
        }),
        { capabilities },
        context([created(top), succeeded, childCreated], vi.fn()),
      );
      await vi.waitFor(() => expect(seen).toEqual([`start:${top}`, `stop:${top}`, `start:${child}`]));
      release();
      await cleanup();
    });

    it("ignores sessions created in another location, or never seen here", async () => {
      const posts: unknown[] = [];
      const cleanup = await setupOpenCodeV2(
        stopping,
        { capabilities },
        context(
          [
            created("ses_foreign", directory + "-elsewhere"),
            withSession(succeeded, "ses_foreign"),
            withSession(succeeded, "ses_unseen"),
          ],
          async (input) => {
            posts.push(input);
          },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cleanup();
      expect(posts).toEqual([]);
    });

    it("treats a session prompted through this instance as its own", async () => {
      const posts: unknown[] = [];
      const prompts: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const cleanup = await setupOpenCodeV2(
        stopping,
        { capabilities },
        {
          ...context(
            [],
            async (input) => {
              posts.push(input);
            },
            prompts,
          ),
          event: {
            async *subscribe() {
              await gate;
              yield withSession(succeeded, "ses_prompted");
            },
          },
        },
      );
      await prompts["prompt"]!({ sessionID: "ses_prompted", prompt: { text: "hi" } });
      open();
      await vi.waitFor(() => expect(posts).toHaveLength(2));
      await cleanup();
    });
  });
  it("disposes registrations and does not register hooks scoped to another target", async () => {
    const registered: string[] = [],
      disposed: string[] = [];
    const register = async (name: string) => {
      registered.push(name);
      return {
        dispose: async () => {
          disposed.push(name);
        },
      };
    };
    const plugin = definePlugin({
      name: "cleanup",
      hooks: [
        hook("prompt.before", { id: "own", run() {} }),
        hook("tool.before", { id: "other", targets: { exclude: [target.id] }, run() {} }),
      ],
    });
    const cleanup = await setupOpenCodeV2(
      plugin,
      { targetId: target.id, capabilities: { "prompt.before.observe": "exact" } },
      {
        location: { directory: "." },
        session: { hook: register },
        tool: { hook: register },
        event: {
          async *subscribe() {
            yield {};
          },
        },
      },
    );
    expect(registered).toEqual(["prompt"]);
    await cleanup();
    expect(disposed).toEqual(["prompt"]);
  });
});

describe("v2 turn.stop fields (ADR-0027)", () => {
  // One captured 2.0.18 session in capture order (.capture/opencode-v2 observe):
  // the prompt hook, then the subscription's execution, step and text events.
  const sequence = readFileSync(fixtures + "turn-fields/events.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { hook: string; directory: string; event: Record<string, unknown> });
  const prompt = sequence.find((row) => row.hook === "prompt")!.event;

  async function replay(
    rows: typeof sequence,
    fields?: ("lastMessage" | "correlation.turnId")[],
    options: { blockPrompt?: boolean } = {},
  ) {
    const seen: { lastMessage?: string; turnId?: string }[] = [];
    const callbacks: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
    const plugin = definePlugin({
      name: "fields",
      hooks: [
        hook("turn.stop", {
          id: "summarize",
          ...(fields ? { fields } : {}),
          run(event) {
            seen.push({
              ...(event.lastMessage !== undefined ? { lastMessage: event.lastMessage } : {}),
              ...(event.correlation.turnId !== undefined ? { turnId: event.correlation.turnId } : {}),
            });
          },
        }),
        ...(options.blockPrompt
          ? [
              hook("prompt.before", {
                id: "deny",
                capabilities: { block: "required" },
                run: () => block("no"),
              }),
            ]
          : []),
      ],
    });
    const cleanup = await setupOpenCodeV2(
      plugin,
      {
        capabilities: {
          "turn.stop.observe": "approximate",
          "prompt.before.observe": "exact",
          "prompt.before.block": "exact",
        },
      },
      {
        location: { directory: sequence[0]!.directory },
        session: {
          hook: async (name, callback) => {
            callbacks[name] = callback;
            return { dispose: async () => {} };
          },
        },
        tool: { hook: vi.fn() },
        event: {
          async *subscribe() {
            for (const row of rows) {
              if (row.hook === "prompt") await callbacks["prompt"]!(structuredClone(row.event)).catch(() => undefined);
              else yield structuredClone(row.event);
            }
          },
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cleanup();
    return seen;
  }

  it("reports the execution's last message and the prompt that started it", async () => {
    expect(await replay(sequence, ["lastMessage", "correlation.turnId"])).toEqual([
      { lastMessage: "playback complete", turnId: prompt["messageID"] as string },
    ]);
  });

  it("keeps the buffered execution out of event.raw", async () => {
    const raws: unknown[] = [];
    const callbacks: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
    const directory = sequence[0]!.directory;
    const cleanup = await setupOpenCodeV2(
      definePlugin({
        name: "raw",
        hooks: [
          hook("turn.stop", {
            id: "declares",
            fields: ["lastMessage", "correlation.turnId"],
            run: (e) => void raws.push(e.raw),
          }),
          hook("turn.stop", { id: "silent", run: (e) => void raws.push(e.raw) }),
        ],
      }),
      { capabilities: { "turn.stop.observe": "approximate" } },
      {
        location: { directory },
        session: { hook: async (name, callback) => ((callbacks[name] = callback), { dispose: async () => {} }) },
        tool: { hook: vi.fn() },
        event: {
          async *subscribe() {
            for (const row of sequence) {
              if (row.hook === "prompt") await callbacks["prompt"]!(structuredClone(row.event));
              else yield structuredClone(row.event);
            }
          },
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cleanup();
    const completion = sequence.find((row) => row.event["type"] === "session.execution.succeeded")!;
    const received = { hook: "event", directory, event: completion.event };
    expect(raws).toEqual([received, received]);
    expect(JSON.stringify(raws)).not.toContain("playback complete");
  });

  it("never hands a prompt admitted during an execution to a later one", async () => {
    // A prompt steered into (or queued behind) a running execution, then a
    // synthetic continuation, which runs no prompt hook: the continuation must
    // not report the steered prompt's id.
    const started = sequence.find((row) => row.event["type"] === "session.execution.started")!;
    const succeeded = sequence.find((row) => row.event["type"] === "session.execution.succeeded")!;
    const steered = {
      ...sequence.find((row) => row.hook === "prompt")!,
      event: { ...prompt, messageID: "msg_steered" },
    };
    const rows = [...sequence.slice(0, sequence.indexOf(succeeded)), steered, succeeded, started, succeeded];
    expect(await replay(rows, ["correlation.turnId"])).toEqual([{ turnId: prompt["messageID"] as string }, {}]);
  });

  it("buffers nothing no hook declared", async () => {
    expect(await replay(sequence)).toEqual([{}]);
    expect(await replay(sequence, ["correlation.turnId"])).toEqual([{ turnId: prompt["messageID"] as string }]);
  });

  it("never hands a blocked prompt's id to a later execution", async () => {
    // A blocked prompt starts no execution, so whatever execution follows (here
    // the captured one, replayed regardless) was started by something else.
    expect(await replay(sequence, ["lastMessage", "correlation.turnId"], { blockPrompt: true })).toEqual([
      { lastMessage: "playback complete" },
    ]);
  });

  it("decodes only the last assistant message's segments, however the envelope was filled", () => {
    const input = JSON.parse(readFileSync(fixtures + "execution-succeeded-with-turn.input.json", "utf8"));
    const { execution } = JSON.parse(readFileSync(fixtures + "execution-succeeded-with-turn.enrichment.json", "utf8"));
    execution.text.unshift({ assistantMessageID: "msg_earlier", ordinal: 0, text: "an earlier step" });
    expect(decodeOpenCodeV2(input, { targetId: target.id }, { execution })).toMatchObject({
      lastMessage: "playback complete",
    });
    execution.text = [];
    expect(decodeOpenCodeV2(input, { targetId: target.id }, { execution })).not.toHaveProperty("lastMessage");
  });

  it("reports only the last assistant message's text, in ordinal order", async () => {
    const texts = sequence.filter((row) => row.event["type"] === "session.text.ended");
    const at = (row: (typeof sequence)[number], data: Record<string, unknown>) => ({
      ...row,
      event: { ...row.event, data: { ...(row.event["data"] as object), ...data } },
    });
    const earlier = at(texts[0]!, { assistantMessageID: "msg_earlier", text: "thinking out loud" });
    const second = at(texts[0]!, { ordinal: 1, text: "second part" });
    const index = sequence.indexOf(texts[0]!);
    const rows = [...sequence.slice(0, index), earlier, second, ...sequence.slice(index)];
    expect(await replay(rows, ["lastMessage"])).toEqual([{ lastMessage: "playback complete\nsecond part" }]);
  });
});

describe("v2 agent.stop from a child's completion (#231)", () => {
  // Captured `subagent` drives, prompts and session events in capture order
  // (.capture/opencode-v2 promote-audits.mjs subagent-stop): one build running
  // the child in the foreground, one running it in the background.
  type Row = { hook: string; directory: string; event: Record<string, unknown> };
  const data = (row: Row) => (row.event["data"] ?? {}) as Record<string, unknown>;
  const sequences = readdirSync(fixtures + "subagent-stop").map((file) => {
    const rows = readFileSync(fixtures + "subagent-stop/" + file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Row);
    const created = rows.find((row) => row.event["type"] === "session.created" && data(row)["parentID"])!;
    const background = rows.some(
      (row) =>
        row.event["type"] === "session.inbox.enqueued" &&
        JSON.stringify(data(row)["item"]).includes('"source":"subagent"'),
    );
    return {
      file,
      rows,
      background,
      child: data(created)["sessionID"] as string,
      parent: data(created)["parentID"] as string,
      agent: data(created)["agent"] as string,
    };
  });
  const childText = "hooknostic-child-result";
  type Seen = {
    event: string;
    session: string | undefined;
    agentId?: string;
    agentType?: string;
    correlationAgentId?: string;
    parentAgentId?: string;
    lastMessage?: string;
  };
  const record =
    (seen: Seen[]) =>
    (event: {
      event: string;
      session: { id?: string };
      correlation: { agentId?: string; parentAgentId?: string };
      agent?: { id?: string; type?: string };
      lastMessage?: string;
    }) =>
      void seen.push({
        event: event.event,
        session: event.session.id,
        ...(event.agent?.id !== undefined ? { agentId: event.agent.id } : {}),
        ...(event.agent?.type !== undefined ? { agentType: event.agent.type } : {}),
        ...(event.correlation.agentId !== undefined ? { correlationAgentId: event.correlation.agentId } : {}),
        ...(event.correlation.parentAgentId !== undefined ? { parentAgentId: event.correlation.parentAgentId } : {}),
        ...(event.lastMessage !== undefined ? { lastMessage: event.lastMessage } : {}),
      });
  const capabilities = {
    "session.start.observe": "approximate",
    "turn.stop.observe": "approximate",
    "turn.stop.prevent": "approximate",
    "turn.stop.notify": "approximate",
    "agent.stop.observe": "approximate",
    "agent.start.observe": "approximate",
  } as const;

  async function replay(
    rows: Row[],
    hooks: Parameters<typeof definePlugin>[0]["hooks"],
    options: {
      capabilities?: Record<string, string>;
      synthetic?: (input: unknown) => unknown;
      get?: (input: { sessionID: string }) => unknown;
      settleMs?: number;
      onCleanup?: () => void;
    } = {},
  ): Promise<{ cleanupMs: number }> {
    const callbacks: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
    let done = false;
    const cleanup = await setupOpenCodeV2(
      definePlugin({ name: "agent-stop", hooks }),
      { capabilities: (options.capabilities ?? capabilities) as Record<string, "approximate"> },
      {
        location: { directory: rows[0]!.directory },
        session: {
          hook: async (name, callback) => {
            callbacks[name] = callback;
            return { dispose: async () => {} };
          },
          synthetic: options.synthetic ?? (() => undefined),
          ...(options.get ? { get: options.get } : {}),
        },
        tool: { hook: vi.fn() },
        event: {
          async *subscribe() {
            for (const row of rows) {
              if (row.hook === "prompt") await callbacks["prompt"]?.(structuredClone(row.event));
              else yield structuredClone(row.event);
            }
            done = true;
          },
        },
      },
    );
    await vi.waitFor(() => expect(done).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 50));
    options.onCleanup?.();
    const begin = Date.now();
    await cleanup();
    return { cleanupMs: Date.now() - begin };
  }

  it("has a foreground and a background capture", () => {
    expect(sequences.map((sequence) => sequence.background).sort()).toEqual([false, true]);
  });

  describe.each(sequences)("$file", ({ rows, child, parent, agent }) => {
    it("U2: reports the child's turn.stop, then its agent.stop under the parent", async () => {
      const seen: Seen[] = [];
      await replay(rows, [
        hook("session.start", { id: "start", run: record(seen) }),
        hook("turn.stop", { id: "stop", run: record(seen) }),
        hook("agent.stop", { id: "agent", run: record(seen) }),
      ]);
      // The child's own turn.stop names its agent ids, as on Copilot (#232);
      // the parent's names none.
      expect(seen).toEqual([
        { event: "session.start", session: child },
        { event: "turn.stop", session: child, correlationAgentId: child, parentAgentId: parent },
        {
          event: "agent.stop",
          session: parent,
          agentId: child,
          agentType: agent,
          correlationAgentId: child,
          parentAgentId: parent,
        },
        { event: "turn.stop", session: parent },
      ]);
      // An agent.stop hook alone subscribes too.
      const alone: Seen[] = [];
      await replay(rows, [hook("agent.stop", { id: "agent", run: record(alone) })]);
      expect(alone.map(({ event, session, agentId }) => ({ event, session, agentId }))).toEqual([
        { event: "agent.stop", session: parent, agentId: child },
      ]);
    });

    it("U3: reports the child's last message only when an agent.stop hook declares it", async () => {
      const undeclared: Seen[] = [];
      await replay(rows, [hook("agent.stop", { id: "agent", run: record(undeclared) })]);
      expect(undeclared).toEqual([expect.not.objectContaining({ lastMessage: expect.anything() })]);
      const declared: Seen[] = [];
      await replay(rows, [hook("agent.stop", { id: "agent", fields: ["lastMessage"], run: record(declared) })]);
      expect(declared).toEqual([expect.objectContaining({ event: "agent.stop", lastMessage: childText })]);
    });

    it("U4: posts nothing for agent.stop, even with prevention and notices rated", async () => {
      const posts: unknown[] = [];
      const seen: Seen[] = [];
      await replay(
        rows,
        [
          hook("agent.stop", {
            id: "notice",
            capabilities: { "agent.stop.notify": "required" },
            run: () => notify("notice"),
          }),
          hook("agent.stop", {
            id: "prevent",
            capabilities: { "agent.stop.prevent": "required" },
            run(event) {
              record(seen)(event);
              return preventStop("keep working");
            },
          }),
        ],
        {
          capabilities: { ...capabilities, "agent.stop.prevent": "approximate", "agent.stop.notify": "approximate" },
          synthetic: (input) => void posts.push(input),
        },
      );
      expect(seen.map((entry) => entry.event)).toEqual(["agent.stop"]);
      expect(posts).toEqual([]);
    });

    it("U5: keeps the child's own turn.stop, with the same text its agent.stop reports", async () => {
      const seen: Seen[] = [];
      await replay(rows, [
        hook("turn.stop", { id: "stop", fields: ["lastMessage"], run: record(seen) }),
        hook("agent.stop", { id: "agent", fields: ["lastMessage"], run: record(seen) }),
      ]);
      expect(seen.map(({ event, session, lastMessage }) => ({ event, session, lastMessage }))).toEqual([
        { event: "turn.stop", session: child, lastMessage: childText },
        { event: "agent.stop", session: parent, lastMessage: childText },
        { event: "turn.stop", session: parent, lastMessage: expect.any(String) },
      ]);
    });

    it("U6: reports a child that failed before any text, and not one that was interrupted", async () => {
      // Constructed from the captured sequence: the child's text events are
      // dropped and its completion becomes a failure or an interruption.
      const ended = (type: string) =>
        rows
          .filter((row) => !(data(row)["sessionID"] === child && String(row.event["type"]).startsWith("session.text.")))
          .map((row) =>
            data(row)["sessionID"] === child && row.event["type"] === "session.execution.succeeded"
              ? { ...row, event: { ...row.event, type } }
              : row,
          );
      const failed: Seen[] = [];
      await replay(ended("session.execution.failed"), [
        hook("agent.stop", { id: "agent", fields: ["lastMessage"], run: record(failed) }),
      ]);
      expect(failed).toEqual([
        {
          event: "agent.stop",
          session: parent,
          agentId: child,
          agentType: agent,
          correlationAgentId: child,
          parentAgentId: parent,
        },
      ]);
      const interrupted: Seen[] = [];
      await replay(ended("session.execution.interrupted"), [
        hook("turn.stop", { id: "stop", run: record(interrupted) }),
        hook("agent.stop", { id: "agent", run: record(interrupted) }),
      ]);
      expect(interrupted.map(({ event, session }) => ({ event, session }))).toEqual([
        { event: "turn.stop", session: child },
        { event: "turn.stop", session: parent },
      ]);
    });

    const started = {
      event: "agent.start",
      session: parent,
      agentId: child,
      agentType: agent,
      correlationAgentId: child,
      parentAgentId: parent,
    };
    const childStop = { event: "turn.stop", session: child, correlationAgentId: child, parentAgentId: parent };
    const agentStop = {
      event: "agent.stop",
      session: parent,
      agentId: child,
      agentType: agent,
      correlationAgentId: child,
      parentAgentId: parent,
    };
    const everyHook = (seen: Seen[]) => [
      hook("agent.start", { id: "agent-start", run: record(seen) }),
      hook("session.start", { id: "start", run: record(seen) }),
      hook("turn.stop", { id: "stop", run: record(seen) }),
      hook("agent.stop", { id: "agent", run: record(seen) }),
    ];

    it("U7: reports the child's creation as one agent.start under the parent, before its session.start", async () => {
      const seen: Seen[] = [];
      await replay(rows, everyHook(seen));
      expect(seen).toEqual([
        started,
        { event: "session.start", session: child },
        childStop,
        agentStop,
        { event: "turn.stop", session: parent },
      ]);
      // An agent.start hook alone subscribes too.
      const alone: Seen[] = [];
      await replay(rows, [hook("agent.start", { id: "agent-start", run: record(alone) })]);
      expect(alone).toEqual([started]);
    });

    // A child whose session.created never reached this instance, as after a
    // plugin reload, or for a child created through the API before lazy setup:
    // only its prompt, and a session.get lookup, can link it to its parent.
    const unseen = rows.filter((row) => !(row.event["type"] === "session.created" && data(row)["sessionID"] === child));
    const parentPrompt = rows.find((row) => row.hook === "prompt" && row.event["sessionID"] === parent)!;
    // The captured shape of session.get's result for a child (.capture/opencode-v2 README, #232).
    const stored = (sessionID: string, directory = rows[0]!.directory) => ({
      id: sessionID,
      location: { directory },
      ...(sessionID === child ? { parentID: parent, agent, title: "Offline child result capture" } : {}),
    });
    // What a child this instance never saw created dispatches without a link:
    // its own turn.stop, with no agent ids, and no agent.stop. The two
    // sessions' stops are not ordered with each other while a lookup waits.
    const today = [
      { event: "turn.stop", session: child },
      { event: "turn.stop", session: parent },
    ];
    const asToday = (seen: Seen[]) => {
      expect(seen).toHaveLength(today.length);
      expect(seen).toEqual(expect.arrayContaining(today));
    };

    it.each([
      ["already settled", 0],
      ["still pending", 30],
    ])(
      "U8: recovers a child it never saw created from session.get at its prompt, the lookup %s",
      async (_, delayMs) => {
        const calls: string[] = [];
        const seen: Seen[] = [];
        // A second prompt to the parent: each session is looked up once.
        await replay([...unseen, parentPrompt], everyHook(seen), {
          get: async ({ sessionID }) => {
            calls.push(sessionID);
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            return stored(sessionID);
          },
          settleMs: 50 + delayMs,
        });
        // No agent.start and no session.start: the child's creation was not seen.
        // Ordered within each session only: while the lookup is pending, the
        // parent's stop is not held behind the child's.
        expect(seen.filter((entry) => entry.session !== parent || entry.event !== "turn.stop")).toEqual([
          childStop,
          agentStop,
        ]);
        expect(seen.filter((entry) => entry.session === parent && entry.event === "turn.stop")).toEqual([
          { event: "turn.stop", session: parent },
        ]);
        expect(calls.sort()).toEqual([child, parent].sort());
      },
    );

    type Get = (input: { sessionID: string }) => unknown;
    const failing: [string, Get | undefined][] = [
      [
        "throws",
        () => {
          throw new Error("boom");
        },
      ],
      [
        "rejects as not found",
        async () => {
          throw Object.assign(new Error(""), { name: "Session.NotFoundError" });
        },
      ],
      // Rejecting while the child's completion waits for it.
      [
        "rejects after the completion arrived",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw new Error("server gone");
        },
      ],
      ["returns no record", async () => ({})],
      ["is absent", undefined],
    ];
    it.each(failing)("U9: leaves the child as before when session.get %s, and reports nothing", async (_, get) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const seen: Seen[] = [];
        await replay(unseen, everyHook(seen), { ...(get ? { get } : {}), settleMs: 100 });
        asToday(seen);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it("U9: waits at most 2 s for a lookup that never settles, and only in the child's own queue", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const at: { event: string; session: string | undefined; ms: number }[] = [];
        const begin = Date.now();
        const timed = (event: { event: string; session: { id?: string } }) =>
          void at.push({ event: event.event, session: event.session.id, ms: Date.now() - begin });
        await replay(
          unseen,
          [hook("turn.stop", { id: "stop", run: timed }), hook("agent.stop", { id: "agent", run: timed })],
          {
            get: ({ sessionID }) => (sessionID === child ? new Promise(() => undefined) : stored(sessionID)),
            settleMs: 4000,
          },
        );
        // The parent's stop is not held behind the child's lookup.
        expect(at.map(({ event, session }) => ({ event, session }))).toEqual([
          { event: "turn.stop", session: parent },
          { event: "turn.stop", session: child },
        ]);
        expect(at[0]!.ms).toBeLessThan(1000);
        expect(at[1]!.ms).toBeGreaterThanOrEqual(1900);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    }, 10000);

    it("U13: dispatches nothing after cleanup for a completion still waiting on its lookup", async () => {
      // The child's completion is queued behind its pending lookup when the
      // instance is disposed; the lookup settles only afterwards.
      let release!: (value: unknown) => void;
      const late = new Promise((resolve) => (release = resolve));
      let cleaning = false;
      const after: string[] = [];
      const seen = (event: { event: string; session: { id?: string } }) =>
        void (cleaning && after.push(`${event.event}:${event.session.id}`));
      await replay(
        unseen,
        [hook("turn.stop", { id: "stop", run: seen }), hook("agent.stop", { id: "agent", run: seen })],
        {
          get: ({ sessionID }) => (sessionID === child ? late : stored(sessionID)),
          onCleanup: () => (cleaning = true),
        },
      );
      release(stored(child));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(after).toEqual([]);
    });

    it("U15: starts no agent.stop for a recovered child once cleanup began during its turn.stop", async () => {
      // The completion waits on the lookup, which then finds the child; its
      // turn.stop hook is still running when the instance is disposed.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered = false;
      const agentStops: string[] = [];
      await replay(
        unseen,
        [
          hook("turn.stop", {
            id: "stop",
            async run(event) {
              if (event.session.id !== child) return;
              entered = true;
              await gate;
            },
          }),
          hook("agent.stop", { id: "agent", run: (event) => void agentStops.push(event.agent.id ?? "") }),
        ],
        {
          get: async ({ sessionID }) => {
            if (sessionID === child) await new Promise((resolve) => setTimeout(resolve, 30));
            return stored(sessionID);
          },
          settleMs: 150,
          // Cleanup aborts first; the hook returns only after that.
          onCleanup: () => void setTimeout(release, 20),
        },
      );
      expect(entered).toBe(true);
      expect(agentStops).toEqual([]);
    });

    it("U14: disposes promptly, without waiting for a lookup that never settles", async () => {
      const { cleanupMs } = await replay(unseen, everyHook([]), {
        get: ({ sessionID }) => (sessionID === child ? new Promise(() => undefined) : stored(sessionID)),
      });
      // The lookup's bound is 2 s; cleanup must not wait on it.
      expect(cleanupMs).toBeLessThan(500);
    });

    it("U10: does not link a child whose stored record is in another location", async () => {
      const seen: Seen[] = [];
      await replay(unseen, everyHook(seen), {
        get: async ({ sessionID }) => stored(sessionID, rows[0]!.directory + "-elsewhere"),
      });
      asToday(seen);
    });

    it("U11: posts no stop prevention or notice for a recovered child", async () => {
      const posts: { sessionID: string }[] = [];
      const seen: Seen[] = [];
      await replay(
        unseen,
        [
          hook("turn.stop", {
            id: "notice",
            capabilities: { "turn.stop.notify": "required" },
            run: () => notify("notice"),
          }),
          hook("turn.stop", {
            id: "prevent",
            capabilities: { "turn.stop.prevent": "required" },
            run(event) {
              record(seen)(event);
              return preventStop("keep working");
            },
          }),
        ],
        {
          synthetic: (input) => void posts.push(input as { sessionID: string }),
          get: async ({ sessionID }) => stored(sessionID),
        },
      );
      expect(seen).toEqual([childStop, { event: "turn.stop", session: parent }]);
      expect(posts.map((post) => post.sessionID)).toEqual([parent, parent]);
    });

    it("U12: never looks up a session whose prompt this instance did not see", async () => {
      // A child prompted through another instance, such as a background child
      // still running across a reload: only its events reach this one.
      const calls: string[] = [];
      const seen: Seen[] = [];
      await replay(
        unseen.filter((row) => !(row.hook === "prompt" && row.event["sessionID"] === child)),
        everyHook(seen),
        {
          get: async ({ sessionID }) => {
            calls.push(sessionID);
            return stored(sessionID);
          },
        },
      );
      expect(seen).toEqual([{ event: "turn.stop", session: parent }]);
      expect(calls).toEqual([parent]);
    });
  });
});

describe("v2 reloaded plugin instances (#236)", () => {
  // The captured background subagent drive (2.3.0), cut where a reload left
  // two instances: OpenCode keeps the old one until its running execution
  // ends (2.2.6, 2.3.0) or for good (2.0.17), and both hear every event.
  type Row = { hook: string; directory: string; event: Record<string, unknown> };
  const rows = readFileSync(fixtures + "subagent-stop/events-2.3.0.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
  const data = (row: Row) => (row.event["data"] ?? {}) as Record<string, unknown>;
  const directory = rows[0]!.directory;
  const created = rows.find((row) => row.event["type"] === "session.created" && data(row)["parentID"])!;
  const child = data(created)["sessionID"] as string;
  const parent = data(created)["parentID"] as string;
  const completion = (sessionID: string) =>
    rows.findIndex(
      (row) => row.event["type"] === "session.execution.succeeded" && data(row)["sessionID"] === sessionID,
    );
  const prompt = (sessionID: string) =>
    rows.find((row) => row.hook === "prompt" && row.event["sessionID"] === sessionID);
  const capabilities = {
    "session.start.observe": "approximate",
    "turn.stop.observe": "approximate",
    "turn.stop.prevent": "approximate",
    "agent.stop.observe": "approximate",
  } as const;
  type Seen = {
    by: string;
    event: string;
    session?: string;
    agentId?: string;
    agentType?: string;
    lastMessage?: string;
    turnId?: string;
  };

  /** One plugin instance with its own subscription, fed by `publish`. */
  async function instance(
    by: string,
    seen: Seen[],
    options: {
      name?: string;
      directory?: string;
      posts?: unknown[];
      /** Extra observe-only hooks: agent.start, session.start, context.compact.after. */
      extra?: ("agent.start" | "session.start" | "context.compact.after")[];
      get?: (input: { sessionID: string }) => unknown;
      /** The turn.stop hook waits for `until` on this session's stops: a busy queue. */
      block?: { session: string; until: Promise<void> };
      /** The host's subscription throws, or ends, at once. */
      subscription?: "throws" | "ends";
      /** The plugin root a package-delivered bundle resolves (`ctx.plugin.root`). */
      pluginRoot?: string;
      /** Also record the agent type. */
      types?: boolean;
      /** One buffered event the host still yields after the abort. */
      afterAbort?: Record<string, unknown>;
    } = {},
  ) {
    const queue: Record<string, unknown>[] = [];
    let wake: (() => void) | undefined;
    const callbacks: Record<string, (event: Record<string, unknown>) => Promise<void>> = {};
    const note = (event: {
      event: string;
      session: { id?: string };
      agent?: { id?: string; type?: string };
      lastMessage?: string;
      correlation: { turnId?: string };
    }) =>
      void seen.push({
        by,
        event: event.event,
        ...(event.session.id !== undefined ? { session: event.session.id } : {}),
        ...(event.agent?.id !== undefined ? { agentId: event.agent.id } : {}),
        ...(event.lastMessage !== undefined ? { lastMessage: event.lastMessage } : {}),
        ...(event.correlation.turnId !== undefined ? { turnId: event.correlation.turnId } : {}),
        ...(options.types && event.agent?.type !== undefined ? { agentType: event.agent.type } : {}),
      });
    const cleanup = await setupOpenCodeV2(
      definePlugin({
        name: options.name ?? "reloaded",
        hooks: [
          options.posts
            ? hook("turn.stop", {
                id: "stop",
                fields: ["lastMessage", "correlation.turnId"],
                capabilities: { "turn.stop.prevent": "required" },
                run(event) {
                  note(event);
                  return preventStop("keep working");
                },
              })
            : hook("turn.stop", {
                id: "stop",
                fields: ["lastMessage", "correlation.turnId"],
                async run(event) {
                  if (options.block !== undefined && event.session.id === options.block.session)
                    await options.block.until;
                  note(event);
                },
              }),
          hook("agent.stop", { id: "agent", fields: ["lastMessage"], run: note }),
          ...(options.extra ?? []).map((name) => hook(name, { id: name, run: note })),
        ],
      }),
      {
        capabilities: {
          ...capabilities,
          "agent.start.observe": "approximate",
          "session.start.observe": "approximate",
          "context.compact.after.observe": "approximate",
        },
        ...(options.pluginRoot !== undefined ? { pluginRoot: options.pluginRoot } : {}),
      },
      {
        location: { directory: options.directory ?? directory },
        session: {
          hook: async (name, callback) => {
            callbacks[name] = callback;
            return { dispose: async () => {} };
          },
          synthetic: (input) => void options.posts?.push(input),
          ...(options.get ? { get: options.get } : {}),
        },
        tool: { hook: vi.fn() },
        event: {
          async *subscribe({ signal }) {
            if (options.subscription === "throws") throw new Error("hooknostic-subscription-lost");
            if (options.subscription === "ends") return;
            while (!signal.aborted) {
              const next = queue.shift();
              if (next !== undefined) yield next;
              else await new Promise<void>((resolve) => (wake = resolve));
            }
            if (options.afterAbort !== undefined) yield structuredClone(options.afterAbort);
          },
        },
      },
    );
    const publish = (event: Record<string, unknown>) => {
      queue.push(structuredClone(event));
      wake?.();
    };
    return {
      publish,
      prompt: (row: Row | undefined) => callbacks["prompt"]?.(structuredClone(row!.event)),
      /** Replays rows: prompts through this instance, events to every instance in `to`. */
      async feed(
        from: number,
        until: number,
        to: { publish: typeof publish }[] = [{ publish }],
        except: (row: Row) => boolean = () => false,
      ) {
        for (const row of rows.slice(from, until).filter((row) => !except(row))) {
          if (row.hook === "prompt") await callbacks["prompt"]?.(structuredClone(row.event));
          else for (const target of to) target.publish(row.event);
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      cleanup: async () => {
        const done = cleanup();
        wake?.();
        await done;
      },
    };
  }

  it("R1: the instance after a reload reports a child still running when the old one is disposed", async () => {
    // 3b on 2.3.0: the old instance is disposed before the child's completion reaches anyone.
    const seen: Seen[] = [];
    const old = await instance("old", seen);
    await old.feed(0, completion(child));
    const next = await instance("new", seen);
    await old.cleanup();
    await next.feed(completion(child), rows.length);
    await next.cleanup();
    expect(
      seen
        .filter((entry) => entry.by === "new")
        .map(({ by, event, session, agentId, lastMessage }) => ({ by, event, session, agentId, lastMessage })),
    ).toEqual([
      { by: "new", event: "turn.stop", session: child, lastMessage: "hooknostic-child-result" },
      { by: "new", event: "agent.stop", session: parent, agentId: child, lastMessage: "hooknostic-child-result" },
      { by: "new", event: "turn.stop", session: parent, lastMessage: expect.any(String) },
    ]);
  });

  it("R2: two live instances report each completion once, from the newest that knows the session", async () => {
    // The 2.0.17 leak: the old instance lives on, and the follow-up prompts reach only the new one.
    const seen: Seen[] = [];
    const posts: unknown[] = [];
    const old = await instance("old", seen, { posts });
    await old.feed(0, rows.indexOf(created) + 1);
    const next = await instance("new", seen, { posts });
    await next.prompt(prompt(parent));
    await next.prompt(prompt(child));
    // Old first, as OpenCode delivered them in every capture.
    await old.feed(rows.indexOf(created) + 1, rows.length, [old, next]);
    await old.cleanup();
    await next.cleanup();
    expect(seen.map(({ by, event, session, agentId }) => ({ by, event, session, agentId }))).toEqual([
      { by: "new", event: "turn.stop", session: child },
      { by: "new", event: "agent.stop", session: parent, agentId: child },
      { by: "new", event: "turn.stop", session: parent },
    ]);
    // One prevention, on the parent: never two, never one on the child.
    expect(posts).toEqual([{ sessionID: parent, text: "keep working", resume: true }]);
  });

  it("R3: an instance alone claims nothing, and dispatches a repeated event as before", async () => {
    // Alone and with no claim written earlier by an instance that had company
    // (R8 pins that one): nothing reads differently from before #236.
    const seen: Seen[] = [];
    const only = await instance("only", seen);
    await only.feed(0, rows.length);
    only.publish(rows[completion(parent)]!.event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await only.cleanup();
    expect(seen.filter((entry) => entry.event === "turn.stop" && entry.session === parent)).toHaveLength(2);
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  it("R4: instances of another plugin, or in another location, each report as before", async () => {
    const seen: Seen[] = [];
    const first = await instance("first", seen);
    const other = await instance("other-plugin", seen, { name: "another" });
    const elsewhere = await instance("elsewhere", seen, { directory: directory + "-elsewhere" });
    // Two package-delivered copies of the same plugin, in the same location,
    // that differ only in the plugin root they resolve.
    const rootA = await instance("root-a", seen, { pluginRoot: "/plugins/a/package" });
    const rootB = await instance("root-b", seen, { pluginRoot: "/plugins/b/package" });
    const all = [first, other, elsewhere, rootA, rootB];
    // Constructed: the parent prompted through every instance, so each knows it.
    for (const each of all) await each.prompt(prompt(parent));
    for (const each of all) each.publish(rows[completion(parent)]!.event);
    await settle();
    for (const each of all) await each.cleanup();
    expect(seen.map((entry) => entry.by).sort()).toEqual(["elsewhere", "first", "other-plugin", "root-a", "root-b"]);
  });

  it("R5: a child created while two instances live starts once, from the newest", async () => {
    const seen: Seen[] = [];
    const extra = ["agent.start", "session.start"] as const;
    const old = await instance("old", seen, { extra: [...extra] });
    const next = await instance("new", seen, { extra: [...extra] });
    // Prompts reach the old instance only; every event reaches both.
    await old.feed(0, rows.length, [old, next]);
    for (const each of [old, next]) await each.cleanup();
    expect(seen.filter((entry) => entry.event === "agent.start" || entry.event === "session.start")).toEqual([
      { by: "new", event: "agent.start", session: parent, agentId: child },
      { by: "new", event: "session.start", session: child },
    ]);
    // Each completion once: the child's from the newest that knows it, the parent's from the only one.
    expect(
      seen.filter((entry) => entry.event.endsWith(".stop")).map(({ by, event, session }) => ({ by, event, session })),
    ).toEqual([
      { by: "new", event: "turn.stop", session: child },
      { by: "new", event: "agent.stop", session: parent },
      { by: "old", event: "turn.stop", session: parent },
    ]);
  });

  it("R6: a compaction while two instances live is reported once", async () => {
    const compacted = JSON.parse(readFileSync(fixtures + "compaction-ended.input.json", "utf8")) as Row;
    const session = data(compacted)["sessionID"] as string;
    const seen: Seen[] = [];
    const old = await instance("old", seen, { extra: ["context.compact.after"], directory: compacted.directory });
    const next = await instance("new", seen, { extra: ["context.compact.after"], directory: compacted.directory });
    for (const each of [old, next]) await each.prompt({ hook: "prompt", directory: "", event: { sessionID: session } });
    for (const each of [old, next]) each.publish(compacted.event);
    await settle();
    for (const each of [old, next]) await each.cleanup();
    expect(seen).toEqual([{ by: "new", event: "context.compact.after", session }]);
  });

  it("R7: a handed-over child prompted after the reload needs no lookup and keeps its running text", async () => {
    // 3a beside the handover: the old instance went while the child ran, then
    // the child's prompt reached the new one before its completion did.
    const seen: Seen[] = [];
    const lookups: string[] = [];
    const get = ({ sessionID }: { sessionID: string }) => {
      lookups.push(sessionID);
      return { parentID: parent, agent: "general", location: { directory } };
    };
    const old = await instance("old", seen);
    await old.feed(0, completion(child));
    const next = await instance("new", seen, { get });
    await old.cleanup();
    await next.prompt(prompt(child));
    await next.feed(completion(child), rows.length);
    await next.cleanup();
    expect(lookups).toEqual([]);
    expect(
      seen.map(({ by, event, session, agentId, lastMessage }) => ({ by, event, session, agentId, lastMessage })),
    ).toEqual([
      { by: "new", event: "turn.stop", session: child, lastMessage: "hooknostic-child-result" },
      { by: "new", event: "agent.stop", session: parent, agentId: child, lastMessage: "hooknostic-child-result" },
      { by: "new", event: "turn.stop", session: parent, lastMessage: expect.any(String) },
    ]);
  });

  it("R8: a completion the old instance reported stays reported after it hands the child on", async () => {
    // 2.2.6: the old instance reports the child's completion, then goes; the
    // new one reads the same event later, after the handover taught it the child.
    const seen: Seen[] = [];
    const old = await instance("old", seen);
    await old.feed(0, rows.indexOf(created) + 1);
    const next = await instance("new", seen);
    await old.feed(rows.indexOf(created) + 1, completion(child) + 1, [old, next]);
    await old.cleanup();
    next.publish(rows[completion(child)]!.event);
    await settle();
    await next.cleanup();
    expect(
      seen
        .filter((entry) => entry.session === child || entry.agentId === child)
        .map(({ by, event }) => ({ by, event })),
    ).toEqual([
      { by: "old", event: "turn.stop" },
      { by: "old", event: "agent.stop" },
    ]);
  });

  it("R9: the claims and the handover are bounded, keeping the newest and every running execution", async () => {
    type Group = { claimed: Set<string>; inherited: Map<string, unknown>; live: Set<unknown> };
    const groups = () => [...((globalThis as Record<symbol, Map<string, Group>>)[instancesRegistry]?.values() ?? [])];
    const seen: Seen[] = [];
    const old = await instance("old", seen);
    const next = await instance("new", seen);
    await next.prompt(prompt(parent));
    const compactions = Array.from({ length: 1030 }, (_, index) => ({
      id: `evt_bound_${index}`,
      type: "session.compaction.ended",
      data: { sessionID: parent },
    }));
    for (const event of compactions) next.publish(event);
    await settle();
    const [group] = groups();
    expect(group!.claimed.size).toBe(1024);
    expect(group!.claimed.has("evt_bound_5")).toBe(false);
    expect(group!.claimed.has("evt_bound_6")).toBe(true);
    // 300 sessions, the first of them still running when the instance goes.
    for (let index = 0; index < 300; index++)
      await old.prompt({ hook: "prompt", directory, event: { sessionID: `ses_bound_${index}` } });
    old.publish({ id: "evt_running", type: "session.execution.started", data: { sessionID: "ses_bound_0" } });
    await settle();
    await old.cleanup();
    expect(group!.inherited.size).toBe(256);
    expect(group!.inherited.has("ses_bound_0")).toBe(true);
    expect(group!.inherited.has("ses_bound_299")).toBe(true);
    expect(group!.inherited.has("ses_bound_44")).toBe(false);
    expect(group!.inherited.has("ses_bound_45")).toBe(true);
    await next.cleanup();
  });

  it("R10: an instance set up after every other has gone still takes over their running child", async () => {
    // 2.3.0, once in 19 runs: the old instance was disposed before the new one was set up.
    const seen: Seen[] = [];
    const old = await instance("old", seen);
    await old.feed(0, completion(child));
    await old.cleanup();
    const next = await instance("new", seen);
    await next.feed(completion(child), rows.length);
    await next.cleanup();
    expect(seen.filter((entry) => entry.by === "new").map(({ event, session }) => ({ event, session }))).toEqual([
      { event: "turn.stop", session: child },
      { event: "agent.stop", session: parent },
      { event: "turn.stop", session: parent },
    ]);
  });

  it("R11: an event without an id is still reported once, by the newest that knows it", async () => {
    const seen: Seen[] = [];
    const old = await instance("old", seen);
    const next = await instance("new", seen);
    for (const each of [old, next]) await each.prompt(prompt(parent));
    const { id: _id, ...anonymous } = rows[completion(parent)]!.event;
    for (const each of [old, next]) each.publish(anonymous);
    await settle();
    for (const each of [old, next]) await each.cleanup();
    expect(seen.map(({ by, event }) => ({ by, event }))).toEqual([{ by: "new", event: "turn.stop" }]);
  });

  /** The one group's handed-over sessions, read from the shared registry. */
  const handedOver = () =>
    [
      ...((globalThis as Record<symbol, Map<string, { inherited: Map<string, unknown> }>>)[
        instancesRegistry
      ]?.values() ?? []),
    ][0]?.inherited;
  /** A completion of the parent's, constructed with its own event id. */
  const stopped = (id: string) => ({ id, type: "session.execution.succeeded", data: { sessionID: parent } });
  /** A hook that waits until released: a busy queue. */
  const gate = () => {
    let release!: () => void;
    const until = new Promise<void>((resolve) => (release = resolve));
    return { until, release };
  };

  it("R9b: a later handover of idle sessions evicts them before an earlier one's running execution", async () => {
    const seen: Seen[] = [];
    const running = await instance("running", seen);
    await running.prompt({ hook: "prompt", directory, event: { sessionID: "ses_still_running" } });
    running.publish({ id: "evt_started", type: "session.execution.started", data: { sessionID: "ses_still_running" } });
    await settle();
    await running.cleanup();
    const idle = await instance("idle", seen);
    for (let index = 0; index < 256; index++)
      await idle.prompt({ hook: "prompt", directory, event: { sessionID: `ses_idle_${index}` } });
    await idle.cleanup();
    expect(handedOver()!.size).toBe(256);
    expect(handedOver()!.has("ses_still_running")).toBe(true);
    expect(handedOver()!.has("ses_idle_0")).toBe(false);
  });

  for (const subscription of ["throws", "ends"] as const)
    it(`R12: a newer instance whose subscription ${subscription === "throws" ? "threw" : "ended"} does not silence an older one`, async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const seen: Seen[] = [];
      const old = await instance("old", seen);
      const next = await instance("new", seen, { subscription });
      // Both took the parent's prompt, so the newer one knows the session.
      for (const each of [old, next]) await each.prompt(prompt(parent));
      await settle();
      old.publish(rows[completion(parent)]!.event);
      await settle();
      for (const each of [old, next]) await each.cleanup();
      errors.mockRestore();
      expect(seen.map(({ by, event, session }) => ({ by, event, session }))).toEqual([
        { by: "old", event: "turn.stop", session: parent },
      ]);
    });

  it("R13: a child handed over without its link is still looked up at its next prompt", async () => {
    // The old instance never saw the child created and had no session.get, so
    // it handed the child on as a plain session; the new one's subscription
    // adopts it before the child's prompt arrives.
    const seen: Seen[] = [];
    const lookups: string[] = [];
    const get = ({ sessionID }: { sessionID: string }) => {
      lookups.push(sessionID);
      return { parentID: parent, agent: "general", location: { directory } };
    };
    const old = await instance("old", seen);
    await old.feed(0, completion(child), undefined, (row) => row === created);
    const next = await instance("new", seen, { get });
    await old.cleanup();
    next.publish({ id: "evt_status", type: "session.status", data: { sessionID: child } });
    await settle();
    await next.prompt(prompt(child));
    await next.feed(completion(child), rows.length);
    await next.cleanup();
    expect(lookups).toEqual([child]);
    expect(seen.filter((entry) => entry.event === "agent.stop").map(({ by, agentId }) => ({ by, agentId }))).toEqual([
      { by: "new", agentId: child },
    ]);
  });

  it("Q3: a child prompted at the new instance before it adopts the handover still gets the handed-over text", async () => {
    // 2.3.0: the old instance is disposed while the child still runs, and the
    // prompt reaches the new instance before any of the child's events does:
    // steered into that execution, which only the handover carries. (A prompt
    // while the old instance still lives takes its execution over at once:
    // Q5.) The prompt is its own message, so its id differs from the child's
    // first prompt's.
    const seen: Seen[] = [];
    const old = await instance("old", seen);
    await old.feed(0, completion(child));
    const next = await instance("new", seen);
    await old.cleanup();
    await next.prompt({ hook: "prompt", directory, event: { sessionID: child, messageID: "msg_steered" } });
    await next.feed(completion(child), completion(child) + 1);
    // A later execution of the child that no prompt started: the steered
    // prompt's id must not land on it.
    next.publish({ id: "evt_again", type: "session.execution.started", data: { sessionID: child } });
    next.publish({ id: "evt_again_done", type: "session.execution.succeeded", data: { sessionID: child } });
    await settle();
    await next.cleanup();
    expect(
      seen
        .filter((entry) => entry.event === "turn.stop" && entry.session === child)
        .map(({ by, lastMessage, turnId }) => ({ by, lastMessage, turnId })),
    ).toEqual([
      { by: "new", lastMessage: "hooknostic-child-result", turnId: prompt(child)!.event["messageID"] },
      { by: "new", lastMessage: undefined, turnId: undefined },
    ]);
  });

  it("Q4: with three instances, only the newest takes over what the middle one handed on", async () => {
    const seen: Seen[] = [];
    const oldest = await instance("oldest", seen);
    const middle = await instance("middle", seen);
    await middle.feed(0, completion(child));
    const latest = await instance("latest", seen);
    await middle.cleanup();
    // The oldest hears each event first, as OpenCode delivered them.
    await latest.feed(completion(child), rows.length, [oldest, latest]);
    expect(handedOver()!.has(child)).toBe(false);
    for (const each of [oldest, latest]) await each.cleanup();
    expect(
      seen
        .filter((entry) => entry.session === child || entry.agentId === child)
        .map(({ by, event }) => ({ by, event })),
    ).toEqual([
      { by: "latest", event: "turn.stop" },
      { by: "latest", event: "agent.stop" },
    ]);
  });

  it("R15: a successor reading a completion while the old instance drains a busy queue finds it handed over", async () => {
    const busy = gate();
    const seen: Seen[] = [];
    const old = await instance("old", seen, { block: { session: parent, until: busy.until } });
    await old.feed(0, completion(child));
    // A stop of the parent's is still running in the old instance.
    old.publish(stopped("evt_busy"));
    await settle();
    const next = await instance("new", seen);
    const closing = old.cleanup();
    await next.feed(completion(child), completion(child) + 1);
    busy.release();
    await closing;
    await next.cleanup();
    expect(seen.filter((entry) => entry.by === "new").map(({ event, session }) => ({ event, session }))).toEqual([
      { event: "turn.stop", session: child },
      { event: "agent.stop", session: parent },
    ]);
  });

  it("R16: an event the host still yields after the abort is not read", async () => {
    // Read, it would let the disposed instance take back its own handover:
    // no newer instance is live yet (2.3.0, once in the captures).
    const seen: Seen[] = [];
    const old = await instance("old", seen, {
      afterAbort: { id: "evt_late", type: "session.status", data: { sessionID: child } },
    });
    await old.feed(0, completion(child));
    await old.cleanup();
    const next = await instance("new", seen);
    await next.feed(completion(child), completion(child) + 1);
    await next.cleanup();
    expect(seen.filter((entry) => entry.by === "new").map(({ event }) => event)).toEqual(["turn.stop", "agent.stop"]);
  });

  // An accepted, documented limit (#238 records the reasoning), pinned here so
  // that any change to it is deliberate: a claim taken by an instance that is
  // then disposed before its queued work runs is reported by no instance.
  it("L1 (#238): a second reload while the newer instance still has a stop queued drops that stop", async () => {
    const busy = gate();
    const seen: Seen[] = [];
    const first = await instance("first", seen);
    const second = await instance("second", seen, { block: { session: parent, until: busy.until } });
    for (const each of [first, second]) await each.prompt(prompt(parent));
    for (const each of [first, second]) each.publish(stopped("evt_pin_running"));
    await settle();
    for (const each of [first, second]) each.publish(stopped("evt_pin_queued"));
    await settle();
    // The second reload: a third instance, and the second disposed with that stop still queued.
    const third = await instance("third", seen);
    const closing = second.cleanup();
    busy.release();
    await closing;
    for (const each of [first, third]) await each.cleanup();
    // The first instance knew the session and yielded; nobody reports evt_pin_queued.
    expect(seen.map(({ by, event }) => `${by} ${event}`)).toEqual(["second turn.stop"]);
  });

  it("L2 (#238): a session learned from a prompt after another instance's claim is not reported by either", async () => {
    const busy = gate();
    const seen: Seen[] = [];
    const old = await instance("old", seen, { block: { session: parent, until: busy.until } });
    const next = await instance("new", seen);
    await old.prompt(prompt(parent));
    for (const each of [old, next]) each.publish(stopped("evt_pin_running"));
    await settle();
    // Claimed by the old instance, queued behind its running stop.
    old.publish(stopped("evt_pin_queued"));
    await settle();
    // The new instance learns the session only now, then reads the same stop.
    await next.prompt(prompt(parent));
    next.publish(stopped("evt_pin_queued"));
    await settle();
    const closing = old.cleanup();
    busy.release();
    await closing;
    await next.cleanup();
    // Before #236 the new instance reported evt_pin_queued; now nobody does.
    expect(seen.map(({ by, event }) => `${by} ${event}`)).toEqual(["old turn.stop"]);
  });

  it("Q5: a prompt steered into an execution the old instance still runs keeps that execution's text and id", async () => {
    // The 2.0.17 and 2.2.6 order: the completion reaches both instances while
    // the old one lives. The new instance took the steered prompt, so it
    // reports; the old one holds the execution.
    const seen: Seen[] = [];
    const text = rows.findIndex(
      (row) => row.event["type"] === "session.text.ended" && data(row)["sessionID"] === child,
    );
    const old = await instance("old", seen);
    await old.feed(0, text + 1);
    const next = await instance("new", seen);
    // A segment both instances buffer: still unread by the new one when the
    // prompt takes the old one's text over, then read.
    next.publish(rows[text]!.event);
    void next.prompt({ hook: "prompt", directory, event: { sessionID: child, messageID: "msg_steered" } });
    await settle();
    await old.feed(text + 1, completion(child) + 1, [old, next]);
    // A later execution of the child that no prompt started.
    for (const each of [old, next]) {
      each.publish({ id: "evt_later", type: "session.execution.started", data: { sessionID: child } });
      each.publish({ id: "evt_later_done", type: "session.execution.succeeded", data: { sessionID: child } });
    }
    await settle();
    for (const each of [old, next]) await each.cleanup();
    expect(
      seen
        .filter((entry) => entry.session === child || entry.agentId === child)
        .map(({ by, event, lastMessage, turnId }) => ({ by, event, lastMessage, turnId })),
    ).toEqual([
      {
        by: "new",
        event: "turn.stop",
        lastMessage: "hooknostic-child-result",
        turnId: prompt(child)!.event["messageID"],
      },
      { by: "new", event: "agent.stop", lastMessage: "hooknostic-child-result", turnId: undefined },
      { by: "new", event: "turn.stop", lastMessage: undefined, turnId: undefined },
      { by: "new", event: "agent.stop", lastMessage: undefined, turnId: undefined },
    ]);
  });

  it("Q6: a handover merges into a session the new instance already runs, and never overwrites", async () => {
    const seen: Seen[] = [];
    const old = await instance("old", seen);
    await old.feed(0, completion(child));
    const next = await instance("new", seen, { types: true });
    // The new instance's own link and execution, different from the old one's.
    for (const event of [
      {
        id: "evt_own_created",
        type: "session.created",
        data: { sessionID: child, parentID: parent, agent: "explore", location: { directory } },
      },
      { id: "evt_own_started", type: "session.execution.started", data: { sessionID: child } },
      {
        id: "evt_own_text",
        type: "session.text.ended",
        data: { sessionID: child, assistantMessageID: "msg_own", ordinal: 0, text: "own text" },
      },
    ])
      next.publish(event);
    await settle();
    await old.cleanup();
    next.publish(rows[completion(child)]!.event);
    await settle();
    await next.cleanup();
    expect(
      seen
        .filter((entry) => entry.by === "new")
        .map(({ event, agentType, lastMessage }) => ({ event, agentType, lastMessage })),
    ).toEqual([
      { event: "turn.stop", agentType: undefined, lastMessage: "own text" },
      { event: "agent.stop", agentType: "explore", lastMessage: "own text" },
    ]);
  });

  it("R17: an older instance reports again once the newer one is disposed", async () => {
    const seen: Seen[] = [];
    const older = await instance("older", seen);
    const newer = await instance("newer", seen);
    for (const each of [older, newer]) await each.prompt(prompt(parent));
    await newer.cleanup();
    older.publish(rows[completion(parent)]!.event);
    await settle();
    await older.cleanup();
    expect(seen.map(({ by, event }) => ({ by, event }))).toEqual([{ by: "older", event: "turn.stop" }]);
  });
});
