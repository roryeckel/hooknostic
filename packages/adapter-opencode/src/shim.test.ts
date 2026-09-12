import { describe, expect, it } from "vitest";
import {
  addContext,
  block,
  definePlugin,
  hook,
  notify,
  preventStop,
  replaceInput,
  updateShell,
  replaceOutput,
} from "@hooknostic/sdk";
import { opencodeCapabilityProfiles } from "./profile.js";
import { createHooknosticHooks } from "./shim.js";

const LEVELS = Object.fromEntries(
  Object.entries(opencodeCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]),
);

const PLUGIN_INPUT = { directory: "C:/project", worktree: "C:/project" };

function smokePlugin() {
  return definePlugin({
    name: "shim-test",
    hooks: [
      hook("tool.before", {
        id: "guard",
        match: { kind: "shell" },
        capabilities: {
          "tool.before.block": "required",
          "tool.before.input.replace": "optional",
        },
        async run(event, ctx) {
          const raw = (event.tool.input as { command?: unknown }).command;
          const command = event.tool.shell?.command ?? (typeof raw === "string" ? raw : "");
          if (command.includes("rm -rf /")) return block("blocked by guard");
          if (
            ctx.capabilities.has("tool.before.input.replace") &&
            event.tool.shell !== undefined &&
            command.startsWith("npm ")
          ) {
            return updateShell({ command: command.replace(/^npm /, "pnpm ") });
          }
        },
      }),
      hook("tool.after", {
        id: "redact",
        capabilities: { "tool.after.output.replace": "required" },
        async run(event) {
          if (typeof event.output === "string" && event.output.includes("SECRET")) {
            return replaceOutput(event.output.replaceAll("SECRET", "[redacted]"));
          }
        },
      }),
      hook("permission.request", {
        id: "deny-mkdir",
        capabilities: { "permission.request.block": "required" },
        async run(event) {
          const title = (event.tool.input as { title?: string }).title ?? "";
          if (title.includes("mkdir")) return block("no new directories");
        },
      }),
      hook("context.compact.before", {
        id: "compact-note",
        capabilities: { "context.compact.before.context.add": "required" },
        async run() {
          return addContext("hooknostic compaction note");
        },
      }),
      hook("turn.stop", { id: "observe-idle", async run() {} }),
    ],
  });
}

function hooks() {
  return createHooknosticHooks(smokePlugin(), { capabilities: LEVELS }, PLUGIN_INPUT);
}

