import { describe, expect, it } from "vitest";

import type { CapabilityId, HookEvent, RuntimePolicy, ToolAfterEvent, ToolBeforeEvent } from "@hooknostic/sdk";
import {
  addContext,
  block,
  blockContinuation,
  fileCodec,
  hook,
  notify,
  preventStop,
  replaceInput,
  replaceOutput,
  requestApproval,
  shellCodec,
  updateShell,
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
    expect(result.errors[0]?.code).toBe("HN401");
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
    expect(result.errors).toEqual([expect.objectContaining({ hookId: "sneaky", kind: "unsupported-effect" })]);
    expect(result.errors[0]?.code).toBe("HN401");
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
    expect(result.errors).toEqual([expect.objectContaining({ hookId: "boom", kind: "error", message: "exploded" })]);
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

  it("survives an explicitly-undefined policy timeout", async () => {
    // The two char budgets already coalesce against exactly this: an explicit
    // `undefined` survives `{...DEFAULT_RUNTIME, ...options.policy}`. Left
    // unguarded, setTimeout(cb, undefined) fires in ~1ms and every hook times
    // out reporting "timed out after undefinedms".
    const hooks = [
      hook("tool.before", {
        id: "ordinary",
        capabilities: { "tool.before.context.add": "required" },
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return addContext("ran");
        },
      }),
    ];
    const result = await dispatch(hooks, toolBefore({}), {
      ...OPTIONS,
      policy: { timeoutMs: undefined } as never,
    });
    expect(result.errors).toEqual([]);
    expect(contextAdditions(result)).toEqual(["ran"]);
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
    // The message is the only place the budget actually appears. Matching just
    // hookId/kind passes either way, because `impatient` times out under the
    // shared 50ms default too -- so only `patient` was carrying this test.
    expect(result.errors[0]).toMatchObject({
      hookId: "impatient",
      kind: "timeout",
      message: expect.stringContaining("timed out after 20ms"),
    });
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

  it("never resolves an Object.prototype member as a support level", () => {
    const set = createCapabilitySet({ "tool.before.block": "exact" });
    const probe = "constructor" as CapabilityId;
    expect(set.has(probe)).toBe(false);
    expect(set.level(probe)).toBe("unsupported");
  });
});

