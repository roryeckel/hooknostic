import { describe, expect, it } from "vitest";
import type { HookEvent, RuntimePolicy, ToolAfterEvent, ToolBeforeEvent } from "@hooknostic/sdk";
import {
  addContext,
  block,
  blockContinuation,
  hook,
  notify,
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
  notifications,
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
  "turn.stop.notify": "exact",
  "session.end.observe": "exact",
};

function turnStop(): HookEvent {
  return {
    schemaVersion: 1,
    event: "turn.stop",
    harness: { id: "fake", nativeEvent: "Stop" },
    session: { cwd: "C:/repo" },
    correlation: {},
    raw: {},
  } satisfies HookEvent;
}

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

  it("accumulates notifications without terminating the dispatch", async () => {
    const ran: string[] = [];
    const result = await dispatch(
      [
        hook("turn.stop", {
          id: "n1",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            ran.push("n1");
            return notify("lint could not run");
          },
        }),
        hook("turn.stop", {
          id: "n2",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            ran.push("n2");
            return notify("budget expired");
          },
        }),
        hook("turn.stop", {
          id: "observer",
          async run() {
            ran.push("observer");
          },
        }),
      ],
      turnStop(),
      OPTIONS,
    );
    expect(notifications(result)).toEqual(["lint could not run", "budget expired"]);
    expect(result.terminatedBy).toBeUndefined();
    expect(ran).toEqual(["n1", "n2", "observer"]);
  });

  it("keeps notifications emitted before a terminal preventStop", async () => {
    const result = await dispatch(
      [
        hook("turn.stop", {
          id: "notice",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            return notify("3 files still uncommitted");
          },
        }),
        hook("turn.stop", {
          id: "prevent",
          capabilities: { "turn.stop.prevent": "required" },
          async run() {
            return preventStop("tests have not run");
          },
        }),
        hook("turn.stop", {
          id: "after-terminal",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            return notify("never reached");
          },
        }),
      ],
      turnStop(),
      OPTIONS,
    );
    // The notice survives, the terminal effect is still last (which every
    // adapter relies on), and the hook declared after it never runs.
    expect(notifications(result)).toEqual(["3 files still uncommitted"]);
    expect(result.terminatedBy).toBe("prevent");
    expect(terminalEffect(result)).toEqual({ kind: "preventStop", reason: "tests have not run" });
  });

  it("records rather than silently drops notifications over the budget", async () => {
    const result = await dispatch(
      [
        hook("turn.stop", {
          id: "n1",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            return notify("alpha");
          },
        }),
        hook("turn.stop", {
          id: "n2",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            return notify("beta-is-long");
          },
        }),
        hook("turn.stop", {
          id: "n3",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            return notify("dropped entirely");
          },
        }),
      ],
      turnStop(),
      { ...OPTIONS, policy: { notifyCharLimit: 9 } },
    );
    expect(notifications(result)).toEqual(["alpha", "beta"]);
    // Unlike the context budget, a clamped notification leaves a trace: losing
    // one silently would defeat the point of the effect.
    expect(result.errors.map((e) => [e.hookId, e.kind])).toEqual([
      ["n2", "budget-exceeded"],
      ["n3", "budget-exceeded"],
    ]);
  });

  it("keeps the notification cap when a policy key is explicitly undefined", async () => {
    // Enough total text to exceed the 2000-char default, so a disabled cap is
    // observable: three 1000-char notices clamp to 2000 when the budget works
    // and pass through at 3000 when it is NaN.
    const hooks = Array.from({ length: 3 }, (_unused, index) =>
      hook("turn.stop", {
        id: `n${index}`,
        capabilities: { "turn.stop.notify": "required" },
        async run() {
          return notify("x".repeat(1_000));
        },
      }),
    );
    // Spreading `{...DEFAULT_RUNTIME, ...policy}` lets an explicit undefined
    // clobber the default; unguarded, the budget goes NaN and the cap is off.
    // `exactOptionalPropertyTypes` blocks this through the typed API, hence the
    // cast — but dispatch() is reachable from untyped JS inside a generated
    // artifact, where nothing stops it.
    const result = await dispatch(hooks, turnStop(), {
      ...OPTIONS,
      policy: { notifyCharLimit: undefined } as unknown as RuntimePolicy,
    });
    expect(notifications(result).join("").length).toBe(2_000);
    expect(result.errors.map((e) => e.kind)).toEqual(["budget-exceeded"]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the default notification cap for an invalid direct-dispatch budget (%s)",
    async (notifyCharLimit) => {
      const hooks = Array.from({ length: 3 }, (_unused, index) =>
        hook("turn.stop", {
          id: `n${index}`,
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            return notify("x".repeat(1_000));
          },
        }),
      );
      const result = await dispatch(hooks, turnStop(), {
        ...OPTIONS,
        policy: { notifyCharLimit } as RuntimePolicy,
      });

      expect(notifications(result).join("").length).toBe(2_000);
      expect(notifications(result)).not.toContain("");
      expect(result.errors.map((e) => e.kind)).toEqual(["budget-exceeded"]);
    },
  );

  it("never emits an empty notification from a fractional budget", async () => {
    const result = await dispatch(
      [
        hook("turn.stop", {
          id: "n1",
          capabilities: { "turn.stop.notify": "required" },
          async run() {
            return notify("abc");
          },
        }),
      ],
      turnStop(),
      // Config values are guarded by .int().positive(); dispatch() is not, and
      // slice(0, 0.5) would push an empty message that effectSchema rejects.
      { ...OPTIONS, policy: { notifyCharLimit: 0.5 } },
    );
    expect(notifications(result)).toEqual([]);
    expect(result.errors.map((e) => e.kind)).toEqual(["budget-exceeded"]);
  });

  it("rejects notify where the event has no notification channel", async () => {
    const result = await dispatch(
      [
        hook("tool.before", {
          id: "misplaced",
          async run() {
            return notify("nope") as never;
          },
        }),
      ],
      toolBefore({}),
      OPTIONS,
    );
    expect(result.effects).toEqual([]);
    expect(result.errors[0]).toMatchObject({ hookId: "misplaced", kind: "unsupported-effect" });
    expect(result.errors[0]?.message).toContain("HN401");
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

  it("honours a hook's own budget over the policy default, in both directions", async () => {
    // A hook that shells out needs longer than its neighbours; giving the whole
    // plugin that budget instead means a bug in the fast hook hangs the harness
    // for the slow one's allowance.
    const hooks = [
      hook("tool.before", {
        id: "patient",
        timeoutMs: 400,
        capabilities: { "tool.before.context.add": "required" },
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return addContext("finished");
        },
      }),
      hook("tool.before", {
        id: "impatient",
        timeoutMs: 20,
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 120));
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), {
      ...OPTIONS,
      // Both hooks would resolve the opposite way under the shared default.
      policy: { timeoutMs: 50 },
    });
    expect(contextAdditions(result)).toEqual(["finished"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ hookId: "impatient", kind: "timeout" });
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

describe("policy-aware hook capability detection", () => {
  it("hides a below-minimum optional capability from detection and effect application", async () => {
    const observed: Array<[boolean, string]> = [];
    const result = await dispatch(
      [
        hook("tool.before", {
          id: "optional-rewrite",
          capabilities: { "tool.before.input.replace": "optional" },
          async run(_event, ctx) {
            observed.push([
              ctx.capabilities.has("tool.before.input.replace"),
              ctx.capabilities.level("tool.before.input.replace"),
            ]);
            return replaceInput({ command: "should-not-apply" });
          },
        }),
      ],
      toolBefore({ command: "original" }),
      {
        ...OPTIONS,
        capabilities: {
          "tool.before.observe": "exact",
          "tool.before.input.replace": "approximate",
        },
        minimumCapabilityLevel: "emulated",
      },
    );
    expect(observed).toEqual([[false, "unsupported"]]);
    expect(result.errors[0]?.message).toContain("HN401");
    expect(replacedInput(result)).toBeUndefined();
  });

  it("keeps a below-minimum required capability usable after a warning-only build", async () => {
    const observed: Array<[boolean, string]> = [];
    const result = await dispatch(
      [
        hook("tool.before", {
          id: "required-rewrite",
          capabilities: { "tool.before.input.replace": "required" },
          async run(_event, ctx) {
            observed.push([
              ctx.capabilities.has("tool.before.input.replace"),
              ctx.capabilities.level("tool.before.input.replace"),
            ]);
            return replaceInput({ command: "applied" });
          },
        }),
      ],
      toolBefore({ command: "original" }),
      {
        ...OPTIONS,
        capabilities: {
          "tool.before.observe": "exact",
          "tool.before.input.replace": "approximate",
        },
        minimumCapabilityLevel: "emulated",
      },
    );
    expect(observed).toEqual([[true, "approximate"]]);
    expect(result.errors).toEqual([]);
    expect(replacedInput(result)).toEqual({ value: { command: "applied" } });
  });
});

describe("effect payload JSON rule at dispatch", () => {
  it("rejects a non-JSON replacement as HN401 and keeps a later terminal block", async () => {
    const cyclic: Record<string, unknown> = { command: "rm -rf /" };
    cyclic["self"] = cyclic;
    const event = toolBefore({ command: "ls" });
    const result = await dispatch(
      [
        hook("tool.before", {
          id: "cyclic-rewrite",
          capabilities: { "tool.before.input.replace": "required" },
          async run() {
            return replaceInput(cyclic);
          },
        }),
        hook("tool.before", {
          id: "deny",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return block("denied");
          },
        }),
      ],
      event,
      OPTIONS,
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ hookId: "cyclic-rewrite", kind: "unsupported-effect" }),
    ]);
    expect(result.errors[0]?.message).toContain("HN401");
    expect(result.errors[0]?.message).toContain("not a JSON value");
    // The rejected payload never reached the event or the result…
    expect(event.tool.input).toEqual({ command: "ls" });
    expect(replacedInput(result)).toBeUndefined();
    // …so the terminal denial survives serialization to the native protocol.
    expect(terminalEffect(result)).toEqual({ kind: "block", reason: "denied" });
    expect(JSON.stringify(result)).toContain("denied");
  });

  it("rejects undefined and bigint replacement payloads", async () => {
    for (const payload of [undefined, 10n]) {
      const result = await dispatch(
        [
          hook("tool.after", {
            id: "bad-output",
            capabilities: { "tool.after.output.replace": "required" },
            async run() {
              return replaceOutput(payload);
            },
          }),
        ],
        toolAfter("original"),
        OPTIONS,
      );
      expect(result.errors.map((e) => e.kind)).toEqual(["unsupported-effect"]);
      expect(replacedOutput(result)).toBeUndefined();
    }
  });

  it("turns an uninspectable replacement into HN401 instead of throwing", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("not inspectable");
        },
      },
    );
    const result = await dispatch(
      [
        hook("tool.after", {
          id: "hostile-output",
          capabilities: { "tool.after.output.replace": "required" },
          async run() {
            return replaceOutput(hostile);
          },
        }),
      ],
      toolAfter("original"),
      OPTIONS,
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ hookId: "hostile-output", kind: "unsupported-effect" }),
    ]);
    expect(result.errors[0]?.message).toContain("HN401");
    expect(replacedOutput(result)).toBeUndefined();
  });

  it("contains effect-schema exceptions as HN401 and continues dispatch", async () => {
    const uninspectableError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("error cannot be inspected");
        },
        get() {
          throw new Error("error cannot be stringified");
        },
      },
    );
    const hostile = new Proxy(
      {},
      {
        get(_target, key) {
          // Promise resolution reads `then` before effect validation does.
          if (key === "then") return undefined;
          throw uninspectableError;
        },
      },
    );
    const ran: string[] = [];
    const result = await dispatch(
      [
        hook("tool.before", {
          id: "hostile-effect",
          async run() {
            return hostile as never;
          },
        }),
        hook("tool.before", {
          id: "after-hostile-effect",
          async run() {
            ran.push("after");
          },
        }),
      ],
      toolBefore({ command: "ls" }),
      OPTIONS,
    );

    expect(result.errors).toEqual([
      expect.objectContaining({ hookId: "hostile-effect", kind: "unsupported-effect" }),
    ]);
    expect(result.errors[0]?.message).toContain("HN401");
    expect(result.errors[0]?.message).toContain("uninspectable thrown value");
    expect(ran).toEqual(["after"]);
  });
});
