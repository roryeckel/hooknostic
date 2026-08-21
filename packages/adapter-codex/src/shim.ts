import type { PluginSpec, RuntimePolicy } from "@hooknostic/sdk";
import type { CapabilityLevels } from "@hooknostic/runtime";
import { dispatch } from "@hooknostic/runtime";
import { applyCodex } from "./apply.js";
import { CodexDecodeError, decodeCodex } from "./decode.js";

export interface CodexShimOptions {
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
 * Command-hook entry point executed by Codex: JSON stdin → decode →
 * portable dispatch → strict JSON stdout / exit code. Fail-open on
 * protocol-level problems.
 */
export async function runCodexCommandShim(
  plugin: PluginSpec,
  options: CodexShimOptions,
): Promise<never> {
  let exitCode = 0;
  try {
    const nativeEvent: unknown = JSON.parse(await readStdin());
    const invocation = {
      targetId: "codex",
      ...(options.harnessVersion !== undefined
        ? { harnessVersion: options.harnessVersion }
        : {}),
    };
    const event = decodeCodex(nativeEvent, invocation);
    const result = await dispatch(plugin.hooks, event, {
      targetId: "codex",
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
    });
    const native = await applyCodex(result, nativeEvent, invocation);
    if (native.body !== undefined) process.stdout.write(JSON.stringify(native.body));
    if (native.stderr !== undefined) process.stderr.write(native.stderr);
    exitCode = native.exitCode ?? 0;
  } catch (error) {
    if (!(error instanceof CodexDecodeError)) {
      process.stderr.write(
        `hooknostic: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    exitCode = 0; // fail-open
  }
  process.exit(exitCode);
}