describe("createHooknosticHooks", () => {
  it("copies __proto__ as an own data key without changing live argument identity or prototype", async () => {
    const replacement = JSON.parse('{"__proto__":{"injected":"yes"},"command":"echo safe"}');
    const plugin = definePlugin({ name: "data-keys", hooks: [hook("tool.before", {
      id: "replace", capabilities: { "tool.before.input.replace": "required" },
      async run() { return replaceInput(replacement); },
    })] });
    const h = createHooknosticHooks(plugin, { capabilities: LEVELS }, PLUGIN_INPUT);
    for (const prototype of [Object.prototype, null]) {
      const args = Object.assign(Object.create(prototype), { command: "old", stale: true });
      const output = { args };
      await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, output);
      expect(output.args).toBe(args);
      expect(Object.getPrototypeOf(args)).toBe(prototype);
      expect(Object.getOwnPropertyDescriptor(args, "__proto__")).toEqual({ value: { injected: "yes" }, writable: true, enumerable: true, configurable: true });
      expect(args.injected).toBeUndefined();
      expect(args.stale).toBeUndefined();
      expect(args.command).toBe("echo safe");
    }
  });
  it("registers only the callbacks the plugin needs", () => {
    expect(Object.keys(hooks()).sort()).toEqual([
      "event",
      "experimental.session.compacting",
      "tool.execute.after",
      "tool.execute.before",
    ]);
  });

  it("blocks by throwing inside tool.execute.before", async () => {
    const h = hooks();
    await expect(
      h["tool.execute.before"]!(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "rm -rf /" } },
      ),
    ).rejects.toThrow("blocked by guard");
  });

  it("rewrites input by mutating output.args", async () => {
    const h = hooks();
    const output = { args: { command: "npm install" } };
    await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, output);
    expect(output.args).toEqual({ command: "pnpm install" });
  });

  it("preserves a replacement that aliases the live arguments object", async () => {
    const plugin = definePlugin({
      name: "aliased-replacement",
      hooks: [
        hook("tool.before", {
          id: "alias",
          capabilities: { "tool.before.input.replace": "required" },
          async run(event) {
            const input = event.tool.input as { command: string };
            input.command = "pnpm install";
            return replaceInput(input);
          },
        }),
      ],
    });
    const h = createHooknosticHooks(plugin, { capabilities: LEVELS }, PLUGIN_INPUT);
    const output = { args: { command: "npm install" } };
    await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, output);
    expect(output.args).toEqual({ command: "pnpm install" });
  });

  it("keeps live arguments unchanged when a handler directly mutates its snapshot", async () => {
    const plugin = definePlugin({
      name: "invalid-replacement",
      hooks: [
        hook("tool.before", {
          id: "mutate-then-return-invalid",
          capabilities: { "tool.before.input.replace": "required" },
          async run(event) {
            (event.tool.input as { command: string }).command = "mutated directly";
            return replaceInput({ command: undefined });
          },
        }),
      ],
    });
    const h = createHooknosticHooks(plugin, { capabilities: LEVELS }, PLUGIN_INPUT);
    const output = { args: { command: "npm install" } };

    await h["tool.execute.before"]!(
      { tool: "bash", sessionID: "s", callID: "c" },
      output,
    );

    expect(output.args).toEqual({ command: "npm install" });
  });

  it("replaces tool output by mutating output.output", async () => {
    const h = hooks();
    const output = { title: "t", output: "token SECRET here", metadata: {} };
    await h["tool.execute.after"]!(
      { tool: "bash", sessionID: "s", callID: "c", args: {} },
      output,
    );
    expect(output.output).toBe("token [redacted] here");
  });

  it("rejects cyclic output replacements at dispatch (HN401) and leaves output untouched", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const plugin = definePlugin({
      name: "cyclic-output",
      hooks: [
        hook("tool.after", {
          id: "replace-cycle",
          capabilities: { "tool.after.output.replace": "required" },
          async run() {
            return replaceOutput(cyclic);
          },
        }),
      ],
    });
    const h = createHooknosticHooks(plugin, { capabilities: LEVELS }, PLUGIN_INPUT);
    const output = { output: "before" };
    await expect(
      h["tool.execute.after"]!(
        { tool: "bash", sessionID: "s", callID: "c", args: {} },
        output,
      ),
    ).resolves.toBeUndefined();
    // Non-JSON payloads never reach the native side; fail-open keeps the original.
    expect(output.output).toBe("before");
  });

  it("denies bus-event permissions through the client reply API", async () => {
    // Captured live on 1.18.25 (.capture/opencode-permission): the dedicated
    // permission.ask callback never fires (upstream anomalyco/opencode #9229);
    // the ask arrives as the permission.asked bus event, and "reject" via
    // postSessionIdPermissionsPermissionId denies it.
    const replies: { path: { id: string; permissionID: string }; body: { response: string } }[] = [];
    const plugin = definePlugin({
      name: "deny-all-perms",
      hooks: [
        hook("permission.request", {
          id: "deny-all",
          capabilities: { "permission.request.block": "required" },
          async run() {
            return block("no permissions for you");
          },
        }),
      ],
    });
    const client = {
      postSessionIdPermissionsPermissionId: (options: {
        path: { id: string; permissionID: string };
        body: { response: string };
      }) => {
        replies.push(options);
        return Promise.resolve({ data: true });
      },
    };
    const h = createHooknosticHooks(plugin, { capabilities: LEVELS }, { ...PLUGIN_INPUT, client });
    expect(Object.keys(h)).toEqual(["event"]);
    const native = {
      hook: "event",
      directory: PLUGIN_INPUT.directory,
      input: {
        event: {
          type: "permission.asked",
          properties: {
            id: "per_1",
            sessionID: "ses_1",
            permission: "bash",
            patterns: ["mkdir *"],
            metadata: { command: "mkdir x" },
            tool: { messageID: "m", callID: "c1" },
          },
        },
      },
    };
    await h["event"]!(native.input, undefined);
    expect(replies).toEqual([
      { path: { id: "ses_1", permissionID: "per_1" }, body: { response: "reject" } },
    ]);
  });

  it("is a silent no-op denying a permission without a client or ids", async () => {
    const plugin = definePlugin({
      name: "deny-all-perms",
      hooks: [
        hook("permission.request", {
          id: "deny-all",
          capabilities: { "permission.request.block": "required" },
          async run() {
            return block("no permissions for you");
          },
        }),
      ],
    });
    const h = createHooknosticHooks(plugin, { capabilities: LEVELS }, PLUGIN_INPUT);
    const native = {
      hook: "event",
      directory: PLUGIN_INPUT.directory,
      input: {
        event: {
          type: "permission.asked",
          properties: { id: "per_1", sessionID: "ses_1", permission: "bash" },
        },
      },
    };
    // No client: silent no-op (the user answers the ask themselves).
    await expect(h["event"]!(native.input, undefined)).resolves.toBeUndefined();
    // A client without the method (older SDK surface): same.
    await expect(h["event"]!(native.input, undefined)).resolves.toBeUndefined();
  });

  it("appends compaction context", async () => {
    const h = hooks();
    const output = { context: ["existing"] };
    await h["experimental.session.compacting"]!({ sessionID: "s" }, output);
    expect(output.context).toEqual(["existing", "hooknostic compaction note"]);
  });

  it("ignores unmapped bus events without throwing (fail-open)", async () => {
    const h = hooks();
    await expect(
      h["event"]!({ event: { type: "message.part.updated" } }, undefined),
    ).resolves.toBeUndefined();
  });

  it("does not deny the user's tool call when the shim itself fails", async () => {
    // Throwing IS the block channel here, so an unintended throw out of the
    // dispatch path denies the call. Claude and Codex force exitCode 0 on an
    // internal error and the call proceeds; this harness did the opposite,
    // which is the worse direction -- a hooknostic bug becoming a denial.
    //
    // A handler that throws proves nothing: dispatch() catches those itself and
    // records them in HookResult.errors. The exposed paths are the ones after
    // it -- applying mutations, and posting. A frozen `output` makes the
    // context assignment throw in the same place a real bug would.
    const h = hooks();
    const frozen = Object.freeze({});
    await expect(
      h["experimental.session.compacting"]!({ sessionID: "s" }, frozen),
    ).resolves.toBeUndefined();
  });

  it("still delivers a block the plugin actually asked for", async () => {
    // The wrapper must not swallow the deliberate throw the block rides on.
    const h = hooks();
    await expect(
      h["tool.execute.before"]!(
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "rm -rf /" } },
      ),
    ).rejects.toThrow("blocked by guard");
  });

  it("does not register callbacks used only by hooks scoped away from OpenCode", () => {
    const plugin = definePlugin({
      name: "other-target",
      hooks: [
        hook("tool.before", {
          id: "claude-only",
          targets: { include: ["claude"] },
          async run() {},
        }),
        hook("session.start", {
          id: "not-opencode",
          targets: { exclude: ["opencode"] },
          async run() {},
        }),
      ],
    });

    expect(Object.keys(createHooknosticHooks(plugin, { capabilities: LEVELS }, PLUGIN_INPUT))).toEqual(
      [],
    );
  });

  it("registers and runs callbacks scoped to a named OpenCode target", async () => {
    let ran = false;
    const plugin = definePlugin({
      name: "named-target",
      hooks: [
        hook("tool.before", {
          id: "primary-only",
          targets: { include: ["primary"] },
          async run() { ran = true; },
        }),
      ],
    });

    const registered = createHooknosticHooks(
      plugin,
      { capabilities: LEVELS, targetId: "primary" },
      PLUGIN_INPUT,
    );
    expect(Object.keys(registered)).toContain("tool.execute.before");
    await registered["tool.execute.before"]!(
      { tool: "bash", sessionID: "s", callID: "c" },
      { args: { command: "echo named" } },
    );
    expect(ran).toBe(true);
  });

  it("is invocation-stateless across repeated dispatches in one module lifetime", async () => {
    const h = hooks(); // one persistent hooks object, as in a real session
    for (let i = 0; i < 3; i++) {
      const output = { args: { command: "npm install" } };
      await h["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: `c${i}` }, output);
      // Identical behavior every time: nothing accumulates across invocations.
      expect(output.args).toEqual({ command: "pnpm install" });
    }
    await expect(
      h["tool.execute.before"]!(
        { tool: "bash", sessionID: "s", callID: "c9" },
        { args: { command: "rm -rf /" } },
      ),
    ).rejects.toThrow("blocked by guard");
  });
});

