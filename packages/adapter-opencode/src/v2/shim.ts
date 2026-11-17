import { dispatch, formatHandlerErrors, isInstance, reportInternalError } from "@hooknostic/runtime";
import type { HookEvent, PluginSpec } from "@hooknostic/sdk";
import { hookAppliesToTarget } from "@hooknostic/sdk";

import { withTimeout } from "../bounded-post.js";
import { dialectOfStatedShell, statedShellV2 } from "../shell-statement.js";
import type { OpenCodeShimOptions } from "../shim.js";
import type { OpenCodeV2Application } from "./apply.js";
import { planOpenCodeV2Application } from "./apply.js";
import type { OpenCodeV2Child, OpenCodeV2Execution } from "./decode.js";
import { decodeOpenCodeV2, OpenCodeV2DecodeError, record } from "./decode.js";
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
    /** The session's stored record, with `parentID` and `agent` for a child (probed on 2.0.17, 2.2.6 and 2.3.0). */
    get?(input: { sessionID: string }): unknown;
  };
  tool: { hook(name: string, callback: Callback): Promise<Registration> };
  permission?: { hook(name: string, callback: Callback): Promise<Registration> };
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<Record<string, unknown>> };
}

/**
 * A deliberate block, the one throw the shim means. OpenCode 2.x treats every
 * throw alike (.capture/opencode-v2-plugin-throw): it denies the call, or fails
 * the request, with the message model-visible. So anything else a callback
 * throws is a Hooknostic defect, reported and swallowed rather than let
 * through as a block.
 */
class HooknosticBlock extends Error {}

/** Proxy-safe: `instanceof` on a revoked proxy throws, and that would fail closed. */
const isBlock = (error: unknown): boolean => isInstance(error, HooknosticBlock);

/** Fail open on an internal error from `work`; a deliberate block still propagates. */
async function failingOpen(hook: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (isBlock(error)) throw error;
    reportInternalError(error, hook);
  }
}