describe("effect lists (ADR-0025)", () => {
  it("lets one hook notify and then prevent a stop", async () => {
    const result = await dispatch(
      [
        hook("turn.stop", {
          id: "notify-and-prevent",
          capabilities: { prevent: "required", notify: "optional" },
          async run() {
            return [notify("lint failed"), preventStop("fix the lint")];
          },
        }),
      ],
      turnStop(),
      OPTIONS,
    );
    expect(result.errors).toEqual([]);
    expect(notifications(result)).toEqual(["lint failed"]);
    expect(terminalEffect(result)).toEqual({ kind: "preventStop", reason: "fix the lint" });
    expect(result.terminatedBy).toBe("notify-and-prevent");
    expect(result.effects.map((entry) => entry.hookId)).toEqual(["notify-and-prevent", "notify-and-prevent"]);
  });

  it("rejects a list whose terminal effect is not last, before applying any of it", async () => {
    const ran: string[] = [];
    const result = await dispatch(
      [
        hook("turn.stop", {
          id: "misordered",
          capabilities: { prevent: "required", notify: "optional" },
          async run() {
            return [preventStop("stop first"), notify("never shown")];
          },
        }),
        hook("turn.stop", {
          id: "later",
          async run() {
            ran.push("later");
          },
        }),
      ],
      turnStop(),
      OPTIONS,
    );
    expect(result.effects).toEqual([]);
    expect(result.terminatedBy).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({
        hookId: "misordered",
        code: "HN401",
        message: expect.stringContaining("must be last"),
      }),
    ]);
    // Rejection is fail-open like any HN401: later hooks still run.
    expect(ran).toEqual(["later"]);
  });

  it("applies the siblings of a failing element under the default policy", async () => {
    const event = toolBefore({ command: "npm install" });
    const result = await dispatch(
      [
        hook("tool.before", {
          id: "mixed",
          capabilities: { block: "required", "input.replace": "required" },
          async run() {
            // Two failure paths, each an HN401 for that element only: a value
            // that is no effect at all, and notify, which tool.before lacks.
            return [
              { kind: "bogus" } as never,
              replaceInput({ command: "pnpm install" }),
              notify("x") as never,
              block("then stop"),
            ];
          },
        }),
      ],
      event,
      OPTIONS,
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        hookId: "mixed",
        code: "HN401",
        message: expect.stringContaining("not a valid effect"),
      }),
      expect.objectContaining({ hookId: "mixed", code: "HN401", message: expect.stringContaining("not defined") }),
    ]);
    expect(replacedInput(result)).toEqual({ value: { command: "pnpm install" } });
    expect(terminalEffect(result)).toEqual({ kind: "block", reason: "then stop" });
    expect(event.tool.input).toEqual({ command: "pnpm install" });
  });

  it("stops at a failing element when the error policy blocks", async () => {
    const result = await dispatch(
      [
        hook("tool.before", {
          id: "strict",
          capabilities: { block: "required", "input.replace": "required" },
          async run() {
            return [{ kind: "bogus" } as never, replaceInput({ command: "not applied" })];
          },
        }),
      ],
      toolBefore({ command: "ls" }),
      { ...OPTIONS, policy: { onHookError: "block" } },
    );
    expect(replacedInput(result)).toBeUndefined();
    expect(terminalEffect(result)?.kind).toBe("block");
    expect(result.terminatedBy).toBe("strict");
  });

  it("lowers a portable shell rewrite inside a list and skips undefined entries", async () => {
    const codec = shellCodec({ Bash: { commandKey: "command" } });
    const event = toolBefore({ command: "npm test", description: "d" });
    event.tool.shell = codec.classify("Bash", event.tool.input)!;
    const result = await dispatch(
      [
        hook("tool.before", {
          id: "rewrite-and-explain",
          capabilities: { "input.replace": "required", "context.add": "optional" },
          async run() {
            return [undefined, updateShell({ command: "pnpm test" }), addContext("rewrote npm to pnpm")];
          },
        }),
        hook("tool.before", {
          id: "empty",
          async run() {
            return [];
          },
        }),
      ],
      event,
      { ...OPTIONS, shellCodec: codec },
    );
    expect(result.errors).toEqual([]);
    expect(result.effects.map((entry) => entry.effect.kind)).toEqual(["updateShell", "replaceInput", "addContext"]);
    expect(event.tool.input).toEqual({ command: "pnpm test", description: "d" });
    expect(event.tool.shell?.command).toBe("pnpm test");
  });

  it("fails open when reading the returned list throws", async () => {
    // Survives the promise machinery's `then` probe, then throws once the
    // list itself is read.
    const proxy = new Proxy([] as unknown[], {
      get(target, key) {
        if (key === "then") return undefined;
        throw new Error(`trapped ${String(key)}`);
      },
    });
    const result = await dispatch(
      [
        hook("turn.stop", {
          id: "revoked",
          async run() {
            return proxy as never;
          },
        }),
      ],
      turnStop(),
      OPTIONS,
    );
    expect(result.errors).toEqual([expect.objectContaining({ hookId: "revoked", code: "HN401" })]);
    expect(result.effects).toEqual([]);
  });
});

