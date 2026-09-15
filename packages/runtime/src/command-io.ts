import { Console } from "node:console";
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
  /** Flush output redirected to stderr; call before exiting. */
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
  // A handler writing after release, or after its own end(), must not crash the shim.
  redirected.on("error", () => {});
  Object.defineProperty(process, "stdout", { value: redirected, configurable: true, enumerable: true, writable: true });
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
    release: () =>
      new Promise<void>((resolve) => {
        if (redirected.writableFinished) return resolve();
        redirected.once("finish", resolve);
        redirected.once("close", resolve);
        if (!redirected.writableEnded) redirected.end();
      }),
  };
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
