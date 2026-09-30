import type { CapabilityLevels } from "@hooknostic/runtime";
import { dispatch, formatHandlerErrors } from "@hooknostic/runtime";
import type { HookEvent, HookEventName, PluginSpec, RuntimePolicy, SupportLevel } from "@hooknostic/sdk";
// Value imports must stay on the SDK/runtime: pulling `@hooknostic/core` into
// the shim bundles esbuild into every generated artifact (see docs/design.md).
import { DEFAULT_RUNTIME, hookAppliesToTarget } from "@hooknostic/sdk";

import { planOpenCodeApplication } from "./apply.js";
import { POST_TIMEOUT_MS, withTimeout } from "./bounded-post.js";
import type { OpenCodeEnrichment, OpenCodeNativeEvent } from "./decode.js";
import { decodeOpenCode, OpenCodeDecodeError } from "./decode.js";
import { opencodeFileCodec, opencodeShellCodec } from "./toolmap.js";

export { setupOpenCodeV2 } from "./v2/shim.js";

export interface OpenCodeShimOptions {
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
    /**
     * Reads a session's messages; answers `{ data, request, response }` with
     * `data` an array of `{ info, parts }` (captured on 1.18.32,
     * .capture/opencode-turn-fields). Prototype method, same `this` caveat.
     */
    messages?: (options: { path: { id: string } }) => unknown;
  };
  /**
   * Answers a pending permission request ("Respond to a permission request",
   * SDK method postSessionIdPermissionsPermissionId; answers 200 with the
   * boolean handled). Verified live on 1.18.25: response "reject" makes the
   * pending ask throw, the tool call is denied, and the command does not run.
   * Called as `client.postSessionIdPermissionsPermissionId(...)` — prototype
   * method, same `this` caveat as promptAsync.
   */
  postSessionIdPermissionsPermissionId?: (options: {
    path: { id: string; permissionID: string };
    body: { response: "once" | "always" | "reject" };
  }) => unknown;
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

/**
 * The native Hooks object the shim returns: one callback per OpenCode hook it
 * registers, and `dispose`.
 *
 * `dispose` is a documented extension of `@opencode-ai/plugin`'s `Hooks` type,
 * which (through 1.4.10) does not declare it. OpenCode 1.x calls it when it
 * disposes the instance and awaits it (captured on 1.18.33,
 * .capture/opencode-dispose): the instance finalizer runs
 * `Promise.resolve(hooks.dispose?.())` for each plugin, and a rejection is only
 * logged. It is present whenever the shim registers a callback.
 */
export interface OpenCodeHooks {
  [hook: string]: Callback | undefined;
  dispose?: () => Promise<void>;
}

/**
 * The longest `dispose` waits for in-flight hooks. OpenCode does not bound a
 * plugin's dispose itself (a dispose that took 25 s held `opencode run` open for
 * 25 s, .capture/opencode-dispose), so this is the only bound on how long a
 * one-shot run outlives its turn.
 */
export const DISPOSE_CAP_MS = 15_000;

/**
 * Build the native OpenCode Hooks object for a portable plugin. Persistent
 * module lifetime is deliberately not surfaced: every callback invocation
 * decodes and dispatches independently (ADR-0002).
 */