describe("event-relative capability keys", () => {
  it("stores full ids and resolves either spelling at dispatch", async () => {
    const observed: unknown[] = [];
    const def = hook("tool.before", {
      id: "relative",
      capabilities: { block: "required", "input.replace": "optional" },
      async run(_event, ctx) {
        // Destructured on purpose: the set's methods must not depend on `this`.
        const { has, level } = ctx.capabilities;
        observed.push(has("input.replace"), has("tool.before.input.replace"), level("block"));
        return replaceInput({ command: "rewritten" });
      },
    });
    expect(def.capabilities).toEqual({ "tool.before.block": "required", "tool.before.input.replace": "optional" });

    const result = await dispatch([def], toolBefore({ command: "original" }), OPTIONS);
    expect(observed).toEqual([true, true, "exact"]);
    expect(result.errors).toEqual([]);
    expect(replacedInput(result)).toEqual({ value: { command: "rewritten" } });
  });

  it("applies the compatibility floor to the declared requirement under either spelling", async () => {
    const observed: boolean[] = [];
    await dispatch(
      [
        hook("tool.before", {
          id: "required-relative",
          capabilities: { "input.replace": "required" },
          async run(_event, ctx) {
            observed.push(ctx.capabilities.has("input.replace"), ctx.capabilities.has("tool.before.input.replace"));
          },
        }),
      ],
      toolBefore({ command: "original" }),
      {
        ...OPTIONS,
        capabilities: { "tool.before.observe": "exact", "tool.before.input.replace": "approximate" },
        minimumCapabilityLevel: "emulated",
      },
    );
    // Required survives the floor; a lookup that missed the declaration would
    // have treated it as optional and hidden it.
    expect(observed).toEqual([true, true]);
  });

  it("rejects one capability declared under both spellings", () => {
    expect(() =>
      hook("tool.before", {
        id: "twice",
        capabilities: { block: "required", "tool.before.block": "optional" },
        async run() {},
      }),
    ).toThrow(/declares capability "tool\.before\.block" twice/);
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
    expect(result.errors[0]?.code).toBe("HN401");
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
    expect(result.errors).toEqual([expect.objectContaining({ hookId: "cyclic-rewrite", kind: "unsupported-effect" })]);
    expect(result.errors[0]?.code).toBe("HN401");
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
    expect(result.errors).toEqual([expect.objectContaining({ hookId: "hostile-output", kind: "unsupported-effect" })]);
    expect(result.errors[0]?.code).toBe("HN401");
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

    expect(result.errors).toEqual([expect.objectContaining({ hookId: "hostile-effect", kind: "unsupported-effect" })]);
    expect(result.errors[0]?.code).toBe("HN401");
    expect(result.errors[0]?.message).toContain("uninspectable thrown value");
    expect(ran).toEqual(["after"]);
  });
});

describe("shell view coherence across rewrites", () => {
  const codec = shellCodec({ Bash: { commandKey: "command" } });

  function shellEvent(): ToolBeforeEvent {
    const event = toolBefore({ command: "npm install" });
    const shell = codec.classify("Bash", event.tool.input);
    if (shell !== undefined) event.tool.shell = shell;
    return event;
  }

  it("re-derives tool.shell after a replaceInput so a later guard sees the rewritten command", async () => {
    // The staleness this pins: shell is derived once at decode time, so
    // without re-derivation a rewrite could smuggle a command past a later
    // guard hook reading event.tool.shell.command.
    const seen: (string | undefined)[] = [];
    const hooks = [
      hook("tool.before", {
        id: "rewriter",
        capabilities: { "tool.before.input.replace": "required" },
        async run() {
          return replaceInput({ command: "pnpm install" });
        },
      }),
      hook("tool.before", {
        id: "guard",
        async run(event) {
          seen.push(event.tool.shell?.command);
        },
      }),
    ];
    const event = shellEvent();
    await dispatch(hooks, event, { ...OPTIONS, shellCodec: codec });
    expect(seen).toEqual(["pnpm install"]);
    expect(event.tool.shell?.command).toBe("pnpm install");
  });

  it("drops tool.shell rather than leaving it stale when no codec was supplied", async () => {
    const hooks = [
      hook("tool.before", {
        id: "rewriter",
        capabilities: { "tool.before.input.replace": "required" },
        async run() {
          return replaceInput({ command: "pnpm install" });
        },
      }),
    ];
    const event = shellEvent();
    await dispatch(hooks, event, OPTIONS);
    // Absence tells a later reader to fall back to input; a stale value
    // would tell it a lie.
    expect(event.tool.shell).toBeUndefined();
    expect(event.tool.input).toEqual({ command: "pnpm install" });
  });

  it("drops tool.shell when the replacement input no longer classifies", async () => {
    const hooks = [
      hook("tool.before", {
        id: "rewriter",
        capabilities: { "tool.before.input.replace": "required" },
        async run() {
          return replaceInput({ notACommand: true });
        },
      }),
    ];
    const event = shellEvent();
    await dispatch(hooks, event, { ...OPTIONS, shellCodec: codec });
    expect(event.tool.shell).toBeUndefined();
  });
});

