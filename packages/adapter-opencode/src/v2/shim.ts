import { dispatch } from "@hooknostic/runtime";
import type { HookEvent, PluginSpec } from "@hooknostic/sdk";
import { hookAppliesToTarget } from "@hooknostic/sdk";

import { withTimeout } from "../bounded-post.js";
import type { OpenCodeShimOptions } from "../shim.js";
import type { OpenCodeV2Application } from "./apply.js";
import { planOpenCodeV2Application } from "./apply.js";
import type { OpenCodeV2Execution } from "./decode.js";
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
  // An execution's completion carries only the session id, so the turn's
  // fields are assembled from what came before it, and only when a hook
  // declares one (ADR-0027). The prompt hook's ids wait here for the
  // execution they start; each running execution collects its text.
  const declares = (field: string) =>
    plugin.hooks.some(
      (h) => h.event === "turn.stop" && hookAppliesToTarget(h, targetId) && (h.fields ?? []).includes(field as never),
    );
  const readsText = declares("turn.stop.lastMessage");
  const readsPrompt = declares("turn.stop.correlation.turnId");
  const pendingPrompts = new Map<string, NonNullable<OpenCodeV2Execution["prompt"]>>();
  const executions = new Map<
    string,
    { prompt?: NonNullable<OpenCodeV2Execution["prompt"]>; text: Record<string, unknown>[] }
  >();
  const completions = new Set([
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]);
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
  const run = async (
    hook: string,
    native: Record<string, unknown>,
    modelRequest = false,
    execution?: OpenCodeV2Execution,
  ) => {
    let event: HookEvent;
    try {
      event = decodeOpenCodeV2(
        { hook, directory: ctx.location.directory, event: native },
        { targetId, ...(options.harnessVersion ? { harnessVersion: options.harnessVersion } : {}) },
        execution ? { execution } : {},
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
          const sessionID = typeof e.sessionID === "string" ? e.sessionID : undefined;
          if (sessionID !== undefined) local.add(sessionID);
          // Recorded before dispatch: the execution it starts cannot begin until
          // this hook returns. A blocked prompt starts none, so it is dropped.
          // A prompt admitted while an execution runs is steered into that one,
          // or queued behind it, and which cannot be told apart here; carrying
          // it forward could hand its id to a synthetic continuation, which
          // runs no prompt hook. So it waits for no execution: absent, never
          // wrong. A pending id from before is dropped for the same reason.
          if (readsPrompt && sessionID !== undefined) {
            if (executions.has(sessionID)) pendingPrompts.delete(sessionID);
            else pendingPrompts.set(sessionID, { sessionID, messageID: e.messageID });
          }
          try {
            if (events.has("prompt.before")) await run("prompt", e);
          } catch (error) {
            if (sessionID !== undefined) pendingPrompts.delete(sessionID);
            throw error;
          }
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
            // Buffered here, in subscription order, not in the per-session queue:
            // a completion is queued behind a slow hook, but the text it reports
            // must be the text that ended before it (captured on 2.0.18:
            // session.text.ended, then session.step.ended, then succeeded).
            let execution: OpenCodeV2Execution | undefined;
            if (readsText || readsPrompt) {
              if (event.type === "session.execution.started") {
                const prompt = pendingPrompts.get(sessionID);
                pendingPrompts.delete(sessionID);
                executions.set(sessionID, { ...(prompt ? { prompt } : {}), text: [] });
              } else if (event.type === "session.text.ended" && readsText) {
                const running = executions.get(sessionID);
                if (running !== undefined) {
                  // Only the latest assistant message's segments are kept: a memory
                  // bound, since the decoder reports only the last message anyway.
                  if (running.text.at(-1)?.["assistantMessageID"] !== data.assistantMessageID) running.text = [];
                  running.text.push({
                    assistantMessageID: data.assistantMessageID,
                    ordinal: data.ordinal,
                    text: data.text,
                  });
                }
              } else if (completions.has(String(event.type))) {
                const finished = executions.get(sessionID);
                executions.delete(sessionID);
                if (finished !== undefined) execution = finished;
              }
            }
            enqueue(sessionID, () => run("event", event, false, execution));
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
