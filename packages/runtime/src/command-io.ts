import { Console } from "node:console";
import { syncBuiltinESMExports } from "node:module";
import { Writable } from "node:stream";

import type { HookEvent, HookResult, PluginSpec } from "@hooknostic/sdk";

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

// Well inside the 1s process allowance nativeTimeoutSeconds adds to every hook budget.
const RELEASE_BOUND_MS = 500;

// The rest of that allowance, for the fallback below. A shim that drains on its
// own never waits it out.
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
export function finishCommandShim(exitCode: number): void {
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), DRAIN_GRACE_MS).unref();
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
  const flag = env["HOOKNOSTIC_DEBUG"];
  if (flag === undefined || flag === "" || flag === "0") return undefined;
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
