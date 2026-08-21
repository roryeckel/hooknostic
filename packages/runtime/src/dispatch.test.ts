import { describe, expect, it } from "vitest";
import type { HookEvent, ToolAfterEvent, ToolBeforeEvent } from "@hooknostic/sdk";
import {
  addContext,
  block,
  blockContinuation,
  hook,
  preventStop,
  replaceInput,
  replaceOutput,
  requestApproval,
} from "@hooknostic/sdk";
import type { CapabilityLevels } from "./dispatch.js";
import {
  contextAdditions,
  createCapabilitySet,
  dispatch,
  replacedInput,
  replacedOutput,
  terminalEffect,
} from "./dispatch.js";

const FULL: CapabilityLevels = {
  "tool.before.observe": "exact",
  "tool.before.block": "exact",
  "tool.before.requestApproval": "exact",
  "tool.before.input.replace": "exact",
  "tool.before.context.add": "exact",
  "tool.after.observe": "exact",
  "tool.after.output.replace": "exact",
  "tool.after.blockContinuation": "exact",
  "turn.stop.observe": "exact",
  "turn.stop.prevent": "exact",
  "session.end.observe": "exact",
};

function toolBefore(input: unknown): ToolBeforeEvent {
  return {
    schemaVersion: 1,
    event: "tool.before",
    harness: { id: "fake", version: "1.0.0", nativeEvent: "PreToolUse" },
    session: { id: "s", cwd: "C:/repo" },
    correlation: { toolCallId: "t1" },
    raw: { native: true },
    tool: { kind: "shell", nativeName: "Bash", input },
  };
}

function toolAfter(output: unknown): ToolAfterEvent {
  return {
    schemaVersion: 1,
    event: "tool.after",
    harness: { id: "fake", nativeEvent: "PostToolUse" },
    session: { cwd: "C:/repo" },
    correlation: {},
    raw: {},
    tool: { kind: "shell", nativeName: "Bash", input: { command: "ls" } },
    output,
  };
}

const OPTIONS = { targetId: "fake", harness: { id: "fake" }, capabilities: FULL };

