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

/**
 * The live instances of one plugin in one location, shared through
 * `globalThis`: a reload re-evaluates the plugin's modules, so module state
 * does not outlive it, but the process does. After a reload during a running
 * execution, OpenCode keeps the old instance until that execution ends (2.2.6,
 * 2.3.0) or for good (2.0.17), and both hear every event (#236).
 *
 * This symbol is a protocol between Hooknostic releases loaded into one
 * process, first released in 0.13.0. Any change to the shapes below, or to
 * what `claimed` and `inherited` mean, must bump the `/1` suffix: releases with
 * different suffixes never meet, and each dispatches, as before #236.
 */
const INSTANCES = Symbol.for("hooknostic.opencode.v2.instances/1");
/** Claimed event ids per group. A duplicate arrives within milliseconds of the first. */
const CLAIMED_EVENTS = 1024;
/** Sessions a disposed instance hands to the instances after it. */
const INHERITED_SESSIONS = 256;
interface Peer {
  generation: number;
  /**
   * Whether this instance would report the event: any session.created, since
   * it may be a new session of this location, or a session it has made its
   * own. Only an instance with a subscribing hook is in `live` at all; its own
   * hook set is not consulted, so the newest such instance decides, with the
   * hooks as last loaded.
   */
  knows(type: string, sessionID: string): boolean;
  child(sessionID: string): OpenCodeV2Child | undefined;
  /** The session's running execution as this instance buffers it, if it does. */
  running(sessionID: string): Inherited["execution"];
}
interface Inherited {
  child?: OpenCodeV2Child;
  execution?: { prompt?: NonNullable<OpenCodeV2Execution["prompt"]>; text: Record<string, unknown>[] };
}
interface InstanceGroup {
  generations: number;
  live: Set<Peer>;
  claimed: Set<string>;
  inherited: Map<string, Inherited>;
}
function instanceGroup(key: string): InstanceGroup {
  const shared = globalThis as unknown as Record<symbol, Map<string, InstanceGroup> | undefined>;
  const groups = (shared[INSTANCES] ??= new Map());
  let group = groups.get(key);
  if (group === undefined) {
    group = { generations: 0, live: new Set(), claimed: new Set(), inherited: new Map() };
    groups.set(key, group);
  }
  return group;
}
/** Forgets the oldest entries past `limit`; Set and Map iterate in insertion order. */
function bound<T>(collection: { size: number; keys(): Iterator<T>; delete(key: T): boolean }, limit: number) {
  while (collection.size > limit) {
    const oldest = collection.keys().next();
    if (oldest.done === true) return;
    collection.delete(oldest.value);
  }
}
/**
 * The handed-over sessions past `limit` go oldest first, but those without a
 * running execution before any with one, across every handover: only a
 * running execution can still end unheard.
 */
