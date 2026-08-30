import type {
  HookEvent,
  HookEventName,
  PluginSpec,
  RuntimePolicy,
  SupportLevel,
} from "@hooknostic/sdk";
// Value imports must stay on the SDK/runtime: pulling `@hooknostic/core` into
// the shim bundles esbuild into every generated artifact (see docs/design.md).
import { hookAppliesToTarget } from "@hooknostic/sdk";
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

/**
 * Minimal structural view of the OpenCode SDK client. Described locally rather
 * than imported: this package deliberately has no dependency on
 * `@opencode-ai/plugin`, and everything is optional because the guard that
 * matters is the runtime feature-detect, not the type.
 */
export interface OpenCodeClient {
  session?: {
    /**
     * Posts a message into a session (answers 204). Without `noReply` the agent
     * takes another turn — verified live on 1.18.25.
     */
    promptAsync?: (options: {
      path: { id: string };
      body: { parts: { type: "text"; text: string }[]; noReply?: boolean };
    }) => unknown;
  };
}

/** Minimal structural type for the OpenCode PluginInput we rely on. */
export interface OpenCodePluginInput {
  directory: string;
  worktree?: string;
  /**
   * Present in every real PluginInput; optional here so a caller can construct
   * one without it, and so a host that stops supplying it degrades to a no-op
   * rather than throwing inside a lifecycle callback.
   */
  client?: OpenCodeClient;
}

type Callback = (input: unknown, output: unknown) => Promise<void>;

/** How long a single session post may take before the shim gives up on it. */
const POST_TIMEOUT_MS = 10_000;

/**
 * Bound a promise without leaving a dangling rejection behind: racing alone
 * would leave the loser unhandled if it rejects after the race resolves, which
 * in OpenCode's host is an unhandled rejection.
 */
function withTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(undefined), POST_TIMEOUT_MS);
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

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

  const events = new Set<HookEventName>(
    plugin.hooks
      .filter((hook) => hookAppliesToTarget(hook, invocation.targetId))
      .map((hook) => hook.event),
  );

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
        // Snapshot before clearing the live OpenCode args object so a
        // replacement cannot be erased while the original is updated in place.
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
    await postPrompts(event, application);

    if (application.throwMessage !== undefined) {
      throw new Error(application.throwMessage);
    }
  };

  /**
   * Deliver notifications and stop-prevention. Best-effort by design: a
   * hooknostic problem must never break the user's session, and a stop event is
   * the worst possible place to throw. A missing client or a failed post is a
   * silent no-op, which the capability rationales state explicitly.
   */
  const postPrompts = async (
    event: HookEvent,
    application: ReturnType<typeof planOpenCodeApplication>,
  ): Promise<void> => {
    if (application.prompts === undefined) return;
    // HookResult carries no session id, so it comes from the decoded event.
    const id = event.session.id;
    // Called as `session.promptAsync(...)`, never detached: the real SDK client
    // carries these as prototype methods that use `this`, so a destructured
    // reference throws at call time. A plain test double hides that, and the
    // fail-open catch below would swallow it into a silent no-op.
    const session = pluginInput.client?.session;
    if (id === undefined || session === undefined || typeof session.promptAsync !== "function") {
      return;
    }

    for (const prompt of application.prompts) {
      try {
        // Awaited, not fired and forgotten: a floating rejection in OpenCode's
        // host is an unhandled rejection. promptAsync answers 204 immediately,
        // so this does not stall the event bus in the normal case -- but the
        // host awaits this callback, and dispatch's own timeout does not reach
        // here, so a post that never settles would hang the session. Bounded.
        await withTimeout(
          Promise.resolve(
            session.promptAsync({
              path: { id },
              body: {
                parts: [{ type: "text", text: prompt.text }],
                ...(prompt.reply ? {} : { noReply: true }),
              },
            }),
          ),
        );
      } catch {
        // Fail open.
      }
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