export function createHooknosticHooks(
  plugin: PluginSpec,
  options: OpenCodeShimOptions,
  pluginInput: OpenCodePluginInput,
): OpenCodeHooks {
  const targetId = options.targetId ?? "opencode";
  const invocation = {
    targetId,
    ...(options.harnessVersion !== undefined ? { harnessVersion: options.harnessVersion } : {}),
  };

  const events = new Set<HookEventName>(
    plugin.hooks.filter((hook) => hookAppliesToTarget(hook, invocation.targetId)).map((hook) => hook.event),
  );

  // session.idle carries only the session id, so the turn's last message and
  // prompt id cost a session read. Only a hook that declares one pays for it
  // (ADR-0027): a read on every idle would be wasted on every other plugin.
  const readsTurn = plugin.hooks.some(
    (hook) =>
      hook.event === "turn.stop" &&
      hookAppliesToTarget(hook, invocation.targetId) &&
      (hook.fields ?? []).some(
        (field) => field === "turn.stop.lastMessage" || field === "turn.stop.correlation.turnId",
      ),
  );

  /**
   * Read the session's messages for a `session.idle`, so the pure decoder can
   * report the finished turn. Handed to it beside the envelope, never inside
   * it: `event.raw` stays what the callback received, and a hook that never
   * declared a turn field does not get the session's history in it. Read
   * rather than buffered from message.* bus events: in a captured aborted turn
   * a message.updated arrived after session.idle (.capture/opencode-client).
   * Best-effort and bounded: a missing client or a failed or slow read leaves
   * the fields absent.
   */
  const enrich = async (native: OpenCodeNativeEvent): Promise<OpenCodeEnrichment> => {
    if (!readsTurn || native.hook !== "event") return {};
    const busEvent = (native.input as { event?: { type?: unknown; properties?: { sessionID?: unknown } } } | undefined)
      ?.event;
    const id = busEvent?.properties?.sessionID;
    // Called as `session.messages(...)`, never detached: see postPrompts.
    const session = pluginInput.client?.session;
    if (busEvent?.type !== "session.idle" || typeof id !== "string" || typeof session?.messages !== "function") {
      return {};
    }
    try {
      const response = await withTimeout(Promise.resolve(session.messages({ path: { id } })));
      const data = response !== null && typeof response === "object" && "data" in response ? response.data : undefined;
      return Array.isArray(data) ? { messages: data } : {};
    } catch {
      return {}; // Fail open: the turn still stops, without its fields.
    }
  };

  /** A block the plugin meant to deliver, as opposed to a bug escaping. */
  class HooknosticBlock extends Error {}

  const run = async (native: OpenCodeNativeEvent): Promise<void> => {
    const enrichment = await enrich(native);
    let event;
    try {
      event = decodeOpenCode(native, invocation, enrichment);
    } catch (error) {
      if (error instanceof OpenCodeDecodeError) return; // fail-open
      throw error;
    }
    const result = await dispatch(plugin.hooks, event, {
      targetId,
      harness: event.harness,
      capabilities: options.capabilities,
      ...(options.minimumCapabilityLevel !== undefined
        ? { minimumCapabilityLevel: options.minimumCapabilityLevel }
        : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      shellCodec: opencodeShellCodec,
      fileCodec: opencodeFileCodec,
      ...(options.pluginRoot !== undefined ? { plugin: { root: options.pluginRoot } } : {}),
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
        // Defining data properties avoids inherited setters (notably __proto__).
        Object.defineProperties(existing, Object.getOwnPropertyDescriptors(replacementSnapshot));
      } else {
        output["args"] = replacement;
      }
    }
    if (application.mutations?.output !== undefined) {
      output["output"] = application.mutations.output;
    }
    if (application.mutations?.context !== undefined) {
      const context = output["context"];
      if (Array.isArray(context)) context.push(...application.mutations.context);
      else output["context"] = [...application.mutations.context];
    }
    if (application.mutations?.system !== undefined) {
      // Push rather than reassign. prepare() passes the same array it goes on
      // to build the request messages from, so mutating in place is known to
      // work (.capture/opencode-context-channel). Whether a replacement array
      // would also be honoured is NOT established -- pushing avoids the
      // question, and matches the in-place discipline used for output.args.
      const system = output["system"];
      if (Array.isArray(system)) system.push(...application.mutations.system);
      else output["system"] = [...application.mutations.system];
    }
    // In-process: no stdout of our own, and a stray write corrupts the TUI's
    // alternate screen mid-turn. console.error is the one channel that does not.
    const diagnostics = formatHandlerErrors(result);
    if (diagnostics !== undefined) console.error(diagnostics);

    await postPrompts(event, application);
    await replyPermission(event, native, application);

    if (application.throwMessage !== undefined) {
      throw new HooknosticBlock(application.throwMessage);
    }
  };

  /**
   * Fail open, the way the command-hook shims do.
   *
   * Throwing is how a block is delivered on this harness, so an *unintended*
   * throw out of `run` denies the user's tool call. Claude and Codex force
   * `exitCode = 0` on any internal error and the call proceeds; here the same
   * bug did the opposite, which is the worse direction and the one this
   * project's fail-open contract exists to rule out. Only a deliberate
   * `HooknosticBlock` propagates.
   */
  const runFailingOpen = async (native: OpenCodeNativeEvent): Promise<void> => {
    try {
      await run(native);
    } catch (error) {
      if (error instanceof HooknosticBlock) throw error;
      // Nowhere to report this yet -- surfacing HookResult.errors is separate
      // work -- but a stray console write corrupts OpenCode's TUI mid-turn, so
      // swallowing is the honest option until that channel exists.
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

  /**
   * Deliver a permission denial through the client reply API. Best-effort like
   * postPrompts: a missing client or a failed reply is a silent no-op (the
   * user answers the ask themselves), which the capability rationale states.
   * The permission id and session live only on the native bus event (the
   * portable event carries them as correlation/tool input, not as reply keys),
   * so they are read from `raw` here — the same split as postPrompts.
   */
  const replyPermission = async (
    event: HookEvent,
    native: OpenCodeNativeEvent,
    application: ReturnType<typeof planOpenCodeApplication>,
  ): Promise<void> => {
    if (application.permissionReply === undefined) return;
    const properties = ((native.input as { event?: { properties?: Record<string, unknown> } })?.event?.properties ??
      {}) as { id?: unknown; sessionID?: unknown };
    const permissionID = typeof properties.id === "string" ? properties.id : undefined;
    const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
    if (permissionID === undefined || sessionID === undefined) return;
    // Called as `client.postSessionIdPermissionsPermissionId(...)` — the SDK
    // client carries these as prototype methods that use `this`, so a
    // destructured reference throws at call time (same as promptAsync).
    const client = pluginInput.client;
    if (client === undefined || typeof client.postSessionIdPermissionsPermissionId !== "function") {
      return;
    }
    try {
      await withTimeout(
        Promise.resolve(
          client.postSessionIdPermissionsPermissionId({
            path: { id: sessionID, permissionID },
            body: { response: "reject" },
          }),
        ),
      );
    } catch {
      // Fail open: the ask stays pending and the user answers it.
    }
  };

  /**
   * Every dispatch still running, whichever callback started it. OpenCode 1.x
   * starts `event` handlers without awaiting them, and `opencode run` exits
   * once the session is idle, so a turn.stop dispatched at session.idle was
   * killed mid-flight: its session read and its handlers never finished
   * (.capture/opencode-dispose). The host awaits `dispose` before it exits,
   * which is where these are drained.
   */
  const inflight = new Set<Promise<void>>();

  /**
   * How long `dispose` may wait. Handlers matching one native event run in
   * turn, each under its own budget (RuntimePolicy.timeoutMs), so the longest
   * dispatch is the busiest event's sum. One host round trip is added for the
   * bounded session read before dispatch or post after it. Clamped to
   * DISPOSE_CAP_MS.
   */
  const disposeBudgetMs = (() => {
    const policyMs = options.policy?.timeoutMs ?? DEFAULT_RUNTIME.timeoutMs;
    const perEvent = new Map<HookEventName, number>();
    for (const hook of plugin.hooks) {
      if (!hookAppliesToTarget(hook, invocation.targetId)) continue;
      perEvent.set(hook.event, (perEvent.get(hook.event) ?? 0) + (hook.timeoutMs ?? policyMs));
    }
    return Math.min(DISPOSE_CAP_MS, Math.max(0, ...perEvent.values()) + POST_TIMEOUT_MS);
  })();

  /**
   * Wait, bounded, for the dispatches in flight. A dispatch that starts while
   * this waits is waited for too: the host removes its bus listener only after
   * dispose. Never rejects, since the host would only log it, and clears its
   * timer so it cannot hold a process open on its own.
   */
  const dispose = async (): Promise<void> => {
    const deadline = Date.now() + disposeBudgetMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      while (inflight.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const expired = await Promise.race([
          Promise.allSettled([...inflight]).then(() => false),
          new Promise<boolean>((resolvePromise) => {
            timer = setTimeout(() => resolvePromise(true), remaining);
          }),
        ]);
        clearTimeout(timer);
        if (expired) return;
      }
    } catch {
      // Fail open: a dispose that throws is logged by the host and changes nothing.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const hooks: OpenCodeHooks = {};
  const callback =
    (hook: string): Callback =>
    async (input, output) => {
      const pending = runFailingOpen({
        hook,
        directory: pluginInput.directory,
        ...(pluginInput.worktree !== undefined ? { worktree: pluginInput.worktree } : {}),
        input,
        output,
      } as OpenCodeNativeEvent);
      inflight.add(pending);
      const settle = () => void inflight.delete(pending);
      void pending.then(settle, settle);
      await pending;
    };

  if (events.has("tool.before")) hooks["tool.execute.before"] = callback("tool.execute.before");
  if (events.has("tool.after")) hooks["tool.execute.after"] = callback("tool.execute.after");
  // permission.request arrives on the generic event bus as
  // `permission.asked` (the dedicated permission.ask callback never fires on
  // 1.18.x — captured live, .capture/opencode-permission). Denial goes
  // through the client reply API, not an output mutation.
  if (events.has("permission.request")) hooks["event"] = callback("event");
  if (events.has("prompt.before")) hooks["chat.message"] = callback("chat.message");
  if (events.has("context.compact.before")) {
    hooks["experimental.session.compacting"] = callback("experimental.session.compacting");
  }
  if (events.has("model.request.before")) {
    hooks["experimental.chat.system.transform"] = callback("experimental.chat.system.transform");
  }
  if (
    events.has("session.start") ||
    events.has("session.end") ||
    events.has("turn.stop") ||
    events.has("context.compact.after")
  ) {
    hooks["event"] = callback("event");
  }
  if (Object.keys(hooks).length > 0) hooks.dispose = dispose;
  return hooks;
}

// The generated entry resolves `pluginRoot` with this; it imports only the
// shim subpath, so the helper is re-exported here rather than from the runtime.
export { pluginRootFrom } from "@hooknostic/runtime";