describe("file view coherence across rewrites (ADR-0026)", () => {
  const codec = fileCodec({ Read: { pathKey: "file_path" } });

  function readEvent(path: string): ToolBeforeEvent {
    const event = toolBefore({ file_path: path });
    event.tool = { kind: "file.read", nativeName: "Read", input: event.tool.input };
    event.tool.file = codec.classify("Read", event.tool.input)!;
    return event;
  }

  it("re-derives tool.file after a replaceInput so a later guard sees the rewritten path", async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const event = readEvent("notes.txt");
    await dispatch(
      [
        hook("tool.before", {
          id: "rewriter",
          capabilities: { "input.replace": "required" },
          async run() {
            return replaceInput({ file_path: ".env" });
          },
        }),
        hook("tool.before", {
          id: "guard",
          async run(guarded) {
            seen.push(guarded.tool.file?.paths);
          },
        }),
      ],
      event,
      { ...OPTIONS, fileCodec: codec },
    );
    // Without re-derivation the guard would read "notes.txt" while .env is read.
    expect(seen).toEqual([[".env"]]);
  });

  it("drops tool.file when no codec was supplied or the input no longer classifies", async () => {
    const rewrite = (input: unknown) => [
      hook("tool.before", {
        id: "rewriter",
        capabilities: { "input.replace": "required" },
        async run() {
          return replaceInput(input);
        },
      }),
    ];
    const uncodec = readEvent("notes.txt");
    await dispatch(rewrite({ file_path: ".env" }), uncodec, OPTIONS);
    expect(uncodec.tool.file).toBeUndefined();

    const mismatched = readEvent("notes.txt");
    await dispatch(rewrite({ path: ".env" }), mismatched, { ...OPTIONS, fileCodec: codec });
    expect(mismatched.tool.file).toBeUndefined();
  });
});

describe("updateShell lowering", () => {
  const codexish = shellCodec({
    Bash: { commandKey: "command" },
    exec_command: { commandKey: "cmd", cwdKey: "workdir" },
  });

  function execCommandEvent(): ToolBeforeEvent {
    const event = toolBefore({ cmd: "npm install", workdir: "C:/proj", login: false });
    event.tool.nativeName = "exec_command";
    const shell = codexish.classify("exec_command", event.tool.input);
    if (shell !== undefined) event.tool.shell = shell;
    return event;
  }

  const rewriter = hook("tool.before", {
    id: "rewriter",
    capabilities: { "tool.before.input.replace": "required" },
    async run() {
      return updateShell({ command: "pnpm install" });
    },
  });

  it("lowers to the native key of whichever tool the event carries", async () => {
    // One hook body, two shapes: the same updateShell lands under `cmd` for
    // exec_command and `command` for Bash -- the portability replaceInput
    // could not offer.
    const execEvent = execCommandEvent();
    await dispatch([rewriter], execEvent, { ...OPTIONS, shellCodec: codexish });
    expect(execEvent.tool.input).toEqual({
      cmd: "pnpm install",
      workdir: "C:/proj",
      login: false,
    });
    expect(execEvent.tool.shell?.command).toBe("pnpm install");

    const bashEvent = toolBefore({ command: "npm install" });
    await dispatch([rewriter], bashEvent, { ...OPTIONS, shellCodec: codexish });
    expect(bashEvent.tool.input).toEqual({ command: "pnpm install" });
  });

  it("records the portable effect and its lowering as adjacent entries", async () => {
    const event = execCommandEvent();
    const result = await dispatch([rewriter], event, { ...OPTIONS, shellCodec: codexish });
    expect(result.effects).toEqual([
      { hookId: "rewriter", effect: { kind: "updateShell", command: "pnpm install" } },
      {
        hookId: "rewriter",
        effect: {
          kind: "replaceInput",
          input: { cmd: "pnpm install", workdir: "C:/proj", login: false },
        },
        loweredFrom: "updateShell",
      },
    ]);
    // Adapters resolve the last replaceInput; the lowered entry is one.
    expect(replacedInput(result)).toEqual({
      value: { cmd: "pnpm install", workdir: "C:/proj", login: false },
    });
  });

  it("rejects updateShell for an uncaptured tool shape as HN401", async () => {
    const event = toolBefore({ someKey: "echo x" });
    event.tool.nativeName = "shell"; // classified shell-kind, shape never captured
    const result = await dispatch([rewriter], event, { ...OPTIONS, shellCodec: codexish });
    expect(result.effects).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: "unsupported-effect", code: "HN401" });
    expect(result.errors[0]!.message).toContain("event.tool.shell");
    expect(event.tool.input).toEqual({ someKey: "echo x" }); // untouched
  });

  it("rejects updateShell when no codec was supplied", async () => {
    const result = await dispatch([rewriter], toolBefore({ command: "x" }), OPTIONS);
    expect(result.effects).toEqual([]);
    expect(result.errors[0]).toMatchObject({ code: "HN401" });
  });

  it("rejects updateShell without the input.replace declaration", async () => {
    const undeclared = hook("tool.before", {
      id: "undeclared",
      async run() {
        return updateShell({ command: "y" }) as never;
      },
    });
    const result = await dispatch([undeclared], toolBefore({ command: "x" }), {
      ...OPTIONS,
      shellCodec: codexish,
    });
    expect(result.errors[0]!.message).toContain("without declaring");
  });

  it("composes with replaceInput in either order, last write winning", async () => {
    const rawRewriter = hook("tool.before", {
      id: "raw",
      capabilities: { "tool.before.input.replace": "required" },
      async run() {
        return replaceInput({ cmd: "yarn install", workdir: "C:/other" });
      },
    });

    // updateShell then replaceInput: the later raw replace wins wholesale.
    let event = execCommandEvent();
    let result = await dispatch([rewriter, rawRewriter], event, {
      ...OPTIONS,
      shellCodec: codexish,
    });
    expect(replacedInput(result)).toEqual({
      value: { cmd: "yarn install", workdir: "C:/other" },
    });

    // replaceInput then updateShell: the patch merges into the REPLACED input,
    // because tool.input and tool.shell were re-derived before it ran.
    event = execCommandEvent();
    result = await dispatch([rawRewriter, rewriter], event, {
      ...OPTIONS,
      shellCodec: codexish,
    });
    expect(replacedInput(result)).toEqual({
      value: { cmd: "pnpm install", workdir: "C:/other" },
    });
  });

  it("is HN401 after an earlier replaceInput leaves the input unclassifiable", async () => {
    const breaker = hook("tool.before", {
      id: "breaker",
      capabilities: { "tool.before.input.replace": "required" },
      async run() {
        return replaceInput({ notCmd: true });
      },
    });
    const event = execCommandEvent();
    const result = await dispatch([breaker, rewriter], event, {
      ...OPTIONS,
      shellCodec: codexish,
    });
    // The later hook could have detected this: event.tool.shell was deleted
    // when the replacement stopped classifying.
    expect(result.errors[0]).toMatchObject({ hookId: "rewriter", code: "HN401" });
    expect(event.tool.input).toEqual({ notCmd: true });
  });
});