/** A host callback guarded as a whole, so its own bookkeeping fails open too. */
const guarded =
  (hook: string, callback: (event: Record<string, unknown>) => Promise<void>) => (event: Record<string, unknown>) =>
    failingOpen(hook, () => callback(event));

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
  // Each child session's parent and agent, from its session.created.
  const children = new Map<string, OpenCodeV2Child>();
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
  const declares = (event: "turn.stop" | "agent.stop", field: string) =>
    plugin.hooks.some(
      (h) =>
        h.event === event &&
        hookAppliesToTarget(h, targetId) &&
        (h.fields ?? []).includes(`${event}.${field}` as never),
    );
  // A child's agent.stop reports the same buffered text as its own turn.stop.
  const readsText = declares("turn.stop", "lastMessage") || declares("agent.stop", "lastMessage");
  const readsPrompt = declares("turn.stop", "correlation.turnId");
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
  // A child's stop is reported only for succeeded and failed completions; an
  // interrupted child is not claimed.
  const childStops = new Set(["session.execution.succeeded", "session.execution.failed"]);
  const subscribes =
    events.has("session.start") ||
    events.has("turn.stop") ||
    events.has("agent.start") ||
    events.has("agent.stop") ||
    events.has("context.compact.after");
  // The shell each session's `shell` tool was last said to run (ADR-0029). The
  // context hook precedes every model request and carries the tool's
  // description, which names the shell; no tool hook does. Kept per session and
  // replaced on every request, so a description that stops naming a shell
  // clears it. Bounded: sessions outlive executions, and nothing here ends one.
  // The session forgotten is the one stated longest ago, and each request
  // restates, so a call loses its dialect only if 256 other sessions state
  // theirs between its own request and the call. It then reports none.
  const readsShell = events.has("tool.before") || events.has("tool.after") || events.has("tool.error");
  const statedShells = new Map<string, string>();
  const STATED_SHELL_SESSIONS = 256;
  const noteShell = (e: Record<string, unknown>) => {
    // Fail open, and to unknown: the event is the host's live object, and a
    // throw from the context hook fails the execution
    // (.capture/opencode-v2-plugin-throw), here over a dialect. Caught here,
    // not by the callback's guard, so dispatch still runs; and silently, as
    // an unreadable description is not a defect. The old statement goes
    // first, so a read that throws leaves none behind.
    try {
      const sessionID = e.sessionID;
      if (typeof sessionID !== "string") return;
      statedShells.delete(sessionID);
      const name = statedShellV2(record(record(e.tools).shell).description);
      if (name === undefined) return;
      statedShells.set(sessionID, name);
      const oldest = statedShells.keys().next();
      if (statedShells.size > STATED_SHELL_SESSIONS && !oldest.done) statedShells.delete(oldest.value);
    } catch {
      // Nothing to report it to; the session's dialect is unknown until the next request.
    }
  };
  // Posting after an interrupted or failed execution would override it. A child
  // posts nothing either: its result goes to its parent. Up to 2.2.7 a subagent
  // runs in the foreground by default and its result is the tool result; from
  // 2.3.0 it always runs in the background, as one given the opt-in background
  // argument did on 2.0.17 and 2.2.6, and its result is a later user message
  // that may start another parent execution, whose stop does post. Only a turn.stop posts: a child's
  // agent.stop carries its parent's session id, and a post there would steer
  // the parent, which already has the child's result or has it queued.
  const post = async (
    native: Record<string, unknown>,
    event: HookEvent,
    messages: NonNullable<OpenCodeV2Application["synthetic"]>,
  ) => {
    if (event.event !== "turn.stop") return;
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
  // Fails open in its own catch, as failingOpen would: wrapping `work` instead
  // costs the chain a microtask per event, which lets another session's event
  // overtake this session's next one. A block here has nowhere to go.
  const enqueue = (key: string, work: () => Promise<void>) => {
    const next = (queues.get(key) ?? Promise.resolve())
      .then(() => (controller.signal.aborted ? undefined : work()))
      .catch((error: unknown) => {
        if (!isBlock(error)) reportInternalError(error, "event");
      });
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
    child?: OpenCodeV2Child,
    subagent?: OpenCodeV2Child,
  ) => {
    let event: HookEvent;
    const shell = typeof native.sessionID === "string" ? statedShells.get(native.sessionID) : undefined;
    // Also given to dispatch, which re-derives the view after a rewrite and
    // could not otherwise know a dialect the first input had no view to carry.
    const shellDialect = dialectOfStatedShell(shell);
    try {
      event = decodeOpenCodeV2(
        { hook, directory: ctx.location.directory, event: native },
        { targetId, ...(options.harnessVersion ? { harnessVersion: options.harnessVersion } : {}) },
        {
          ...(execution ? { execution } : {}),
          ...(shell !== undefined ? { shell } : {}),
          ...(child ? { child } : {}),
          ...(subagent ? { subagent } : {}),
        },
      );
    } catch (error) {
      if (isInstance(error, OpenCodeV2DecodeError)) return;
      throw error;
    }
    if (modelRequest) event = { ...event, event: "model.request.before" };
    if (!events.has(event.event)) return;
    const result = await dispatch(plugin.hooks, event, {
      targetId,
      harness: event.harness,
      capabilities: options.capabilities,
      shellCodec: opencodeV2ShellCodec,
      ...(shellDialect !== undefined ? { shellDialect } : {}),
      fileCodec: opencodeV2FileCodec,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.minimumCapabilityLevel ? { minimumCapabilityLevel: options.minimumCapabilityLevel } : {}),
      ...(options.pluginRoot ? { plugin: { root: options.pluginRoot } } : {}),
    });
    // In-process, so the channel is console.error, as on v1 and Pi; stdout is
    // not ours. Reported before any block returns or throws, so a failed
    // handler is named even when another hook blocks.
    const diagnostics = formatHandlerErrors(result);
    if (diagnostics !== undefined) console.error(diagnostics);
    const application = planOpenCodeV2Application(result);
    if (application.throwMessage !== undefined) {
      if (event.event === "permission.request") {
        // A deny is written onto the evaluation, not thrown. A write that
        // throws is an internal error: the callback's guard reports it and the
        // host's own evaluation stands, as if no hook had run. The host reads
        // only `effect`, so it goes last, and a write that throws partway puts
        // back what the host had: a deny half written must not deny.
        const effect = native.effect;
        const message = Object.hasOwn(native, "message") ? { value: native.message } : undefined;
        try {
          native.message = application.throwMessage;
          native.effect = "deny";
        } catch (error) {
          const restores = [
            () => (native.effect = effect),
            () => (message ? (native.message = message.value) : delete native.message),
          ];
          for (const restore of restores) {
            try {
              restore();
            } catch {
              // Nothing more to put back; the first error is the one reported.
            }
          }
          throw error;
        }
        return;
      }
      throw new HooknosticBlock(application.throwMessage);
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
  const runFailingOpen = (...args: Parameters<typeof run>) => failingOpen(args[0], () => run(...args));
  // Any session whose session.created this instance never saw (a child created
  // before its setup or before a reload, but also a top-level session created
  // before lazy setup, and every existing session's first prompt after a
  // reload) is looked up when its prompt reaches this instance's prompt hook,
  // and only there: the prompt hook goes to one live instance, so the lookup
  // cannot report a child twice. Never from the event subscription, which also
  // reaches an old instance still running the child. Recover, never claim: a
  // lookup that throws, times out, or finds no parent in this location leaves
  // the session as it was, silently, since not found and slow are expected
  // states and nothing here can tell the user. Cleanup settles it at once, so
  // disposal never waits on it and no timer outlives the instance.
  const LOOKUP_TIMEOUT_MS = 2_000;
  const lookups = new Map<string, Promise<OpenCodeV2Child | undefined>>();
  const readsLink = events.has("turn.stop") || events.has("agent.stop");
  const lookUp = (sessionID: string) => {
    const get = ctx.session.get;
    if (typeof get !== "function") return;
    const pending = withTimeout(
      Promise.resolve().then(() => get.call(ctx.session, { sessionID })),
      LOOKUP_TIMEOUT_MS,
      controller.signal,
    )
      .then((info): OpenCodeV2Child | undefined => {
        const session = record(info);
        const parentID = session.parentID;
        const directory = record(session.location).directory;
        if (typeof parentID !== "string" || typeof directory !== "string" || comparable(directory) !== here)
          return undefined;
        // Stored, so the post guard keeps stop prevention and notices off it too.
        const found = children.get(sessionID) ?? { parentID, agent: session.agent };
        children.set(sessionID, found);
        return found;
      })
      .catch(() => undefined)
      .finally(() => {
        if (lookups.get(sessionID) === pending) lookups.delete(sessionID);
      });
    lookups.set(sessionID, pending);
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
        // Guarded as a whole: the bookkeeping before dispatch reads the host's
        // object too, and a throw there would fail the prompt.
        await ctx.session.hook(
          "prompt",
          guarded("prompt", async (e) => {
            const sessionID = typeof e.sessionID === "string" ? e.sessionID : undefined;
            // Not awaited: the prompt does not wait for the lookup.
            if (readsLink && sessionID !== undefined && !local.has(sessionID) && !children.has(sessionID))
              lookUp(sessionID);
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
              // Only a block reaches the catch: an internal error has failed open.
              if (events.has("prompt.before")) await runFailingOpen("prompt", e);
            } catch (error) {
              if (sessionID !== undefined) pendingPrompts.delete(sessionID);
              throw error;
            }
          }),
        ),
      );
    if (events.has("tool.before"))
      registrations.push(
        await ctx.tool.hook(
          "execute.before",
          guarded("execute.before", (e) => run("execute.before", e)),
        ),
      );
    if (events.has("tool.after") || events.has("tool.error"))
      registrations.push(
        await ctx.tool.hook(
          "execute.after",
          guarded("execute.after", (e) => run("execute.after", e)),
        ),
      );
    // Registered for tool hooks too, where it only listens for the stated shell.
    if (events.has("model.request.before") || readsShell)
      registrations.push(
        await ctx.session.hook(
          "context",
          guarded("context", async (e) => {
            if (readsShell) noteShell(e);
            await run("context", e); // dispatches only where a hook takes the event
          }),
        ),
      );
    // Title too: a throw there drops the title request (.capture/opencode-v2-plugin-throw).
    if (events.has("model.request.before"))
      for (const name of ["title", "generate"])
        registrations.push(
          await ctx.session.hook(
            name,
            guarded(name, (e) => run(name, e)),
          ),
        );
    if (events.has("model.request.before") || events.has("context.compact.before"))
      registrations.push(
        await ctx.session.hook(
          "compaction",
          // Each pass fails open alone, so an internal error in the first cannot
          // skip the second. Neither pass has a block capability on v2; a block
          // would still propagate and skip the second, if a pass ever gained one.
          guarded("compaction", async (e) => {
            if (events.has("model.request.before")) await runFailingOpen("compaction", e, true);
            await runFailingOpen("compaction", e);
          }),
        ),
      );
    if (events.has("permission.request")) {
      if (!ctx.permission) throw new Error("OpenCode v2 permission domain is unavailable");
      registrations.push(
        await ctx.permission.hook(
          "evaluate",
          guarded("evaluate", (e) => run("evaluate", e)),
        ),
      );
    }
    if (subscribes) {
      task = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            // Per event: one the shim cannot read must not end the subscription,
            // and with it every later session.start and turn.stop.
            try {
              const data =
                event.data !== null && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
              const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
              if (event.type === "session.created") {
                const location = (data.location ?? event.location) as { directory?: unknown } | undefined;
                if (typeof location?.directory !== "string" || comparable(location.directory) !== here) continue;
                local.add(sessionID);
                // Recorded before queueing, so the child's later stop already sees it.
                if (typeof data.parentID === "string")
                  children.set(sessionID, { parentID: data.parentID, agent: data.agent });
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
              const child = children.get(sessionID);
              // The subagent's start, then the child's own session.start: the
              // agent's lifecycle encloses the child session's.
              if (event.type === "session.created" && child !== undefined && events.has("agent.start"))
                enqueue(sessionID, () => run("event", event, false, undefined, child));
              const pending =
                child === undefined && completions.has(String(event.type)) ? lookups.get(sessionID) : undefined;
              if (pending !== undefined) {
                // Its prompt hook started a lookup that has not settled: wait for
                // it, bounded, in this session's own queue only, then report as
                // for a known child, or as before if it found none. The session
                // may be top-level, whose turn.stop then waits too (at most 2 s).
                enqueue(sessionID, async () => {
                  const found = await pending;
                  // Cleanup settles this wait at once; work queued before cleanup
                  // does not start after it, so nothing is dispatched then.
                  if (controller.signal.aborted) return;
                  await runFailingOpen("event", event, false, execution, undefined, found);
                  // Checked again: cleanup may have begun while the turn.stop hook
                  // ran. A known child's agent.stop is its own queued job, checked
                  // before it starts; this one follows inline, in the same order.
                  if (controller.signal.aborted) return;
                  if (found !== undefined && events.has("agent.stop") && childStops.has(String(event.type)))
                    await run("event", event, false, execution, found);
                });
                continue;
              }
              enqueue(sessionID, () => run("event", event, false, execution, undefined, child));
              // The child's own turn.stop first, then its agent.stop, in the
              // same queue. Both report the same execution.
              if (child !== undefined && events.has("agent.stop") && childStops.has(String(event.type)))
                enqueue(sessionID, () => run("event", event, false, execution, child));
            } catch (error) {
              reportInternalError(error, "event");
            }
          }
        } catch (error) {
          // Subscription disposal and host shutdown must not create an unhandled
          // rejection. Only our own abort is expected; anything else that ends
          // the subscription ends every later stop and start hook, so it is said.
          if (!controller.signal.aborted) reportInternalError(error, "event");
        }
      })();
    }
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
