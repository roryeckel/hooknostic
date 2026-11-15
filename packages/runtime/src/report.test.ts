import { afterEach, describe, expect, it, vi } from "vitest";

import { debugTracer } from "./command-io.js";
import { debugEnabled, errorMessage, formatInternalError, isInstance, reportInternalError } from "./report.js";

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** An Error whose message getter returns a string once, then a revoked proxy. */
function flippingMessage(): Error {
  const error = new Error("unused");
  let reads = 0;
  Object.defineProperty(error, "message", { get: () => (reads++ === 0 ? "first read" : revokedProxy()) });
  return error;
}

describe("errorMessage", () => {
  it("reads an Error's message once, so a getter cannot pass the check and then return a hostile value", () => {
    // Two reads would return the revoked proxy, and interpolating it throws.
    expect(typeof errorMessage(flippingMessage())).toBe("string");
    expect(formatInternalError(flippingMessage(), { hook: "prompt" })).toBe("hooknostic internal [prompt]: first read");
  });
});

describe("formatInternalError", () => {
  it("names the hook and the error's message on one line", () => {
    expect(formatInternalError(new TypeError("Cannot delete property 'command'"), { hook: "execute.before" })).toBe(
      "hooknostic internal [execute.before]: Cannot delete property 'command'",
    );
  });

  it("omits the brackets without a hook", () => {
    expect(formatInternalError(new Error("boom"))).toBe("hooknostic internal: boom");
  });

  it("renders a thrown string as itself", () => {
    expect(formatInternalError("plain string", { hook: "event" })).toBe("hooknostic internal [event]: plain string");
  });

  it("survives a revoked proxy, whose instanceof check and String() both throw", () => {
    expect(formatInternalError(revokedProxy(), { hook: "prompt", stack: true })).toBe(
      "hooknostic internal [prompt]: uninspectable thrown value",
    );
  });

  it("appends the stack on the following lines only when asked", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at frame (shim.js:1:1)";
    expect(formatInternalError(error, { hook: "title" })).toBe("hooknostic internal [title]: boom");
    expect(formatInternalError(error, { hook: "title", stack: true })).toBe(
      "hooknostic internal [title]: boom\nError: boom\n    at frame (shim.js:1:1)",
    );
  });

  it("keeps the line when reading the stack throws", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("hostile stack");
      },
    });
    expect(formatInternalError(error, { stack: true })).toBe("hooknostic internal: boom");
  });
});

describe("reportInternalError", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes one line through the given writer", () => {
    vi.stubEnv("HOOKNOSTIC_DEBUG", "");
    const lines: string[] = [];
    reportInternalError(new Error("boom"), "generate", (line) => lines.push(line));
    expect(lines).toEqual(["hooknostic internal [generate]: boom"]);
  });

  it("defaults to console.error", () => {
    vi.stubEnv("HOOKNOSTIC_DEBUG", "0");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportInternalError(new Error("boom"), "evaluate");
    expect(spy.mock.calls).toEqual([["hooknostic internal [evaluate]: boom"]]);
  });

  it("follows with the stack under HOOKNOSTIC_DEBUG", () => {
    vi.stubEnv("HOOKNOSTIC_DEBUG", "1");
    const error = new Error("boom");
    error.stack = "Error: boom\n    at frame (shim.js:1:1)";
    const lines: string[] = [];
    reportInternalError(error, "compaction", (line) => lines.push(line));
    expect(lines).toEqual(["hooknostic internal [compaction]: boom\nError: boom\n    at frame (shim.js:1:1)"]);
  });

  it("never throws, even when the writer does", () => {
    expect(() =>
      reportInternalError(new Error("boom"), "event", () => {
        throw new Error("console is gone");
      }),
    ).not.toThrow();
  });
});

describe("isInstance", () => {
  class Base extends Error {}
  class Derived extends Base {}

  it("answers as instanceof does", () => {
    expect(isInstance(new Derived(), Base)).toBe(true);
    expect(isInstance(new Base(), Derived)).toBe(false);
    expect(isInstance(new Error("x"), Base)).toBe(false);
    expect(isInstance("plain string", Base)).toBe(false);
    expect(isInstance(undefined, Base)).toBe(false);
  });

  it("answers false, rather than throwing, for a revoked proxy", () => {
    const proxy = revokedProxy();
    expect(() => proxy instanceof Base).toThrow(TypeError);
    expect(isInstance(proxy, Base)).toBe(false);
  });
});

describe("debugEnabled", () => {
  it("is the predicate debugTracer uses", () => {
    for (const flag of [undefined, "", "0", "1", "yes"]) {
      const env = flag === undefined ? {} : { HOOKNOSTIC_DEBUG: flag };
      expect(debugEnabled(env)).toBe(flag !== undefined && flag !== "" && flag !== "0");
      expect(debugTracer(env) !== undefined).toBe(debugEnabled(env));
    }
  });
});