describe("dispatch composition (ADR-0003)", () => {
  it("runs handlers sequentially with immediate input-mutation visibility", async () => {
    const seen: string[] = [];
    const hooks = [
      hook("tool.before", {
        id: "first",
        capabilities: { "tool.before.input.replace": "required" },
        async run(event) {
          seen.push((event.tool.input as { command: string }).command);
          return replaceInput({ command: "pnpm install" });
        },
      }),
      hook("tool.before", {
        id: "second",
        async run(event) {
          seen.push((event.tool.input as { command: string }).command);
        },
      }),
    ];
    const event = toolBefore({ command: "npm install" });
    const result = await dispatch(hooks, event, OPTIONS);
    expect(seen).toEqual(["npm install", "pnpm install"]);
    expect(result.terminatedBy).toBeUndefined();
    expect(replacedInput(result)).toEqual({ value: { command: "pnpm install" } });
    expect(event.tool.input).toEqual({ command: "pnpm install" });
  });

  it("stops remaining handlers at the first terminal effect and records the terminator", async () => {
    const ran: string[] = [];
    const hooks = [
      hook("tool.before", {
        id: "a",
        capabilities: { "tool.before.block": "required" },
        async run() {
          ran.push("a");
          return block("stop here");
        },
      }),
      hook("tool.before", {
        id: "b",
        capabilities: { "tool.before.block": "required" },
        async run() {
          ran.push("b");
          return block("never reached");
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), OPTIONS);
    expect(ran).toEqual(["a"]);
    expect(result.terminatedBy).toBe("a");
    expect(terminalEffect(result)).toEqual({ kind: "block", reason: "stop here" });
  });

  it("treats requestApproval, preventStop, and blockContinuation as terminal", async () => {
    const approval = await dispatch(
      [
        hook("tool.before", {
          id: "ask",
          capabilities: { "tool.before.requestApproval": "required" },
          async run() {
            return requestApproval("confirm this");
          },
        }),
      ],
      toolBefore({}),
      OPTIONS,
    );
    expect(approval.terminatedBy).toBe("ask");

    const stop = await dispatch(
      [
        hook("turn.stop", {
          id: "keep-going",
          capabilities: { "turn.stop.prevent": "required" },
          async run() {
            return preventStop("not done yet");
          },
        }),
      ],
      {
        schemaVersion: 1,
        event: "turn.stop",
        harness: { id: "fake", nativeEvent: "Stop" },
        session: { cwd: "C:/repo" },
        correlation: {},
        raw: {},
      } satisfies HookEvent,
      OPTIONS,
    );
    expect(stop.terminatedBy).toBe("keep-going");

    const cont = await dispatch(
      [
        hook("tool.after", {
          id: "halt",
          capabilities: { "tool.after.blockContinuation": "required" },
          async run() {
            return blockContinuation("bad output");
          },
        }),
      ],
      toolAfter("data"),
      OPTIONS,
    );
    expect(cont.terminatedBy).toBe("halt");
  });

  it("applies output replacement immediately for subsequent handlers", async () => {
    const seen: unknown[] = [];
    const hooks = [
      hook("tool.after", {
        id: "redact",
        capabilities: { "tool.after.output.replace": "required" },
        async run() {
          return replaceOutput("[redacted]");
        },
      }),
      hook("tool.after", {
        id: "inspect",
        async run(event) {
          seen.push(event.output);
        },
      }),
    ];
    const result = await dispatch(hooks, toolAfter("secret token"), OPTIONS);
    expect(seen).toEqual(["[redacted]"]);
    expect(replacedOutput(result)).toEqual({ value: "[redacted]" });
  });

  it("accumulates context in declaration order under the configured cap", async () => {
    const hooks = [
      hook("tool.before", {
        id: "c1",
        capabilities: { "tool.before.context.add": "required" },
        async run() {
          return addContext("alpha");
        },
      }),
      hook("tool.before", {
        id: "c2",
        capabilities: { "tool.before.context.add": "required" },
        async run() {
          return addContext("beta-is-long");
        },
      }),
      hook("tool.before", {
        id: "c3",
        capabilities: { "tool.before.context.add": "required" },
        async run() {
          return addContext("dropped entirely");
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), {
      ...OPTIONS,
      policy: { contextCharLimit: 9 },
    });
    // 5 chars of budget spent on "alpha", 4 remain: "beta-is-long" truncated,
    // third addition dropped deterministically.
    expect(contextAdditions(result)).toEqual(["alpha", "beta"]);
  });

  it("filters by tool matcher and by intentional target scoping", async () => {
    const ran: string[] = [];
    const hooks = [
      hook("tool.before", {
        id: "shell-only",
        match: { kind: "shell" },
        async run() {
          ran.push("shell-only");
        },
      }),
      hook("tool.before", {
        id: "files-only",
        match: { kind: "file.write" },
        async run() {
          ran.push("files-only");
        },
      }),
      hook("tool.before", {
        id: "other-target",
        targets: { include: ["claude"] },
        async run() {
          ran.push("other-target");
        },
      }),
      hook("tool.before", {
        id: "excluded",
        targets: { exclude: ["fake"] },
        async run() {
          ran.push("excluded");
        },
      }),
    ];
    await dispatch(hooks, toolBefore({}), OPTIONS);
    expect(ran).toEqual(["shell-only"]);
  });
});

describe("runtime contract violations (HN401)", () => {
  it("rejects an effect returned without its capability declared", async () => {
    const hooks = [
      hook("tool.before", {
        id: "sneaky",
        // @ts-expect-error deliberately returning an undeclared effect
        async run() {
          return block("undeclared");
        },
      }),
      hook("tool.before", {
        id: "after",
        capabilities: { "tool.before.context.add": "required" },
        async run() {
          return addContext("still ran");
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), OPTIONS);
    expect(result.errors).toEqual([
      expect.objectContaining({ hookId: "sneaky", kind: "unsupported-effect" }),
    ]);
    expect(result.errors[0]?.message).toContain("HN401");
    // fail-open: the effect was not applied and later handlers ran
    expect(result.terminatedBy).toBeUndefined();
    expect(contextAdditions(result)).toEqual(["still ran"]);
  });

  it("rejects a declared effect whose capability is unavailable on this target", async () => {
    const hooks = [
      hook("tool.before", {
        id: "optimist",
        capabilities: { "tool.before.input.replace": "optional" },
        async run() {
          // returns without feature-detecting — a bug this contract catches
          return replaceInput({ command: "x" });
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({ command: "y" }), {
      ...OPTIONS,
      capabilities: { "tool.before.observe": "exact" },
    });
    expect(result.errors[0]).toMatchObject({ hookId: "optimist", kind: "unsupported-effect" });
    expect(replacedInput(result)).toBeUndefined();
  });

  it("rejects effects that are structurally impossible for the event", async () => {
    const hooks = [
      hook("session.end", {
        id: "impossible",
        // @ts-expect-error bypassing the type layer on purpose
        async run() {
          return block("cannot block session end");
        },
      }),
    ];
    const result = await dispatch(
      hooks,
      {
        schemaVersion: 1,
        event: "session.end",
        harness: { id: "fake", nativeEvent: "SessionEnd" },
        session: { cwd: "C:/" },
        correlation: {},
        raw: {},
      },
      OPTIONS,
    );
    expect(result.errors[0]?.message).toContain('not defined for event "session.end"');
  });

  it("rejects malformed effect values", async () => {
    const hooks = [
      hook("tool.before", {
        id: "garbage",
        // @ts-expect-error returning a non-effect
        async run() {
          return { kind: "allow" };
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), OPTIONS);
    expect(result.errors[0]).toMatchObject({ kind: "unsupported-effect" });
  });
});

describe("error and timeout policy", () => {
  it("fail-open by default: errors are recorded and dispatch continues", async () => {
    const ran: string[] = [];
    const hooks = [
      hook("tool.before", {
        id: "boom",
        async run() {
          throw new Error("exploded");
        },
      }),
      hook("tool.before", {
        id: "survivor",
        async run() {
          ran.push("survivor");
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), OPTIONS);
    expect(result.errors).toEqual([
      expect.objectContaining({ hookId: "boom", kind: "error", message: "exploded" }),
    ]);
    expect(ran).toEqual(["survivor"]);
  });

  it("onHookError block synthesizes a terminal block when the event supports blocking", async () => {
    const hooks = [
      hook("tool.before", {
        id: "boom",
        async run() {
          throw new Error("exploded");
        },
      }),
      hook("tool.before", {
        id: "never",
        async run() {
          throw new Error("unreachable");
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), {
      ...OPTIONS,
      policy: { onHookError: "block" },
    });
    expect(result.terminatedBy).toBe("boom");
    expect(terminalEffect(result)).toMatchObject({ kind: "block" });
    expect(result.errors).toHaveLength(1);
  });

  it("onHookError block falls open when the event cannot block on this target", async () => {
    const hooks = [
      hook("session.end", {
        id: "boom",
        async run() {
          throw new Error("exploded");
        },
      }),
    ];
    const result = await dispatch(
      hooks,
      {
        schemaVersion: 1,
        event: "session.end",
        harness: { id: "fake", nativeEvent: "SessionEnd" },
        session: { cwd: "C:/" },
        correlation: {},
        raw: {},
      },
      { ...OPTIONS, policy: { onHookError: "block" } },
    );
    expect(result.terminatedBy).toBeUndefined();
    expect(result.errors).toHaveLength(1);
  });

  it("times out slow handlers, aborts their signal, and continues", async () => {
    let aborted = false;
    const hooks = [
      hook("tool.before", {
        id: "slow",
        async run(_event, ctx) {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
      }),
      hook("tool.before", {
        id: "fast",
        capabilities: { "tool.before.context.add": "required" },
        async run() {
          return addContext("made it");
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), {
      ...OPTIONS,
      policy: { timeoutMs: 50 },
    });
    expect(result.errors[0]).toMatchObject({ hookId: "slow", kind: "timeout" });
    expect(aborted).toBe(true);
    expect(contextAdditions(result)).toEqual(["made it"]);
  });
});

describe("createCapabilitySet", () => {
  it("reports availability and levels", () => {
    const set = createCapabilitySet({
      "tool.before.block": "emulated",
      "tool.before.input.replace": "unsupported",
    });
    expect(set.has("tool.before.block")).toBe(true);
    expect(set.level("tool.before.block")).toBe("emulated");
    expect(set.has("tool.before.input.replace")).toBe(false);
    expect(set.has("tool.before.context.add")).toBe(false);
    expect(set.level("tool.before.context.add")).toBe("unsupported");
  });
});
