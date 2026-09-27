import type { CapabilityLevels } from "@hooknostic/runtime";
import { dispatch, formatHandlerErrors } from "@hooknostic/runtime";
import type { HookEventName, PluginSpec, RuntimePolicy, SupportLevel } from "@hooknostic/sdk";
// Value imports must stay on the SDK/runtime: pulling `@hooknostic/core` into
// the shim bundles esbuild into every generated artifact (see docs/design.md).
import { hookAppliesToTarget } from "@hooknostic/sdk";

import { type PiApplication, planPiApplication } from "./apply.js";
import type { PiNativeEvent } from "./decode.js";
import { decodePi, PiDecodeError } from "./decode.js";
import { piShellCodec } from "./toolmap.js";

export interface PiShimOptions {
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

/**
 * Minimal structural view of the pi ExtensionAPI the shim needs beyond event
 * handlers. Described locally rather than imported: this package deliberately
 * has no dependency on `@earendil-works/pi-coding-agent`, and everything is
 * optional because the guard that matters is the runtime feature-detect, not
 * the type.
 */
export interface PiExtensionApi {
  on?: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => void;
  sendMessage?: (message: unknown, options?: { triggerTurn?: boolean }) => void;
}

/** The subscription set returned by `createHooknosticExtension`. */
export interface HooknosticExtension {
  (pi: PiExtensionApi): void;
}

type PiHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMutablePlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    Object.isExtensible(value) &&
    Reflect.ownKeys(value).every((key) => Object.getOwnPropertyDescriptor(value, key)?.configurable === true)
  );
}

/**
 * Build the pi event subscriptions for a portable plugin. pi imports the
 * extension module in-process and calls the default factory with the
 * ExtensionAPI; every handler invocation decodes and dispatches independently
 * (ADR-0002) and nothing is cached across invocations, respecting pi's
 * stale-ctx discipline (captured: a captured ctx used after a reload errors).
 */
