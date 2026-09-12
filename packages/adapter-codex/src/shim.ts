import type { CapabilityLevels } from "@hooknostic/runtime";
import { dispatch, formatHandlerErrors } from "@hooknostic/runtime";
import type { PluginSpec, RuntimePolicy, SupportLevel } from "@hooknostic/sdk";

import { applyCodex } from "./apply.js";
import { CodexDecodeError, decodeCodex } from "./decode.js";
import { codexShellCodec } from "./toolmap.js";

export interface CodexShimOptions {
  targetId?: string;
  capabilities: CapabilityLevels;
  minimumCapabilityLevel?: SupportLevel;
  policy?: RuntimePolicy;
  harnessVersion?: string;
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function writeStream(stream: NodeJS.WriteStream, contents: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(contents, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Command-hook entry point executed by Codex: JSON stdin → decode →
 * portable dispatch → strict JSON stdout / exit code. Fail-open on
 * protocol-level problems.
 */
export async function runCodexCommandShim(plugin: PluginSpec, options: CodexShimOptions): Promise<void> {
  let exitCode = 0;
  try {
    const nativeEvent: unknown = JSON.parse(await readStdin());
    const invocation = {
      targetId: "codex",
      ...(options.harnessVersion !== undefined ? { harnessVersion: options.harnessVersion } : {}),
    };
    const event = decodeCodex(nativeEvent, invocation);
    const result = await dispatch(plugin.hooks, event, {
      targetId: options.targetId ?? "codex",
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.minimumCapabilityLevel !== undefined
        ? { minimumCapabilityLevel: options.minimumCapabilityLevel }
        : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      shellCodec: codexShellCodec,
    });
    const native = await applyCodex(result, nativeEvent, invocation);
    if (native.body !== undefined) await writeStream(process.stdout, JSON.stringify(native.body));
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
    if (!(error instanceof CodexDecodeError)) {
      await writeStream(process.stderr, `hooknostic: ${error instanceof Error ? error.message : String(error)}`);
    }
    exitCode = 0; // fail-open
  }
  process.exit(exitCode);
}
