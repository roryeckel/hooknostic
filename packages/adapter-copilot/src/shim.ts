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

import { applyCopilot } from "./apply.js";
import { CopilotDecodeError, decodeCopilot } from "./decode.js";
import { copilotFileCodec, copilotShellCodec } from "./toolmap.js";

export interface CopilotShimOptions {
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

async function writeStream(stream: NodeJS.WriteStream, contents: string): Promise<void> {
  if (stream.writableEnded || stream.destroyed) return;
  await new Promise<void>((resolve) => {
    stream.write(contents, () => resolve());
  });
}

/**
 * Command-hook entry point executed by GitHub Copilot CLI: JSON event on stdin
 * → decode → portable dispatch → encode JSON stdout. The registered native
 * event name arrives as the first argument because the camelCase payloads do
 * not carry one. Fail-open on protocol-level problems: an undecodable payload
 * must never block the user's session.
 */
export async function runCopilotCommandShim(source: CommandPluginSource, options: CopilotShimOptions): Promise<void> {
  let exitCode = 0;
  const stdout = claimProtocolStdout();
  const trace = debugTracer();
  try {
    const plugin = await loadCommandPlugin(source);
    let nativeEvent: unknown;
    try {
      nativeEvent = JSON.parse(await readStdin());
    } catch (error) {
      throw new CopilotDecodeError(`payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const invocation = {
      targetId: "copilot",
      ...(options.harnessVersion !== undefined ? { harnessVersion: options.harnessVersion } : {}),
    };
    const event = decodeCopilot(nativeEvent, invocation, process.argv[2]);
    trace?.(describeDecodedEvent(event));
    const result = await dispatch(plugin.hooks, event, {
      targetId: options.targetId ?? "copilot",
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.minimumCapabilityLevel !== undefined
        ? { minimumCapabilityLevel: options.minimumCapabilityLevel }
        : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      shellCodec: copilotShellCodec,
      fileCodec: copilotFileCodec,
      ...(options.pluginRoot !== undefined ? { plugin: { root: options.pluginRoot } } : {}),
    });
    trace?.(describeHookResult(result));
    const native = await applyCopilot(result, nativeEvent, invocation);
    if (native.body !== undefined) await stdout.writeReply(JSON.stringify(native.body));
    if (native.stderr !== undefined) await writeStream(process.stderr, native.stderr);
    // Handler failures go to stderr on the exit-0 path. Copilot surfaces hook
    // stderr, and nothing machine-readable belongs in the JSON body.
    const diagnostics = formatHandlerErrors(result);
    if (diagnostics !== undefined) {
      const separator = native.stderr !== undefined && !native.stderr.endsWith("\n") ? "\n" : "";
      await writeStream(process.stderr, `${separator}${diagnostics}\n`);
    }
    exitCode = native.exitCode ?? 0;
  } catch (error) {
    if (error instanceof CopilotDecodeError) trace?.(`ignored payload: ${error.message}`);
    else {
      await writeStream(process.stderr, `hooknostic: ${error instanceof Error ? error.message : String(error)}`);
    }
    exitCode = 0; // fail-open
  }
  await stdout.release().catch(() => {});
  finishCommandShim(exitCode);
}

// The generated entry resolves `pluginRoot` with this; it imports only the shim
// subpath, so the helper is re-exported here rather than imported from runtime.
export { pluginRootFrom } from "@hooknostic/runtime";
