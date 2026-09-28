import { dispatch } from "@hooknostic/runtime";
import type { HookEvent, PluginSpec } from "@hooknostic/sdk";
import { hookAppliesToTarget } from "@hooknostic/sdk";

import { withTimeout } from "../bounded-post.js";
import type { OpenCodeShimOptions } from "../shim.js";
import type { OpenCodeV2Application } from "./apply.js";
import { planOpenCodeV2Application } from "./apply.js";
import { decodeOpenCodeV2, OpenCodeV2DecodeError } from "./decode.js";
import { opencodeV2FileCodec, opencodeV2ShellCodec } from "./toolmap.js";

type Callback = (event: Record<string, unknown>) => Promise<void>;
interface Registration {
  dispose(): Promise<void>;
}
export interface OpenCodeV2Context {
  location: { directory: string };
  session: {
    hook(name: string, callback: Callback): Promise<Registration>;
    /** Admits a user-role message; `resume: false` leaves it pending without starting an execution. */
    synthetic?(input: { sessionID: string; text: string; resume: boolean }): unknown;
  };
  tool: { hook(name: string, callback: Callback): Promise<Registration> };
  permission?: { hook(name: string, callback: Callback): Promise<Registration> };
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<Record<string, unknown>> };
}

export async function setupOpenCodeV2(
  plugin: PluginSpec,
  options: OpenCodeShimOptions,
  ctx: OpenCodeV2Context,
): Promise<() => Promise<void>> {
  const targetId = options.targetId ?? "opencode";
  const events = new Set(plugin.hooks.filter((h) => hookAppliesToTarget(h, targetId)).map((h) => h.event));
  const registrations: Registration[] = [];
  const controller = new AbortController();
  let task: Promise<void> | undefined;
  const children = new Set<string>();
  const queues = new Map<string, Promise<void>>();
  // The event subscription delivers every location's sessions to each plugin
  // instance, but prompt hooks are location-scoped: a session is ours once it
  // is created in this location or prompted through this instance.
  const local = new Set<string>();
  const comparable = (path: string) => {
    const trimmed = path.replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const here = comparable(ctx.location.directory);
  const subscribes = events.has("session.start") || events.has("turn.stop") || events.has("context.compact.after");
  // Posting after an interrupted or failed execution would override it, and a
  // child's result has already been returned to its parent by the time it stops.
  const post = async (
    native: Record<string, unknown>,
    event: HookEvent,
    messages: NonNullable<OpenCodeV2Application["synthetic"]>,
  ) => {
    const sessionID = event.session.id;
    if (native.type !== "session.execution.succeeded" || sessionID === undefined || children.has(sessionID)) return;
    if (typeof ctx.session.synthetic !== "function") return;
    for (const { text, resume } of messages) {
      try {
        await withTimeout(Promise.resolve(ctx.session.synthetic({ sessionID, text, resume })));
      } catch {
        // Fail open: a stop event is the worst place to break the session.
      }
    }
  };
  // Off the subscription loop and serial per session: a turn.stop hook may run
  // for minutes, and awaiting it inline would hold every later event behind it.
  const enqueue = (key: string, work: () => Promise<void>) => {
    const next = (queues.get(key) ?? Promise.resolve())
      .then(() => (controller.signal.aborted ? undefined : work()))
      .catch(() => undefined);
    queues.set(key, next);
    void next.then(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  };
  const run = async (hook: string, native: Record<string, unknown>, modelRequest = false) => {
    let event: HookEvent;
    try {
      event = decodeOpenCodeV2(
        { hook, directory: ctx.location.directory, event: native },
        { targetId, ...(options.harnessVersion ? { harnessVersion: options.harnessVersion } : {}) },
      );
    } catch (error) {
      if (error instanceof OpenCodeV2DecodeError) return;
      throw error;
    }
    if (modelRequest) event = { ...event, event: "model.request.before" };
    if (!events.has(event.event)) return;
    const result = await dispatch(plugin.hooks, event, {
      targetId,
      harness: event.harness,
      capabilities: options.capabilities,
      shellCodec: opencodeV2ShellCodec,
      fileCodec: opencodeV2FileCodec,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.minimumCapabilityLevel ? { minimumCapabilityLevel: options.minimumCapabilityLevel } : {}),
      ...(options.pluginRoot ? { plugin: { root: options.pluginRoot } } : {}),
    });
    const application = planOpenCodeV2Application(result);
    if (application.throwMessage !== undefined) {
      if (event.event === "permission.request") {
        native.effect = "deny";
        native.message = application.throwMessage;
        return;
      }
      throw new Error(application.throwMessage);
    }
    if (
      application.input !== undefined &&
      native.input &&
      typeof native.input === "object" &&
      application.input &&
      typeof application.input === "object"
    ) {
      const replacement = structuredClone(application.input);
      for (const key of Object.keys(native.input)) delete (native.input as Record<string, unknown>)[key];
      Object.defineProperties(native.input, Object.getOwnPropertyDescriptors(replacement));
    }
    if (application.content !== undefined && native.result && typeof native.result === "object")
      (native.result as Record<string, unknown>).content = application.content;
    if (application.system && Array.isArray(native.system)) native.system.push(...application.system);
    if (application.synthetic) await post(native, event, application.synthetic);
  };
  const cleanup = async () => {
    controller.abort();
    await Promise.allSettled(registrations.map((r) => r.dispose()));
    await task;
    await Promise.allSettled(queues.values());
  };
  try {
    if (events.has("prompt.before") || subscribes)
      registrations.push(
        await ctx.session.hook("prompt", async (e) => {
          if (typeof e.sessionID === "string") local.add(e.sessionID);
          if (events.has("prompt.before")) await run("prompt", e);
        }),
      );
    if (events.has("tool.before"))
      registrations.push(await ctx.tool.hook("execute.before", (e) => run("execute.before", e)));
    if (events.has("tool.after") || events.has("tool.error"))
      registrations.push(await ctx.tool.hook("execute.after", (e) => run("execute.after", e)));
    if (events.has("model.request.before"))
      for (const name of ["context", "title", "generate"])
        registrations.push(await ctx.session.hook(name, (e) => run(name, e)));
    if (events.has("model.request.before") || events.has("context.compact.before"))
      registrations.push(
        await ctx.session.hook("compaction", async (e) => {
          if (events.has("model.request.before")) await run("compaction", e, true);
          await run("compaction", e);
        }),
      );
    if (events.has("permission.request")) {
      if (!ctx.permission) throw new Error("OpenCode v2 permission domain is unavailable");
      registrations.push(await ctx.permission.hook("evaluate", (e) => run("evaluate", e)));
    }
    if (subscribes) {
      task = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            const data =
              event.data !== null && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
            const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
            if (event.type === "session.created") {
              const location = (data.location ?? event.location) as { directory?: unknown } | undefined;
              if (typeof location?.directory !== "string" || comparable(location.directory) !== here) continue;
              local.add(sessionID);
              // Recorded before queueing, so the child's later stop already sees it.
              if (typeof data.parentID === "string") children.add(sessionID);
            } else if (!local.has(sessionID)) continue;
            enqueue(sessionID, () => run("event", event));
          }
        } catch {
          /* Subscription disposal and host shutdown must not create an unhandled rejection. */
        }
      })();
    }
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
