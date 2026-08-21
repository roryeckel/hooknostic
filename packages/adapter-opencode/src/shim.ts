import type { HookEventName, PluginSpec, RuntimePolicy, SupportLevel } from "@hooknostic/sdk";
import type { CapabilityLevels } from "@hooknostic/runtime";
import { dispatch } from "@hooknostic/runtime";
import { planOpenCodeApplication } from "./apply.js";
import type { OpenCodeNativeEvent } from "./decode.js";
import { OpenCodeDecodeError, decodeOpenCode } from "./decode.js";

export interface OpenCodeShimOptions {
  capabilities: CapabilityLevels;
  minimumCapabilityLevel?: SupportLevel;
  policy?: RuntimePolicy;
  harnessVersion?: string;
}

/** Minimal structural type for the OpenCode PluginInput we rely on. */
export interface OpenCodePluginInput {
  directory: string;
  worktree?: string;
}

type Callback = (input: unknown, output: unknown) => Promise<void>;

/**
 * Build the native OpenCode Hooks object for a portable plugin. Persistent
 * module lifetime is deliberately not surfaced: every callback invocation
 * decodes and dispatches independently (ADR-0002).
 */
export function createHooknosticHooks(
  plugin: PluginSpec,
  options: OpenCodeShimOptions,
  pluginInput: OpenCodePluginInput,
): Record<string, Callback> {
  const invocation = {
    targetId: "opencode",
    ...(options.harnessVersion !== undefined
      ? { harnessVersion: options.harnessVersion }
      : {}),
  };

  const events = new Set<HookEventName>(plugin.hooks.map((h) => h.event));

  const run = async (native: OpenCodeNativeEvent): Promise<void> => {
    let event;
    try {
      event = decodeOpenCode(native, invocation);
    } catch (error) {
      if (error instanceof OpenCodeDecodeError) return; // fail-open
      throw error;
    }
    const result = await dispatch(plugin.hooks, event, {
      targetId: "opencode",
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.minimumCapabilityLevel !== undefined
        ? { minimumCapabilityLevel: options.minimumCapabilityLevel }
        : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
    });
    const application = planOpenCodeApplication(result);

    const output = (native.output ?? {}) as Record<string, unknown>;
    if (application.mutations?.args !== undefined) {
      // OpenCode reads the *original* args object after the callback, so the
      // replacement must mutate it in place (verified live on 1.18.18:
      // reassigning output.args is ignored).
      const existing = output["args"];
      const replacement = application.mutations.args;
      if (
        existing !== null &&
        typeof existing === "object" &&
        replacement !== null &&
        typeof replacement === "object" &&
        !Array.isArray(existing)
      ) {
        // A handler may mutate event.tool.input and return that exact object.
        // Snapshot before clearing the live OpenCode args object so aliases do
        // not erase their own replacement.
        const replacementSnapshot = { ...(replacement as Record<string, unknown>) };
        for (const key of Object.keys(existing as Record<string, unknown>)) {
          delete (existing as Record<string, unknown>)[key];
        }
        Object.assign(existing as Record<string, unknown>, replacementSnapshot);
      } else {
        output["args"] = replacement;
      }
    }
    if (application.mutations?.output !== undefined) {
      output["output"] = application.mutations.output;
    }
    if (application.mutations?.status !== undefined) {
      output["status"] = application.mutations.status;
    }
    if (application.mutations?.context !== undefined) {
      const context = output["context"];
      if (Array.isArray(context)) context.push(...application.mutations.context);
      else output["context"] = [...application.mutations.context];
    }
    if (application.throwMessage !== undefined) {
      throw new Error(application.throwMessage);
    }
  };

  const hooks: Record<string, Callback> = {};
  const callback =
    (hook: string): Callback =>
    async (input, output) => {
      await run({
        hook,
        directory: pluginInput.directory,
        ...(pluginInput.worktree !== undefined ? { worktree: pluginInput.worktree } : {}),
        input,
        output,
      } as OpenCodeNativeEvent);
    };

  if (events.has("tool.before")) hooks["tool.execute.before"] = callback("tool.execute.before");
  if (events.has("tool.after")) hooks["tool.execute.after"] = callback("tool.execute.after");
  if (events.has("permission.request")) hooks["permission.ask"] = callback("permission.ask");
  if (events.has("prompt.before")) hooks["chat.message"] = callback("chat.message");
  if (events.has("context.compact.before")) {
    hooks["experimental.session.compacting"] = callback("experimental.session.compacting");
  }
  if (
    events.has("session.start") ||
    events.has("session.end") ||
    events.has("turn.stop") ||
    events.has("context.compact.after")
  ) {
    hooks["event"] = callback("event");
  }
  return hooks;
}