describe("updateShell under policy edges", () => {
  const codec = shellCodec({ Bash: { commandKey: "command" } });
  const rewriter = hook("tool.before", {
    id: "rewriter",
    capabilities: { "tool.before.input.replace": "required" },
    async run() {
      return updateShell({ command: "pnpm install" });
    },
  });

  it("synthesizes a terminal block when lowering fails under onHookError: block", async () => {
    const event = toolBefore({ someKey: "x" });
    event.tool.nativeName = "shell"; // uncaptured shape -> lowering fails
    const after = hook("tool.before", {
      id: "after",
      async run() {
        throw new Error("must not run past a terminal failure");
      },
    });
    const result = await dispatch([rewriter, after], event, {
      ...OPTIONS,
      shellCodec: codec,
      policy: { onHookError: "block" },
    });
    expect(result.terminatedBy).toBe("rewriter");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: "unsupported-effect", code: "HN401" });
    // The synthesized terminal is the last effect, preserving the invariant
    // every apply() relies on.
    expect(result.effects[result.effects.length - 1]?.effect.kind).toBe("block");
  });

  it("is clamped by the minimum capability floor before the codec is consulted", async () => {
    const optionalRewriter = hook("tool.before", {
      id: "optional-rewriter",
      capabilities: { "tool.before.input.replace": "optional" },
      async run(event, ctx) {
        // Contract-following hook: feature-detect, then rewrite.
        if (!ctx.capabilities.has("tool.before.input.replace")) return;
        if (event.tool.shell === undefined) return;
        return updateShell({ command: "pnpm install" });
      },
    });
    const event = toolBefore({ command: "npm install" });
    const shell = codec.classify("Bash", event.tool.input);
    if (shell !== undefined) event.tool.shell = shell;
    const result = await dispatch([optionalRewriter], event, {
      ...OPTIONS,
      shellCodec: codec,
      capabilities: { ...FULL, "tool.before.input.replace": "approximate" },
      minimumCapabilityLevel: "exact",
    });
    // The floor hides the optional capability, the hook declines, nothing
    // is rewritten and nothing errors.
    expect(result.effects).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(event.tool.input).toEqual({ command: "npm install" });
  });

  it("keeps the terminal effect last when a lowering precedes it", async () => {
    const guard = hook("tool.before", {
      id: "guard",
      capabilities: { "tool.before.block": "required" },
      async run() {
        return block("no");
      },
    });
    const event = toolBefore({ command: "npm install" });
    const shell = codec.classify("Bash", event.tool.input);
    if (shell !== undefined) event.tool.shell = shell;
    const result = await dispatch([rewriter, guard], event, {
      ...OPTIONS,
      shellCodec: codec,
    });
    // updateShell pushes TWO entries; the invariant "effects[last] is the
    // terminal" is what all three apply() reducers rely on.
    expect(result.effects.map((e) => e.effect.kind)).toEqual(["updateShell", "replaceInput", "block"]);
    expect(result.terminatedBy).toBe("guard");
    expect(terminalEffect(result)?.kind).toBe("block");
  });
});

