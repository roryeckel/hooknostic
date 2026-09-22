import type { CapabilityLevels } from "@hooknostic/runtime";
import {
  claimProtocolStdout,
  type CommandPluginSource,
  debugTracer,
  describeDecodedEvent,
  describeHookResult,
  dispatch,
  finishCommandShim,
  formatHandlerErrors,
  loadCommandPlugin,
} from "@hooknostic/runtime";
import type { RuntimePolicy, SupportLevel } from "@hooknostic/sdk";

import { applyClaude } from "./apply.js";
import { ClaudeDecodeError, decodeClaude } from "./decode.js";
import { claudeShellCodec } from "./toolmap.js";

export interface ClaudeShimOptions {
  targetId?: string;
  /** Build-time-resolved capability levels for the executing target range. */
  capabilities: CapabilityLevels;
  minimumCapabilityLevel?: SupportLevel;
  policy?: RuntimePolicy;
  harnessVersion?: string;
  /**
   * Absolute Agent Plugin root, surfaced to handlers as `ctx.plugin.root`
   * (ADR-0020). The generated entry resolves it from its own location.
   */
  pluginRoot?: string;
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** Write and wait for the flush. A stream a handler ended or destroyed is skipped, not fatal. */
async function writeStream(stream: NodeJS.WriteStream, contents: string): Promise<void> {
  if (stream.writableEnded || stream.destroyed) return;
  await new Promise<void>((resolve) => {
    stream.write(contents, () => resolve());
  });
}

/**
 * Command-hook entry point executed by Claude Code: JSON event on stdin →
 * decode → portable dispatch → encode structured JSON stdout / exit code.
 * Fail-open on protocol-level problems: an undecodable payload must never
 * block the user's session.
 */
export async function runClaudeCommandShim(source: CommandPluginSource, options: ClaudeShimOptions): Promise<void> {
  let exitCode = 0;
  const stdout = claimProtocolStdout();
  const trace = debugTracer();
  try {
    const plugin = await loadCommandPlugin(source);
    let nativeEvent: unknown;
    try {
      nativeEvent = JSON.parse(await readStdin());
    } catch (error) {
      throw new ClaudeDecodeError(`payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const invocation = {
      targetId: "claude",
      ...(options.harnessVersion !== undefined ? { harnessVersion: options.harnessVersion } : {}),
    };
    const event = decodeClaude(nativeEvent, invocation);
    trace?.(describeDecodedEvent(event));
    const result = await dispatch(plugin.hooks, event, {
      targetId: options.targetId ?? "claude",
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.minimumCapabilityLevel !== undefined
        ? { minimumCapabilityLevel: options.minimumCapabilityLevel }
        : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      shellCodec: claudeShellCodec,
      ...(options.pluginRoot !== undefined ? { plugin: { root: options.pluginRoot } } : {}),
    });
    trace?.(describeHookResult(result));
    const native = await applyClaude(result, nativeEvent, invocation);
    if (native.body !== undefined) await stdout.writeReply(JSON.stringify(native.body));
    if (native.stderr !== undefined) await writeStream(process.stderr, native.stderr);
    // Handler failures go to stderr on the exit-0 path. Both harnesses capture
    // it, and it must not go in the JSON body: Codex's wire schemas are
    // additionalProperties:false, so an unknown field is a hard vendor error.
    const diagnostics = formatHandlerErrors(result);
    if (diagnostics !== undefined) {
      // Separator guard: a native stderr payload (e.g. a block reason) need
      // not end in a newline, and concatenating onto it would corrupt the
      // machine-greppable "hooknostic HNxxx" prefix.
      const separator = native.stderr !== undefined && !native.stderr.endsWith("\n") ? "\n" : "";
      await writeStream(process.stderr, `${separator}${diagnostics}\n`);
    }
    exitCode = native.exitCode ?? 0;
  } catch (error) {
    if (error instanceof ClaudeDecodeError) trace?.(`ignored payload: ${error.message}`);
    else {
      await writeStream(process.stderr, `hooknostic: ${error instanceof Error ? error.message : String(error)}`);
    }
    exitCode = 0; // fail-open
  }
  await stdout.release().catch(() => {});
  finishCommandShim(exitCode);
}

// The generated entry resolves `pluginRoot` with this; it imports only the
// shim subpath, so the helper is re-exported here rather than from the runtime.
export { pluginRootFrom } from "@hooknostic/runtime";
