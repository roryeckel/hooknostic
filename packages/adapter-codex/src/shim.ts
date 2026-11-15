import type { CapabilityLevels } from "@hooknostic/runtime";
import {
  claimProtocolStdout,
  type CommandPluginSource,
  debugEnabled,
  debugTracer,
  describeDecodedEvent,
  describeHookResult,
  dispatch,
  finishCommandShim,
  formatHandlerErrors,
  formatInternalError,
  isInstance,
  loadCommandPlugin,
} from "@hooknostic/runtime";
import type { RuntimePolicy, SupportLevel } from "@hooknostic/sdk";

import { applyCodex } from "./apply.js";
import { CodexDecodeError, decodeCodex } from "./decode.js";
import { codexFileCodec, codexShellCodec } from "./toolmap.js";

export interface CodexShimOptions {
  targetId?: string;
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

/** The native event a payload states, read without decoding it. */
function statedHook(payload: unknown): string | undefined {
  const name = (payload as { hook_event_name?: unknown } | null)?.hook_event_name;
  return typeof name === "string" ? name : undefined;
}

/** Write and wait for the flush. A stream a handler ended or destroyed is skipped, not fatal. */
async function writeStream(stream: NodeJS.WriteStream, contents: string): Promise<void> {
  if (stream.writableEnded || stream.destroyed) return;
  await new Promise<void>((resolve) => {
    stream.write(contents, () => resolve());
  });
}

/**
 * Command-hook entry point executed by Codex: JSON stdin → decode →
 * portable dispatch → strict JSON stdout / exit code. Fail-open on
 * protocol-level problems.
 */
export async function runCodexCommandShim(source: CommandPluginSource, options: CodexShimOptions): Promise<void> {
  let exitCode = 0;
  const stdout = claimProtocolStdout();
  const trace = debugTracer();
  let hook: string | undefined;
  try {
    let nativeEvent: unknown;
    try {
      nativeEvent = JSON.parse(await readStdin());
    } catch (error) {
      throw new CodexDecodeError(`payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Read before the plugin loads, so a plugin that fails to load is reported
    // against the event it interrupted. Parsed JSON has no getters to throw.
    hook = statedHook(nativeEvent);
    const plugin = await loadCommandPlugin(source);
    const invocation = {
      targetId: "codex",
      ...(options.harnessVersion !== undefined ? { harnessVersion: options.harnessVersion } : {}),
    };
    const event = decodeCodex(nativeEvent, invocation);
    trace?.(describeDecodedEvent(event));
    const result = await dispatch(plugin.hooks, event, {
      targetId: options.targetId ?? "codex",
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.minimumCapabilityLevel !== undefined
        ? { minimumCapabilityLevel: options.minimumCapabilityLevel }
        : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      shellCodec: codexShellCodec,
      fileCodec: codexFileCodec,
      ...(options.pluginRoot !== undefined ? { plugin: { root: options.pluginRoot } } : {}),
    });
    trace?.(describeHookResult(result));
    const native = await applyCodex(result, nativeEvent, invocation);
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
    if (isInstance(error, CodexDecodeError)) trace?.(`ignored payload: ${error.message}`);
    else {
      // A Hooknostic defect, not a hook's: the same line the in-process shims report.
      const line = formatInternalError(error, { ...(hook !== undefined ? { hook } : {}), stack: debugEnabled() });
      await writeStream(process.stderr, `${line}\n`);
    }
    exitCode = 0; // fail-open
  }
  await stdout.release().catch(() => {});
  finishCommandShim(exitCode);
}

// The generated entry resolves `pluginRoot` with this; it imports only the
// shim subpath, so the helper is re-exported here rather than from the runtime.
export { pluginRootFrom } from "@hooknostic/runtime";
