import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as nodeProcess from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { finishCommandShim, guardCommandShim, HookSourceExitError } from "./command-io.js";

vi.mock("node:fs", async (original) => ({ ...(await original<Record<string, unknown>>()), writeSync: vi.fn() }));

describe("finishCommandShim", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    // A leaked exit code here would follow the whole test run out.
    process.exitCode = originalExitCode;
  });

  it("leaves the code for a draining loop rather than forcing the process down", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.useFakeTimers();

    finishCommandShim(2);

    expect(process.exitCode).toBe(2);
    // The point of the change: exiting into an in-flight socket teardown is
    // what aborted the hook, so nothing may force it on the normal path.
    expect(exit).not.toHaveBeenCalled();
  });

  it("forces the exit once the grace passes, for a handler that leaked a handle", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.useFakeTimers();

    finishCommandShim(2);
    vi.advanceTimersByTime(250);

    expect(exit).toHaveBeenCalledWith(2);
  });

  it("unrefs the fallback, so a shim that drained on its own is never delayed", () => {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const schedule = globalThis.setTimeout.bind(globalThis);
    let timer: NodeJS.Timeout | undefined;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
      timer = schedule(handler, ms);
      return timer;
    }) as never);

    finishCommandShim(0);

    // Referenced, the fallback would add its grace to every hook that ran.
    expect(timer?.hasRef()).toBe(false);
    clearTimeout(timer);
  });
});