describe("createHooknosticHooks turn.stop posting", () => {
  interface Post {
    path: { id: string };
    body: { parts: { type: "text"; text: string }[]; noReply?: boolean };
  }

  function stopPlugin() {
    return definePlugin({
      name: "stop-test",
      hooks: [
        hook("turn.stop", {
          id: "notice",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            return notify("lint could not run");
          },
        }),
        hook("turn.stop", {
          id: "continue",
          capabilities: { "turn.stop.prevent": "required" },
          async run() {
            return preventStop("tests have not run");
          },
        }),
      ],
    });
  }

  function idleHooks(client?: unknown) {
    return createHooknosticHooks(
      stopPlugin(),
      { capabilities: LEVELS, minimumCapabilityLevel: "approximate" },
      { ...PLUGIN_INPUT, ...(client === undefined ? {} : { client }) } as never,
    );
  }

  const idle = {
    event: { type: "session.idle", properties: { sessionID: "ses_1" } },
  };

  function recorder(): { calls: Post[]; client: unknown } {
    const calls: Post[] = [];
    return {
      calls,
      client: {
        session: {
          promptAsync: (options: Post) => {
            calls.push(options);
            return Promise.resolve();
          },
        },
      },
    };
  }

  it("posts notifications with noReply and the stop reason without it", async () => {
    const { calls, client } = recorder();
    await idleHooks(client)["event"]!(idle, {});

    // Notice first, continuation last: the agent must read the notice before
    // the instruction that keeps it working.
    expect(calls.map((c) => [c.body.parts[0]!.text, c.body.noReply])).toEqual([
      ["lint could not run", true],
      ["tests have not run", undefined],
    ]);
    expect(calls.every((c) => c.path.id === "ses_1")).toBe(true);
  });

  it("calls promptAsync with its receiver, not detached", async () => {
    // The real SDK client exposes these as prototype methods that use `this`
    // (its own namespaces enumerate only `_client` as an own property), so a
    // destructured reference throws at call time and the fail-open catch turns
    // that into a silent no-op. A plain object-literal double cannot catch it.
    class Session {
      readonly calls: Post[] = [];
      private readonly tag = "bound";
      promptAsync(options: Post): Promise<void> {
        if (this?.tag !== "bound") throw new TypeError("promptAsync called without a receiver");
        this.calls.push(options);
        return Promise.resolve();
      }
    }
    const session = new Session();
    await idleHooks({ session })["event"]!(idle, {});
    expect(session.calls).toHaveLength(2);
  });

  it("is a silent no-op when the host supplies no client", async () => {
    await expect(idleHooks()["event"]!(idle, {})).resolves.toBeUndefined();
  });

  it("gives up on a post that never settles", async () => {
    // The OpenCode host awaits this callback and dispatch's own timeout does
    // not reach the post, so an unsettled promise would hang the session.
    const client = { session: { promptAsync: () => new Promise(() => {}) } };
    await expect(idleHooks(client)["event"]!(idle, {})).resolves.toBeUndefined();
  }, 40_000);

  it("fails open when a post rejects", async () => {
    const client = {
      session: { promptAsync: () => Promise.reject(new Error("server gone")) },
    };
    // A stop event is the worst place to throw: the user's session must survive.
    await expect(idleHooks(client)["event"]!(idle, {})).resolves.toBeUndefined();
  });

  it("posts identically on every dispatch in one module lifetime (ADR-0002)", async () => {
    const { calls, client } = recorder();
    const h = idleHooks(client); // one persistent hooks object, as in a real session
    for (let i = 0; i < 3; i++) await h["event"]!(idle, {});

    // Three dispatches, three identical pairs. This is what a dedupe set, a
    // memo, or a rate limiter added to the post path would break.
    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 2)).toEqual(calls.slice(2, 4));
    expect(calls.slice(0, 2)).toEqual(calls.slice(4, 6));
  });
});
