import { afterEach, describe, expect, it, vi } from "vitest";

import { finishCommandShim } from "./command-io.js";

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
