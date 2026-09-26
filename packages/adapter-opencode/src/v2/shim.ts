import { dispatch } from "@hooknostic/runtime";
import type { HookEvent, PluginSpec } from "@hooknostic/sdk";
import { hookAppliesToTarget } from "@hooknostic/sdk";

import type { OpenCodeShimOptions } from "../shim.js";
import { planOpenCodeV2Application } from "./apply.js";
import { decodeOpenCodeV2, OpenCodeV2DecodeError } from "./decode.js";
import { opencodeV2ShellCodec } from "./toolmap.js";

type Callback = (event: Record<string, unknown>) => Promise<void>;
interface Registration {
  dispose(): Promise<void>;
}
export interface OpenCodeV2Context {
  location: { directory: string };
  session: { hook(name: string, callback: Callback): Promise<Registration> };
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
      Object.assign(native.input, replacement);
    }
    if (application.content !== undefined && native.result && typeof native.result === "object")
      (native.result as Record<string, unknown>).content = application.content;
    if (application.system && Array.isArray(native.system)) native.system.push(...application.system);
  };
  const cleanup = async () => {
    controller.abort();
    await Promise.allSettled(registrations.map((r) => r.dispose()));
    await task;
  };
  try {
    if (events.has("prompt.before")) registrations.push(await ctx.session.hook("prompt", (e) => run("prompt", e)));
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
    if (events.has("session.start") || events.has("turn.stop") || events.has("context.compact.after")) {
      task = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) await run("event", event);
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