export function createHooknosticExtension(plugin: PluginSpec, options: PiShimOptions): HooknosticExtension {
  const targetId = options.targetId ?? "pi";
  const invocation = {
    targetId,
    ...(options.harnessVersion !== undefined ? { harnessVersion: options.harnessVersion } : {}),
  };

  const events = new Set<HookEventName>(
    plugin.hooks.filter((hook) => hookAppliesToTarget(hook, invocation.targetId)).map((hook) => hook.event),
  );

  /**
   * One dispatch: decode → dispatch → plan. Returns the native handler
   * result pi should see plus the planned application (the shim applies
   * post-turn effects through the ExtensionAPI itself).
   */
  const run = async (native: PiNativeEvent): Promise<{ result: unknown; application: PiApplication }> => {
    let event;
    try {
      event = decodePi(native, invocation);
    } catch (error) {
      if (error instanceof PiDecodeError) return { result: undefined, application: {} }; // fail-open
      throw error;
    }
    const dispatchResult = await dispatch(plugin.hooks, event, {
      targetId,
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.minimumCapabilityLevel !== undefined
        ? { minimumCapabilityLevel: options.minimumCapabilityLevel }
        : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      shellCodec: piShellCodec,
      validateEffect(effect) {
        if (effect.kind !== "replaceInput") return undefined;
        if (!isMutablePlainRecord(native.event["input"])) {
          return "pi cannot apply a rewrite because the live tool input is not a mutable plain object";
        }
        if (!isPlainRecord(effect.input)) {
          return "pi cannot apply a replacement that is not a plain object";
        }
        return undefined;
      },
      ...(options.pluginRoot !== undefined ? { plugin: { root: options.pluginRoot } } : {}),
    });
    const application = planPiApplication(dispatchResult);

    // In-process: no stdout of our own, and a stray write corrupts the TUI's
    // alternate screen mid-turn. console.error is the one channel that does not.
    const diagnostics = formatHandlerErrors(dispatchResult);
    if (diagnostics !== undefined) console.error(diagnostics);

    const piEvent = native.event as Record<string, unknown>;

    const result = {
      ...(application.block !== undefined ? { block: true, reason: application.block.reason } : {}),
      ...(application.resultReplacement !== undefined ? application.resultReplacement : {}),
      ...(application.injectedMessage !== undefined ? { message: application.injectedMessage } : {}),
      ...(application.systemPrompt !== undefined ? { systemPrompt: application.systemPrompt } : {}),
      ...(application.compactCancel !== undefined ? { cancel: true } : {}),
    } as Record<string, unknown>;

    if (application.inputReplacement !== undefined) {
      // pi executes the live `event.input` after the handler returns and
      // performs no re-validation (0.84.4 type docs; verified by effect:
      // .capture/pi). The dispatcher has already rejected payloads that cannot
      // use this channel; reassignment is not an established channel.
      const existing = piEvent["input"];
      const replacement = application.inputReplacement;
      if (!isMutablePlainRecord(existing) || !isPlainRecord(replacement)) {
        throw new Error("pi input replacement escaped dispatch validation");
      }
      const replacementSnapshot = { ...replacement };
      for (const key of Reflect.ownKeys(existing)) {
        delete existing[key as keyof typeof existing];
      }
      Object.defineProperties(existing, Object.getOwnPropertyDescriptors(replacementSnapshot));
    }
    if (application.contextMessages !== undefined) {
      // pi honors the RETURN value here (unlike tool_call, whose documented
      // channel is in-place mutation): merge the context strings in and
      // return the array. The array is AgentMessage[] -- pi's converter drops
      // a system-role entry (observed live on 0.84.4), so the context rides
      // as a custom message the model sees verbatim (verified by effect:
      // .capture/pi context-inject probe; the same shape the prompt.before
      // channel uses). When the event carried no messages array there is
      // nothing to merge into, and the channel is a no-op.
      const messages = piEvent["messages"];
      if (Array.isArray(messages)) {
        result["messages"] = [
          ...messages,
          ...application.contextMessages.map((text) => ({
            role: "custom",
            customType: "hooknostic",
            content: text,
            display: false,
          })),
        ];
      }
    }

    return { result: Object.keys(result).length > 0 ? result : undefined, application };
  };

  const runFailingOpen = async (native: PiNativeEvent): Promise<{ result: unknown; application: PiApplication }> => {
    try {
      return await run(native);
    } catch {
      // Fail open: an unintended throw here would deny the user's action
      // (pi treats a handler throw as an error surface, and an in-process
      // bug must never break the session). console.error is safe here, but
      // the honest option is a silent no-op result.
      return { result: undefined, application: {} };
    }
  };

  return (pi: PiExtensionApi) => {
    const handler =
      (name: string): PiHandler =>
      async (event, ctx) => {
        const ctxCwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
        const eventCwd = (event as { cwd?: unknown }).cwd;
        const cwd = typeof ctxCwd === "string" ? ctxCwd : typeof eventCwd === "string" ? eventCwd : process.cwd();
        const native: PiNativeEvent = {
          event: event as Record<string, unknown>,
          ctx: { cwd },
        };
        const { result, application } = await runFailingOpen(native);

        // preventStop posts back into the session after the settled run.
        // Verified by effect (.capture/pi): sendMessage({triggerTurn: true})
        // starts another turn. A missing sendMessage is a silent no-op.
        if (name === "agent_settled" && application.sendMessage !== undefined) {
          for (const message of application.sendMessage) {
            try {
              pi.sendMessage?.(
                {
                  customType: "hooknostic",
                  content: message.content,
                  display: false,
                },
                { triggerTurn: true },
              );
            } catch {
              // Fail open.
            }
          }
        }
        return result;
      };

    if (events.has("session.start")) pi.on?.("session_start", handler("session_start"));
    if (events.has("session.end")) pi.on?.("session_shutdown", handler("session_shutdown"));
    if (events.has("prompt.before")) pi.on?.("before_agent_start", handler("before_agent_start"));
    if (events.has("model.request.before")) pi.on?.("context", handler("context"));
    if (events.has("tool.before")) pi.on?.("tool_call", handler("tool_call"));
    if (events.has("tool.after") || events.has("tool.error")) pi.on?.("tool_result", handler("tool_result"));
    if (events.has("context.compact.before")) pi.on?.("session_before_compact", handler("session_before_compact"));
    if (events.has("context.compact.after")) {
      pi.on?.("session_compact", handler("session_compact"));
      pi.on?.("session_compact_failed", handler("session_compact_failed"));
    }
    if (events.has("turn.stop")) pi.on?.("agent_settled", handler("agent_settled"));
  };
}

// The generated entry resolves `pluginRoot` with this; it imports only the
// shim subpath, so the helper is re-exported here rather than from the runtime.
export { pluginRootFrom } from "@hooknostic/runtime";
