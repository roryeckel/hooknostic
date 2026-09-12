import type { CapabilityLevels } from "@hooknostic/runtime";
import { dispatch, formatHandlerErrors } from "@hooknostic/runtime";
import type { PluginSpec, RuntimePolicy, SupportLevel } from "@hooknostic/sdk";

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
 * Command-hook entry point executed by Claude Code: JSON event on stdin →
 * decode → portable dispatch → encode structured JSON stdout / exit code.
 * Fail-open on protocol-level problems: an undecodable payload must never
 * block the user's session.
 */
export async function runClaudeCommandShim(plugin: PluginSpec, options: ClaudeShimOptions): Promise<void> {
  let exitCode = 0;
  try {
    const nativeEvent: unknown = JSON.parse(await readStdin());
    const invocation = {
      targetId: "claude",
      ...(options.harnessVersion !== undefined ? { harnessVersion: options.harnessVersion } : {}),
    };
    const event = decodeClaude(nativeEvent, invocation);
    const result = await dispatch(plugin.hooks, event, {
      targetId: options.targetId ?? "claude",
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.minimumCapabilityLevel !== undefined
        ? { minimumCapabilityLevel: options.minimumCapabilityLevel }
        : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      shellCodec: claudeShellCodec,
    });
    const native = await applyClaude(result, nativeEvent, invocation);
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
    if (!(error instanceof ClaudeDecodeError)) {
      await writeStream(process.stderr, `hooknostic: ${error instanceof Error ? error.message : String(error)}`);
    }
    exitCode = 0; // fail-open
  }
  process.exit(exitCode);
}
