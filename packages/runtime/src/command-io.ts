import type { HookEvent, HookResult } from "@hooknostic/sdk";

/**
 * Reserve stdout for a command hook's protocol reply. Everything else written
 * to `process.stdout` afterwards -- a handler's `console.log` included -- goes to
 * stderr, because Claude and Codex read stdout as the hook's JSON answer and a
 * stray line turns a block into plain text the harness ignores.
 *
 * Returns the only writer that still reaches stdout. Output written at module
 * top level, before this runs, and child processes that inherit stdout are
 * not covered.
 */
export function claimProtocolStdout(): (contents: string) => Promise<void> {
  const stdout = process.stdout;
  const protocolWrite = stdout.write.bind(stdout);
  const redirect = (...args: unknown[]) => (process.stderr.write as (...forwarded: unknown[]) => boolean)(...args);
  stdout.write = redirect as typeof stdout.write;
  return (contents) =>
    new Promise<void>((resolve, reject) => {
      protocolWrite(contents, (error?: Error | null) => {
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
