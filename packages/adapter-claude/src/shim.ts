import type { PluginSpec, RuntimePolicy } from "@hooknostic/sdk";
import type { CapabilityLevels } from "@hooknostic/runtime";
import { dispatch } from "@hooknostic/runtime";
import { applyClaude } from "./apply.js";
import { ClaudeDecodeError, decodeClaude } from "./decode.js";

export interface ClaudeShimOptions {
  /** Build-time-resolved capability levels for the executing target range. */
  capabilities: CapabilityLevels;
  policy?: RuntimePolicy;
  harnessVersion?: string;
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Command-hook entry point executed by Claude Code: JSON event on stdin →
 * decode → portable dispatch → encode structured JSON stdout / exit code.
 * Fail-open on protocol-level problems: an undecodable payload must never
 * block the user's session.
 */
export async function runClaudeCommandShim(
  plugin: PluginSpec,
  options: ClaudeShimOptions,
): Promise<never> {
  let exitCode = 0;
  try {
    const nativeEvent: unknown = JSON.parse(await readStdin());
    const invocation = {
      targetId: "claude",
      ...(options.harnessVersion !== undefined
        ? { harnessVersion: options.harnessVersion }
        : {}),
    };
    const event = decodeClaude(nativeEvent, invocation);
    const result = await dispatch(plugin.hooks, event, {
      targetId: "claude",
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
    });
    const native = await applyClaude(result, nativeEvent, invocation);
    if (native.body !== undefined) process.stdout.write(JSON.stringify(native.body));
    if (native.stderr !== undefined) process.stderr.write(native.stderr);
    exitCode = native.exitCode ?? 0;
  } catch (error) {
    if (!(error instanceof ClaudeDecodeError)) {
      process.stderr.write(
        `hooknostic: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    exitCode = 0; // fail-open
  }
  process.exit(exitCode);
}
