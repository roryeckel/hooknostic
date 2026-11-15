import { Console } from "node:console";
import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Writable } from "node:stream";

import type { HookEvent, HookResult, PluginSpec } from "@hooknostic/sdk";

import { debugEnabled } from "./report.js";

/** What a command shim is given: the plugin, or a loader it calls once stdout is claimed. */
export type CommandPluginSource = PluginSpec | (() => Promise<{ default: PluginSpec }>);

export async function loadCommandPlugin(source: CommandPluginSource): Promise<PluginSpec> {
  return typeof source === "function" ? (await source()).default : source;
}

export interface ProtocolStdout {
  /** Write the reply to the real stdout. */
  writeReply(contents: string): Promise<void>;
  /** Flush redirected output and pending stderr writes; call before exiting. */
  release(): Promise<void>;
}

/**
 * Reserve stdout for a command hook's protocol reply. Claude and Codex parse
 * stdout as the hook's JSON answer, so anything else there stops the reply
 * parsing. `process.stdout` and the global console are redirected to stderr;
 * claim before loading the plugin so references captured at module scope are
 * the redirect too. Child processes that inherit stdout are not covered.
 */
export function claimProtocolStdout(): ProtocolStdout {
  const protocol = process.stdout;
  const stderr = process.stderr;
  // A stream of its own rather than a patched write: end(), pipe() and drain
  // stay coherent for callers, and ending it leaves stderr and the reply open.
  const redirected = new Writable({
    decodeStrings: false,
    write(chunk, encoding, callback) {
      stderr.write(chunk, encoding, callback);
    },
  });
  // A handler that ends or breaks either stream must not crash the shim.
  redirected.on("error", () => {});
  stderr.on("error", () => {});
  Object.defineProperty(process, "stdout", { value: redirected, configurable: true, enumerable: true, writable: true });
  // `import { stdout } from "node:process"` is a live binding set at startup.
  syncBuiltinESMExports();
  // The global console binds its stream on first use, possibly before this ran.
  globalThis.console = new Console({ stdout: redirected, stderr });
  return {
    writeReply: (contents) =>
      new Promise<void>((resolve, reject) => {
        protocol.write(contents, (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    release: async () => {
      // Best effort and bounded: a handler may have corked, ended, or destroyed stderr.
      while (stderr.writableCorked > 0) stderr.uncork();
      await bounded(
        new Promise<void>((resolve) => {
          if (redirected.writableFinished || redirected.destroyed) return resolve();
          redirected.once("finish", resolve);
          redirected.once("close", resolve);
          if (!redirected.writableEnded) redirected.end();
        }),
      );
      if (stderr.writableEnded || stderr.destroyed) return;
      // Write callbacks fire in order, so this waits out every earlier stderr
      // write, debug traces included.
      await bounded(new Promise<void>((resolve) => stderr.write("", () => resolve())));
    },
  };
}

// Well inside the process allowance nativeTimeoutSeconds adds to every event's
// handler budgets (runtime.processAllowanceMs, ADR-0039).
const RELEASE_BOUND_MS = 500;

// Drain time inside that allowance, for the fallback below. A shim that drains
// on its own never waits it out.
const DRAIN_GRACE_MS = 250;

/**
 * Leave the process with `exitCode`, by draining the event loop rather than by
 * forcing it.
 *
 * `process.exit()` here aborted the hook outright on the one path that did a
 * network call. Node's `fetch` returns its sockets to a pool that is still
 * closing when the shim returns, and exiting into that teardown trips a libuv
 * assertion on Windows -- `!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`.
 * The reply is already on stdout by then, so the harness reads a well-formed
 * payload beside an abort's exit code: a hook that only looks failed, and only
 * when it had something to say.
 *
 * The forced exit stays as a fallback, because a handler that leaks a handle
 * must not hold the hook open until the harness kills it. The timer is
 * unref'd, so it fires only when something else is still keeping the loop
 * alive -- exactly the leak -- and cannot delay a shim that already drained.
 */
export function finishCommandShim(exitCode: number, exit: (code: number) => void = process.exit): void {
  process.exitCode = exitCode;
  setTimeout(() => exit(exitCode), DRAIN_GRACE_MS).unref();
}

/** What the hook source's `process.exit(n)` throws while a command shim owns the process. */
export class HookSourceExitError extends Error {
  readonly code: unknown;

  constructor(code: unknown) {
    super(`the hook source called process.exit(${exitCodeText(code)})`);
    this.name = "HookSourceExitError";
    this.code = code;
  }
}

function exitCodeText(code: unknown): string {
  try {
    return code === undefined ? "" : String(code);
  } catch {
    return "?";
  }
}

export interface CommandShimGuard {
  /** Write to stderr and wait for the flush; a stream a handler ended or destroyed is skipped. */
  write(text: string): Promise<void>;
  /** Report `error` on its own line, once per error. Never rejects. */
  report(error: unknown): Promise<void>;
  /** Leave with `exitCode`. A stray failure after this keeps that code. */
  finish(exitCode: number): void;
}

/**
 * Own the process for a command shim, against a hook source that does not
 * expect to share it (#186). Install it first and leave it for the life of
 * the process.
 *
 * - An unhandled rejection or uncaught exception is reported once, through
 *   `describe`, and the shim carries on: before the decision the hooks still
 *   decide, after it the decided exit code stands.
 * - `process.exit` throws a `HookSourceExitError`, so a load-time exit is
 *   reported like a load error and one inside a handler is that handler's
 *   error. Where a throw cannot unwind -- inside an uncaughtException emit,
 *   during `beforeExit` or `exit`, after the decision -- it reports and
 *   leaves with the decided code, or 0 before one.
 * - An `exit` listener pins the exit code to the decided code, or 0 before
 *   one, over `process.exitCode` set by the hook source and over code 13 for
 *   an unsettled top-level await.
 *
 * Not covered: `process.reallyExit`, `process.kill(process.pid)`,
 * `process.abort()`, and `exit` listeners added after `finish`.
 */
export function guardCommandShim(describe: (error: unknown) => string): CommandShimGuard {
  const exit = process.exit;
  const stderr = process.stderr;
  let decided: number | undefined;
  // Whether stderr, as far as this guard wrote it, ended mid-line: Claude's
  // block reason need not end in a newline, and a report must start its own.
  let midLine = false;
  // A throw cannot unwind inside an uncaughtException emit (Node exits 7), in
  // a beforeExit loop, or once the process is leaving.
  let cannotUnwind = false;
  const reported = new Set<unknown>();

  const write = async (text: string): Promise<void> => {
    if (text === "") return;
    midLine = !text.endsWith("\n");
    try {
      if (stderr.writableEnded || stderr.destroyed) return;
      await new Promise<void>((resolve) => {
        stderr.write(text, () => resolve());
      });
    } catch {
      // A handler may have broken stderr in a way the checks above miss.
    }
  };
  const line = (error: unknown): string | undefined => {
    try {
      return `${midLine ? "\n" : ""}${describe(error)}\n`;
    } catch {
      return undefined;
    }
  };
  const firstTime = (key: unknown): boolean => {
    if (reported.has(key)) return false;
    reported.add(key);
    return true;
  };
  const report = async (error: unknown): Promise<void> => {
    if (!firstTime(error)) return;
    const text = line(error);
    if (text !== undefined) await write(text);
  };
  // The process is about to go: an asynchronous pipe write would be lost.
  const reportNow = (error: unknown, key: unknown): void => {
    if (!firstTime(key)) return;
    const text = line(error);
    if (text === undefined) return;
    midLine = false;
    try {
      writeSync(2, text);
    } catch {
      // Nowhere left to report it.
    }
  };
  const pin = (): void => {
    try {
      process.exitCode = decided ?? 0;
    } catch {
      // Listeners must never throw.
    }
  };

  // Set for the length of an emit, and reset once its listeners have run.
  // A callback the hook source defers past the emit but ahead of the reset,
  // such as process.nextTick(() => process.exit(1)), still sees it set and
  // leaves with the decided code or 0 instead of throwing: it fails open.
  const holdUnwind = (): void => {
    cannotUnwind = true;
    queueMicrotask(() => {
      cannotUnwind = false;
    });
  };
  // The monitor event runs before every uncaughtException listener, including
  // one the hook source prepends, in normal and strict rejection modes alike.
  process.on("uncaughtExceptionMonitor", holdUnwind);
  // Before the decision, beforeExit means the shim's own await can never
  // settle: a throw here would only empty the loop again, so leave instead.
  process.prependListener("beforeExit", holdUnwind);
  const onRejection = (reason: unknown): void => {
    void report(reason);
  };
  process.on("uncaughtException", (error, origin) => {
    // Under --unhandled-rejections=strict a rejection is raised here first,
    // then emitted as one; report it there, once. If the hook source removed
    // that listener, this is the only sight of it.
    if (origin !== "unhandledRejection" || !process.listeners("unhandledRejection").includes(onRejection))
      void report(error);
  });
  process.on("unhandledRejection", onRejection);
  process.exit = function exitFromHookSource(code?: number | string | null): never {
    const error = new HookSourceExitError(code);
    if (!cannotUnwind && decided === undefined) throw error;
    reportNow(error, `exit:${exitCodeText(code)}`);
    return exit(decided ?? 0);
  } as typeof process.exit;
  process.prependListener("exit", () => {
    cannotUnwind = true;
  });
  process.on("exit", pin);

  return {
    write,
    report,
    finish(exitCode) {
      decided = exitCode;
      // Last again, after any 'exit' listener the hook source added while it loaded.
      process.off("exit", pin);
      process.on("exit", pin);
      finishCommandShim(exitCode, exit);
    },
  };
}

/**
 * Settles when `work` does, or after the release bound. The timer stays
 * referenced: with a stuck stream nothing else may keep the event loop alive,
 * and an unsettled top-level await would end the process with exit code 13.
 */
function bounded(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RELEASE_BOUND_MS);
    }),
  ]);
}

/** A stderr tracer when `HOOKNOSTIC_DEBUG` is set to a non-empty value other than `0`. */
export function debugTracer(env: NodeJS.ProcessEnv = process.env): ((message: string) => void) | undefined {
  if (!debugEnabled(env)) return undefined;
  return (message) => {
    process.stderr.write(`hooknostic debug: ${message}\n`);
  };
}

/** One line naming the native event, the portable event, and the tool it concerns. */
export function describeDecodedEvent(event: HookEvent): string {
  const tool = "tool" in event ? ` (${event.tool.kind} ${event.tool.nativeName})` : "";
  return `${event.harness.nativeEvent} -> ${event.event}${tool}`;
}

/** One line summarizing what a dispatch did. */
export function describeHookResult(result: HookResult): string {
  const effects = result.effects.map((applied) => `${applied.hookId}:${applied.effect.kind}`).join(", ");
  const terminated = result.terminatedBy === undefined ? "" : `, terminated by ${result.terminatedBy}`;
  const errors = `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`;
  return `effects [${effects}]${terminated}, ${errors}`;
}
