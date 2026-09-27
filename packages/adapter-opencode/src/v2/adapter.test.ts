import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { analyzeCapabilities, buildPluginIR, resolveTargetAdapter } from "@hooknostic/core";
import { definePlugin, hook, notify, preventStop, replaceInput } from "@hooknostic/sdk";
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
        session: { hook: vi.fn() },
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

  it("registers error-only hooks and disposes their registration", async () => {
    let callback: ((event: Record<string, unknown>) => Promise<void>) | undefined;
    const dispose = vi.fn(async () => {});
    const run = vi.fn();
    const cleanup = await setupOpenCodeV2(
      definePlugin({ name: "error-only", hooks: [hook("tool.error", { id: "error", run })] }),
      { capabilities: { "tool.error.observe": "approximate" } },
      {
        location: { directory: "." },
        session: { hook: vi.fn() },
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
    expect(dispose).toHaveBeenCalledOnce();
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
      const decoded = decodeOpenCodeV2(raw, {
        targetId: target.id,
        harnessVersion: opencodeV2Harness.referenceVersion,
      });
      expect(decoded).toEqual({ ...canonical, raw });
      expect(decoded.raw).toBe(raw);
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