describe("plugin context (ADR-0020)", () => {
  it("hands each hook its own copy of the plugin root, and none without a package", async () => {
    const seen: (string | undefined)[] = [];
    const hooks = [
      hook("turn.stop", {
        id: "mover",
        async run(_event, ctx) {
          seen.push(ctx.plugin?.root);
          if (ctx.plugin) ctx.plugin.root = "C:/elsewhere";
        },
      }),
      hook("turn.stop", {
        id: "reader",
        async run(_event, ctx) {
          seen.push(ctx.plugin?.root);
        },
      }),
    ];
    const plugin = { root: "C:/plugins/rooted" };
    await dispatch(hooks, turnStop(), { ...OPTIONS, plugin });
    // A handler that moves the root moves it for itself only.
    expect(seen).toEqual(["C:/plugins/rooted", "C:/plugins/rooted"]);
    expect(plugin.root).toBe("C:/plugins/rooted");

    seen.length = 0;
    await dispatch(hooks, turnStop(), OPTIONS);
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe("agent-scoped hooks (ADR-0029)", () => {
  const inAgent = (agentType?: string): ToolBeforeEvent => {
    const event = toolBefore({ command: "ls" });
    if (agentType !== undefined) event.correlation.agentType = agentType;
    return event;
  };
  const ran: string[] = [];
  const hooks = [
    hook("tool.before", {
      id: "reviewer-only",
      agents: { include: ["reviewer"] },
      async run() {
        ran.push("reviewer-only");
      },
    }),
    hook("tool.before", {
      id: "not-reviewer",
      agents: { exclude: ["reviewer"] },
      async run() {
        ran.push("not-reviewer");
      },
    }),
    hook("tool.before", {
      id: "everywhere",
      async run() {
        ran.push("everywhere");
      },
    }),
  ];
  const scoped = { ...OPTIONS, capabilities: { ...FULL, "tool.before.agent.identity": "exact" as const } };

  it.each([
    ["inside the named agent", "reviewer", ["reviewer-only", "everywhere"]],
    ["inside another agent", "planner", ["not-reviewer", "everywhere"]],
    // The main agent on Claude and Codex: the harness names no agent.
    ["where no agent is named", undefined, ["not-reviewer", "everywhere"]],
  ])("runs by the event's agent: %s", async (_label, agentType, expected) => {
    ran.length = 0;
    await dispatch(hooks, inAgent(agentType), scoped);
    expect(ran).toEqual(expected);
  });

  it("records the scope's requirement on the event's agent.identity capability", () => {
    expect(hooks[0]!.capabilities).toEqual({ "tool.before.agent.identity": "required" });
    expect(hooks[2]!.capabilities).toEqual({});
    expect(() =>
      hook("tool.before", {
        id: "contradiction",
        agents: { include: ["reviewer"] },
        capabilities: { "agent.identity": "optional" },
        async run() {},
      }),
    ).toThrow(/requires "tool.before.agent.identity"/);
  });
});