function boundInherited(inherited: Map<string, Inherited>, limit: number) {
  while (inherited.size > limit) {
    const idle = [...inherited].find(([, entry]) => entry.execution === undefined)?.[0];
    inherited.delete(idle ?? inherited.keys().next().value!);
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
  // Instances of this plugin in this location (#236). The newest that knows a
  // session reports it: it took the latest prompt, so it has the turn's ids,
  // and it runs the hooks as last loaded. An older one yields to it. A claim on
  // the event id is the backstop when both would still report.
  const group = instanceGroup([plugin.name, targetId, here, options.pluginRoot ?? ""].join("\0"));
  const generation = ++group.generations;
  const peer: Peer = {
    generation,
    knows: (type, sessionID) => type === "session.created" || local.has(sessionID),
    child: (sessionID) => children.get(sessionID),
    // Read only after setup, when `executions` (declared below) exists.
    running: (sessionID) => executions.get(sessionID),
  };
  const superseded = (type: string, sessionID: string) =>
    [...group.live].some((other) => other.generation > generation && other.knows(type, sessionID));
  /** No live instance of this bundle is newer: only the newest takes a handover. */
  const newest = () => ![...group.live].some((other) => other.generation > generation);
  // In `live` from the subscription's start: set then, cleared by the handover.
  let joined = false;
  // Adopted from a handover without a child link: its next prompt still looks it up (#232).
  const unlinked = new Set<string>();
  /**
   * Written only while two or more instances live. Read always: a claim an
   * instance wrote while it had company still holds when the instance after it
   * is alone, which is how a completion the old instance reported stays
   * reported once the new one adopts its session. An instance that joins later
   * never hears an event published before its subscription (no replay was
   * observed). An event without an id is never claimed: the newest instance
   * that knows its session still decides alone.
   */
  const claim = (id: unknown): boolean => {
    if (typeof id !== "string") return true;
    if (group.claimed.has(id)) return false;
    if (group.live.size < 2) return true;
    group.claimed.add(id);
    bound(group.claimed, CLAIMED_EVENTS);
    return true;
  };
  /** A child this instance never saw created: another instance saw it, or left it behind. */
  const childElsewhere = (sessionID: string): OpenCodeV2Child | undefined => {
    for (const other of group.live) {
      const found = other === peer ? undefined : other.child(sessionID);
      if (found !== undefined) return found;
    }
    return group.inherited.get(sessionID)?.child;
  };
  /** An execution another live instance of this bundle is still running for the session. */
  const runningElsewhere = (sessionID: string): Inherited["execution"] => {
    for (const other of group.live) {
      const found = other === peer ? undefined : other.running(sessionID);
      if (found !== undefined) return found;
    }
    return undefined;
  };
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
  /**
   * Takes over a session a disposed instance of this bundle handed on (#236):
   * its child link and its running execution, which may end only now. Only the
   * newest instance takes it, from its subscription. A merge, never an overwrite: a session this instance already knows
   * (its prompt came first) keeps its own link and execution, and gains only
   * what it lacked. A running execution taken over that way is the one the
   * prompt was steered into, so that prompt's id waits for no execution.
   */
  const adopt = (sessionID: string): boolean => {
    const inherited = group.inherited.get(sessionID);
    if (inherited === undefined) return false;
    group.inherited.delete(sessionID);
    local.add(sessionID);
    if (inherited.child !== undefined && !children.has(sessionID)) children.set(sessionID, inherited.child);
    if (!children.has(sessionID)) unlinked.add(sessionID);
    // Only where something reads it: an execution nobody buffers never ends here.
    if ((readsText || readsPrompt) && inherited.execution !== undefined && !executions.has(sessionID)) {
      executions.set(sessionID, inherited.execution);
      pendingPrompts.delete(sessionID);
    }
    return true;
  };
  /**
   * The sessions it knew go to the instances after it, each with its running
   * execution: on 2.2.6 and 2.3.0 that execution can end after this, and only
   * they would hear it (#236). Running executions first, then the sessions seen
   * most recently, up to the bound.
   */
  const handOver = () => {
    const running = [...local].filter((sessionID) => executions.has(sessionID));
    const idle = [...local].filter((sessionID) => !executions.has(sessionID));
    const handed = [...idle.slice(Math.max(0, idle.length - (INHERITED_SESSIONS - running.length))), ...running];
    for (const sessionID of handed.slice(-INHERITED_SESSIONS)) {
      const child = children.get(sessionID);
      const execution = executions.get(sessionID);
      group.inherited.delete(sessionID);
      group.inherited.set(sessionID, { ...(child ? { child } : {}), ...(execution ? { execution } : {}) });
    }
    boundInherited(group.inherited, INHERITED_SESSIONS);
  };
  const cleanup = async () => {
    // Synchronous, before the abort, so no event falls between the two: a
    // successor reading a completion while this cleanup still waits on a busy
    // queue already finds the session handed over.
    group.live.delete(peer);
    if (joined) {
      joined = false;
      handOver();
    }
    unlinked.clear();
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
            // A session never seen here, or adopted from a handover that had no
            // child link: a handover waiting for it, or another instance of this
            // bundle, may know its parent; otherwise it is looked up (#232),
            // not awaited, so the prompt does not wait for it. The handover
            // itself, with any running execution, is taken by the subscription
            // at the session's next event, which a prompt's execution brings.
            if (
              sessionID !== undefined &&
              !children.has(sessionID) &&
              (!local.has(sessionID) || unlinked.delete(sessionID))
            ) {
              const known = childElsewhere(sessionID);
              if (known !== undefined) children.set(sessionID, known);
              else if (readsLink) lookUp(sessionID);
            }
            if (sessionID !== undefined) local.add(sessionID);
            // Steered into an execution another live instance of this bundle
            // still runs (#236): this instance, which reports the session from
            // now on, takes over that execution's prompt id and text, so the
            // stop reports them, and this prompt then waits for no execution
            // (below), as it would if this instance had run it all along. A
            // copy: both instances keep buffering the same events, and a
            // segment buffered twice is kept once.
            if (sessionID !== undefined && (readsText || readsPrompt) && !executions.has(sessionID)) {
              const running = runningElsewhere(sessionID);
              if (running !== undefined)
                executions.set(sessionID, {
                  ...(running.prompt ? { prompt: running.prompt } : {}),
                  text: [...running.text],
                });
            }
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
      // Before the task starts, though its first step runs synchronously
      // anyway: an older instance must already yield to this one for the
      // first event this subscription can hear. The other way round is not
      // covered: an event an older instance had already received but not yet
      // read when this one joined is yielded by it, though this one never
      // hears it. No such lag was seen in any capture (no event the old
      // instance heard after this setup was missing here); closing it would
      // need the host to say when each subscription started.
      group.live.add(peer);
      joined = true;
      task = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            // A claim after the abort would be work nobody runs.
            if (controller.signal.aborted) break;
            // Per event: one the shim cannot read must not end the subscription,
            // and with it every later session.start and turn.stop.
            try {
              const data =
                event.data !== null && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
              const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
              const type = String(event.type);
              // A session a disposed instance handed on, taken over by the newest
              // instance only: an older one that still hears the event must not
              // consume what it would then yield. Even into a session this
              // instance already knows, as a merge, so the handed-over text and
              // child link are not lost.
              if (group.inherited.has(sessionID) && newest()) adopt(sessionID);
              if (event.type === "session.created") {
                const location = (data.location ?? event.location) as { directory?: unknown } | undefined;
                if (typeof location?.directory !== "string" || comparable(location.directory) !== here) continue;
                local.add(sessionID);
                // Recorded before queueing, so the child's later stop already sees it.
                if (typeof data.parentID === "string")
                  children.set(sessionID, { parentID: data.parentID, agent: data.agent });
              }
              // Not ours: neither created in this location, prompted here, nor
              // handed over. A child known only to another instance was linked
              // at its prompt here (the prompt hook asks the others).
              else if (!local.has(sessionID)) continue;
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
                    // Kept once: text taken over from another instance (#236) may already hold it.
                    if (!running.text.some((segment) => segment["ordinal"] === data.ordinal))
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
              // Only these dispatch from the subscription; hooks reach one instance
              // already. Before agent.start and the pending lookup, so an instance
              // that yields reports neither (#236).
              if (
                (type === "session.created" || completions.has(type) || type === "session.compaction.ended") &&
                (superseded(type, sessionID) || !claim(event.id))
              )
                continue;
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
        } finally {
          // Ended without cleanup, by an error or by the host: this instance
          // hears no more events, so an older one must not keep yielding to it.
          // No handover yet: it is still set up and still takes prompts; its
          // cleanup hands over what it knows.
          if (!controller.signal.aborted) group.live.delete(peer);
        }
      })();
    }
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