describe("guardCommandShim", () => {
  // The guard owns these for the life of a shim process; here it gets them
  // for one test, and the worker's own listeners come back afterwards.
  const EVENTS = ["uncaughtExceptionMonitor", "uncaughtException", "unhandledRejection", "beforeExit", "exit"] as const;
  const originalExitCode = process.exitCode;
  const describeError = (error: unknown) =>
    `hooknostic internal [Test]: ${error instanceof Error ? error.message : String(error)}`;
  // As Node raises one: the monitor event, then the listeners. Node passes the
  // origin as a second argument; the typings leave it out.
  const emitUncaught = (error: unknown, origin: string): boolean => {
    const emit = process.emit as (event: string, ...args: unknown[]) => boolean;
    emit.call(process, "uncaughtExceptionMonitor", error, origin);
    return emit.call(process, "uncaughtException", error, origin);
  };
  let saved: [string, ((...args: unknown[]) => void)[]][];
  let realExit: typeof process.exit;
  let exit: ReturnType<typeof vi.fn>;
  let written: string[];

  beforeEach(() => {
    saved = EVENTS.map((event) => [event, process.rawListeners(event) as ((...args: unknown[]) => void)[]]);
    for (const event of EVENTS) process.removeAllListeners(event);
    realExit = process.exit;
    // What the guard captures as the original exit.
    exit = vi.fn();
    process.exit = exit as never;
    written = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string, callback?: () => void) => {
      written.push(chunk);
      callback?.();
      return true;
    }) as never);
  });

  afterEach(() => {
    while (process.stderr.writableCorked > 0) process.stderr.uncork();
    for (const event of EVENTS) process.removeAllListeners(event);
    for (const [event, listeners] of saved) for (const listener of listeners) process.on(event, listener);
    process.exit = realExit;
    // The guard synced the named export to its stub; bind it back to the real exit.
    syncBuiltinESMExports();
    process.exitCode = originalExitCode;
    vi.mocked(writeSync).mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("makes the hook source's process.exit throw before the decision", () => {
    guardCommandShim(describeError);

    expect(() => process.exit(2)).toThrow(new HookSourceExitError(2));
    expect(() => process.exit(2)).toThrow("the hook source called process.exit(2)");
    expect(() => process.exit()).toThrow("the hook source called process.exit()");
    expect(exit).not.toHaveBeenCalled();
  });

  it("reports the same error again in a new scope", async () => {
    const guard = guardCommandShim(describeError);
    // One error object, as a module-scope singleton rejected by every event would be.
    const error = new Error("rejected in every event");

    await guard.report(error);
    await guard.report(error);
    guard.scope();
    await guard.report(error);
    await guard.report(new HookSourceExitError(3));
    guard.scope();
    await guard.report(new HookSourceExitError(3));

    expect(written).toEqual([
      "hooknostic internal [Test]: rejected in every event\n",
      "hooknostic internal [Test]: rejected in every event\n",
      "hooknostic internal [Test]: the hook source called process.exit(3)\n",
      "hooknostic internal [Test]: the hook source called process.exit(3)\n",
    ]);
  });

  it("throws again, in a new scope, an exit code whose throw escaped before", async () => {
    const guard = guardCommandShim(describeError);

    emitUncaught(new HookSourceExitError(1), "uncaughtException");
    await new Promise<void>((resolve) => setImmediate(resolve));
    guard.scope();

    // A later event's exit(1) is that event's failure, not the earlier loop coming round.
    expect(() => process.exit(1)).toThrow(HookSourceExitError);
    expect(exit).not.toHaveBeenCalled();
  });

  it("tells onExit of every intercepted exit, whether the stub throws or leaves", () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const guard = guardCommandShim(describeError, { onExit });

    expect(() => process.exit(5)).toThrow(HookSourceExitError);
    guard.finish(0);
    process.exit(6);

    expect(onExit.mock.calls).toEqual([[5], [6]]);
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("keeps the stub's behaviour when onExit throws", () => {
    vi.useFakeTimers();
    const guard = guardCommandShim(describeError, {
      onExit() {
        throw new Error("listener failed");
      },
    });

    expect(() => process.exit(5)).toThrow(new HookSourceExitError(5));
    guard.finish(2);
    expect(() => process.exit(6)).not.toThrow();
    expect(exit.mock.calls).toEqual([[2]]);
  });

  it("binds a named `exit` import from node:process to the stub itself", () => {
    guardCommandShim(describeError);

    // Without relying on claimProtocolStdout to sync builtin exports after it.
    expect(nodeProcess.exit).toBe(process.exit);
  });

  it("after the decision, reports a hook source's exit once and leaves with the decided code", () => {
    vi.useFakeTimers();
    const guard = guardCommandShim(describeError);
    guard.finish(2);

    process.exit(1);
    process.exit(1);

    // A stray exit neither adds a block nor removes one.
    expect(exit.mock.calls).toEqual([[2], [2]]);
    // Synchronously: the process is about to go, and a pipe may be asynchronous.
    expect(vi.mocked(writeSync).mock.calls).toEqual([
      [2, "hooknostic internal [Test]: the hook source called process.exit(1)\n"],
    ]);
  });

  it("leaves with 0 rather than throwing from inside an uncaughtException emit", () => {
    guardCommandShim(describeError);
    // The hook source's own listener: a throw from it would end the process with code 7.
    process.on("uncaughtException", () => process.exit(1));

    expect(() => emitUncaught(new Error("timer threw"), "uncaughtException")).not.toThrow();

    expect(exit.mock.calls).toEqual([[0]]);
    expect(written).toEqual(["hooknostic internal [Test]: timer threw\n"]);
    expect(vi.mocked(writeSync).mock.calls).toEqual([
      [2, "hooknostic internal [Test]: the hook source called process.exit(1)\n"],
    ]);
  });

  it("leaves with 0 rather than throwing from an uncaughtException listener the hook source prepends", () => {
    guardCommandShim(describeError);
    // Ahead of every listener the guard added: only the monitor event runs earlier.
    process.prependListener("uncaughtException", () => process.exit(1));

    expect(() => emitUncaught(new Error("timer threw"), "uncaughtException")).not.toThrow();

    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("throws again from a tick a listener queued, once the emit is over", async () => {
    guardCommandShim(describeError);
    let thrown: unknown;
    process.on("uncaughtException", () =>
      process.nextTick(() => {
        try {
          process.exit(4);
        } catch (error) {
          thrown = error;
        }
      }),
    );

    // From a macrotask, as Node raises one: ticks run there before microtasks.
    // (From this async test body the microtask queue would drain first.)
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        emitUncaught(new Error("timer threw"), "uncaughtException");
        resolve();
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The guard's reset tick was queued first, so the hooks can still decide.
    expect(thrown).toBeInstanceOf(HookSourceExitError);
    expect(exit).not.toHaveBeenCalled();
  });

  it("leaves, rather than throwing again, on an exit whose throw already escaped uncaught", async () => {
    guardCommandShim(describeError);

    emitUncaught(new HookSourceExitError(1), "uncaughtException");
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The hook source is looping on exit(1); another throw would only come round again.
    expect(() => process.exit(1)).not.toThrow();
    expect(exit.mock.calls).toEqual([[0]]);
    // Another code is a new exit, and still throws.
    expect(() => process.exit(2)).toThrow(HookSourceExitError);
  });

  it("leaves with 0 rather than throwing from a beforeExit listener before the decision", () => {
    guardCommandShim(describeError);
    process.on("beforeExit", () => process.exit(3));

    // A throw would empty the loop again, and beforeExit would come round forever.
    expect(() => process.emit("beforeExit", 0)).not.toThrow();

    expect(exit.mock.calls).toEqual([[0]]);
    expect(vi.mocked(writeSync).mock.calls).toEqual([
      [2, "hooknostic internal [Test]: the hook source called process.exit(3)\n"],
    ]);
  });

  it("leaves with the decided code, not 0, when the hook source ends the process before finish", () => {
    const guard = guardCommandShim(describeError);
    process.on("uncaughtException", () => process.exit(1));

    guard.decide(2);
    emitUncaught(new Error("timer threw after the decision"), "uncaughtException");

    // A block the hooks decided stays one.
    expect(exit.mock.calls).toEqual([[2]]);
  });

  it("pins the decided code after the hook source's exit listener when the stub leaves before finish", () => {
    const guard = guardCommandShim(describeError);
    // Added after the guard, so it would run after the pin.
    process.on("exit", () => {
      process.exitCode = 0;
    });
    process.on("uncaughtException", () => process.exit(1));

    guard.decide(2);
    emitUncaught(new Error("timer threw after the decision"), "uncaughtException");
    expect(exit.mock.calls).toEqual([[2]]);
    // What the real exit does next: run the exit listeners, then leave with process.exitCode.
    process.emit("exit", 2);

    expect(process.exitCode).toBe(2);
  });

  it("pins the decided code after the hook source's exit listener when the loop empties before finish", () => {
    const guard = guardCommandShim(describeError);
    process.on("exit", () => {
      process.exitCode = 0;
    });

    guard.decide(2);
    // An unsettled top-level await: the loop empties, so Node emits beforeExit, then exit.
    process.emit("beforeExit", 0);
    process.emit("exit", 13);

    expect(process.exitCode).toBe(2);
  });

  it("still throws from the stub between the decision and finish, so the reply can flush", () => {
    const guard = guardCommandShim(describeError);

    guard.decide(2);

    expect(() => process.exit(1)).toThrow(HookSourceExitError);
    expect(exit).not.toHaveBeenCalled();
  });

  it("finishes with the decided code by default", () => {
    vi.useFakeTimers();
    const guard = guardCommandShim(describeError);

    guard.decide(2);
    guard.finish();
    vi.advanceTimersByTime(250);

    expect(process.exitCode).toBe(2);
    expect(exit.mock.calls).toEqual([[2]]);
  });

  it("uncorks stderr before writing, so a corked handler cannot hold back a report", async () => {
    const guard = guardCommandShim(describeError);
    process.stderr.cork();

    await guard.write("blocked on purpose");

    expect(process.stderr.writableCorked).toBe(0);
    expect(written).toEqual(["blocked on purpose"]);
  });

  it("leaves with 0 rather than throwing from an exit listener", () => {
    guardCommandShim(describeError);
    process.on("exit", () => process.exit(3));

    expect(() => process.emit("exit", 0)).not.toThrow();

    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("reports a rejection once when strict mode raises it as an uncaught exception too", () => {
    guardCommandShim(describeError);

    // --unhandled-rejections=strict raises a wrapper first, then emits the reason.
    emitUncaught(new Error("wrapped plain reason"), "unhandledRejection");
    process.emit("unhandledRejection", "plain reason", Promise.resolve());

    expect(written).toEqual(["hooknostic internal [Test]: plain reason\n"]);
  });

  it("reports a rejection raised as an uncaught exception once the hook source removed the rejection listener", () => {
    guardCommandShim(describeError);
    process.removeAllListeners("unhandledRejection");

    // With no listener left, Node raises the rejection as an uncaught exception only.
    emitUncaught(new Error("rejected with no listener left"), "unhandledRejection");

    expect(written).toEqual(["hooknostic internal [Test]: rejected with no listener left\n"]);
  });

  it("reports each error once", async () => {
    const guard = guardCommandShim(describeError);
    const error = new Error("rejected twice over");

    process.emit("unhandledRejection", error, Promise.resolve());
    await guard.report(error);

    expect(written).toEqual(["hooknostic internal [Test]: rejected twice over\n"]);
  });

  it("reports a hook source's exit once per exit code, though each call throws a new error", async () => {
    const guard = guardCommandShim(describeError);

    await guard.report(new HookSourceExitError(3));
    await guard.report(new HookSourceExitError(3));
    await guard.report(new HookSourceExitError(1));

    expect(written).toEqual([
      "hooknostic internal [Test]: the hook source called process.exit(3)\n",
      "hooknostic internal [Test]: the hook source called process.exit(1)\n",
    ]);
  });

  it("starts a report on a line of its own after a write that ended mid-line", async () => {
    const guard = guardCommandShim(describeError);

    // Claude's block reason need not end in a newline.
    await guard.write("blocked on purpose");
    await guard.report(new Error("rejected after a block"));

    expect(written.join("")).toBe("blocked on purpose\nhooknostic internal [Test]: rejected after a block\n");
  });

  it("pins the decided exit code after exit listeners the hook source added while it loaded", () => {
    vi.useFakeTimers();
    const guard = guardCommandShim(describeError);
    process.on("exit", () => {
      process.exitCode = 3;
    });

    guard.finish(2);
    process.emit("exit", 2);

    expect(process.exitCode).toBe(2);
  });

  it("forces a leaked handle's exit with the original process.exit, unreported", () => {
    vi.useFakeTimers();
    const guard = guardCommandShim(describeError);

    guard.finish(0);
    vi.advanceTimersByTime(250);

    expect(exit.mock.calls).toEqual([[0]]);
    expect(writeSync).not.toHaveBeenCalled();
  });

  it("never throws or rejects when describing the error throws", async () => {
    const guard = guardCommandShim(() => {
      throw new Error("describe failed");
    });

    expect(() => process.emit("unhandledRejection", new Error("rejected"), Promise.resolve())).not.toThrow();
    await expect(guard.report(new Error("reported"))).resolves.toBeUndefined();
    expect(written).toEqual([]);
  });
});
