import { Console } from "node:console";
import { Writable } from "node:stream";

import type { HookEvent, HookResult } from "@hooknostic/sdk";

/**
 * Reserve stdout for a command hook's protocol reply. Everything else written
 * through `process.stdout` or the global console afterwards goes to stderr,
 * because Claude and Codex read stdout as the hook's JSON answer and a stray
 * line turns a block into plain text the harness ignores.
 *
 * Returns the only writer that still reaches stdout. Output written at module
 * top level, before this runs, and child processes that inherit stdout are
 * not covered.
 */
export function claimProtocolStdout(): (contents: string) => Promise<void> {
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
  Object.defineProperty(process, "stdout", { value: redirected, configurable: true, enumerable: true, writable: true });
  // The global console binds its stream on first use, possibly before this ran.
  globalThis.console = new Console({ stdout: redirected, stderr });
  return (contents) =>
    new Promise<void>((resolve, reject) => {
      protocol.write(contents, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
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
