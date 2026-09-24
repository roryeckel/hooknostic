import { dirname, resolve } from "node:path";

import type {
  AdapterRegistry,
  EvaluateOptions,
  HarnessAdapter,
  NativeHookResult,
  StagedUserModule,
} from "@hooknostic/core";
import {
  analyzeCapabilities,
  buildPluginIR,
  effectiveCompatibility,
  effectiveRuntime,
  formatDiagnostics,
  hookPluginRoot,
  levelsFromMatrix,
  loadConfig,
  stageUserModule,
  targetSpecFromConfig,
} from "@hooknostic/core";
import { dispatch } from "@hooknostic/runtime";
import type { HookEvent, HookResult, PluginSpec } from "@hooknostic/sdk";
import { baseHookEventSchema, isToolScopedEvent, toolInvocationSchema } from "@hooknostic/sdk";

import type { CommandIO } from "./check.js";

/** `harness.nativeEvent` of a dispatched event that names none: no harness sent it. */
export const DISPATCH_NATIVE_EVENT = "hooknostic.dispatch";

export interface DispatchResult extends HookResult {
  /** The configured target the event was dispatched as. */
  target: string;
  /** What the target's shim would send its harness, from the adapter's own encoder. */
  native: NativeHookResult;
}

export type DispatchOutcome = { ok: true; results: DispatchResult[] } | { ok: false; errors: string[] };

export interface DispatchEventsOptions {
  /** Path to hooknostic.config.ts; defaults to ./hooknostic.config.ts. */
  config?: string;
  /** The one configured target to dispatch as. */
  target: string;
  /** Portable events, completed as docs/testing-your-hooks.md describes. */
  events: readonly unknown[];
  registry: AdapterRegistry;
  /** Module resolution overrides for fixture/self-hosted evaluation. */
  evaluate?: EvaluateOptions;
}

export interface DispatchCommandOptions extends Omit<DispatchEventsOptions, "events"> {
  /** JSON Lines, one portable event per line. */
  input: string;
  io: CommandIO;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`).join("; ");
}

/**
 * Complete a portable event the way a decoder completes a native one. The
 * envelope gets its defaults, and `tool.shell` is derived from `tool.input` by
 * the target's own codec, so a test cannot hand a hook a view the harness never
 * would (ADR-0023).
 */
function completeEvent(value: unknown, adapter: HarnessAdapter): { event: HookEvent } | { problem: string } {
  if (!isRecord(value)) return { problem: "an event must be a JSON object" };
  for (const key of ["harness", "session", "correlation", "tool"]) {
    if (value[key] !== undefined && !isRecord(value[key])) return { problem: `${key} must be an object` };
  }
  const harness = (value["harness"] ?? {}) as Record<string, unknown>;
  if (harness["id"] !== undefined && harness["id"] !== adapter.id) {
    return {
      problem: `harness.id ${JSON.stringify(harness["id"])} is not this target's adapter, ${JSON.stringify(adapter.id)}`,
    };
  }
  const event: Record<string, unknown> = {
    schemaVersion: 1,
    correlation: {},
    raw: null,
    ...value,
    harness: { nativeEvent: DISPATCH_NATIVE_EVENT, ...harness, id: adapter.id },
    session: { cwd: process.cwd(), ...(value["session"] as Record<string, unknown> | undefined) },
  };
  const envelope = baseHookEventSchema.safeParse(event);
  if (!envelope.success) return { problem: describeIssues(envelope.error.issues) };

  const name = envelope.data.event;
  const tool = value["tool"] as Record<string, unknown> | undefined;
  if (tool === undefined) {
    return isToolScopedEvent(name) ? { problem: `${name} needs a tool` } : { event: event as unknown as HookEvent };
  }
  if (!isToolScopedEvent(name)) return { problem: `${name} is not tool-scoped, so it takes no tool` };
  if ("shell" in tool) return { problem: "tool.shell is derived from tool.input by the target's shell codec; omit it" };
  const parsed = toolInvocationSchema.safeParse(tool);
  if (!parsed.success) return { problem: `tool: ${describeIssues(parsed.error.issues)}` };
  const shell = adapter.shellCodec?.classify(parsed.data.nativeName, parsed.data.input);
  event["tool"] = { ...tool, ...(shell === undefined ? {} : { shell }) };
  return { event: event as unknown as HookEvent };
}

/**
 * Dispatch portable events through a configured target's hooks in this
 * process, and report each result with the native reply the target's shim
 * would send (ADR-0023).
 */
export async function dispatchEvents(options: DispatchEventsOptions): Promise<DispatchOutcome> {
  const configPath = resolve(options.config ?? "hooknostic.config.ts");
  const loaded = await loadConfig(configPath, options.evaluate);
  if (!loaded.config) return { ok: false, errors: [formatDiagnostics(loaded.diagnostics)] };
  const config = loaded.config;
  const targetConfig = config.targets[options.target];
  if (targetConfig === undefined) {
    const configured = Object.keys(config.targets).join(", ") || "none";
    return {
      ok: false,
      errors: [`target ${JSON.stringify(options.target)} is not configured; configured targets: ${configured}.`],
    };
  }
  const adapterId = targetConfig.adapter ?? options.target;
  const adapter = options.registry[adapterId];
  if (adapter === undefined)
    return { ok: false, errors: [`no adapter is registered as ${JSON.stringify(adapterId)}.`] };
  if (config.entry === undefined) {
    return { ok: false, errors: ["the configuration declares no entry, so there are no hooks to dispatch."] };
  }

  const events: HookEvent[] = [];
  const problems: string[] = [];
  options.events.forEach((value, index) => {
    const completed = completeEvent(value, adapter);
    if ("event" in completed) events.push(completed.event);
    else problems.push(`event ${index + 1}: ${completed.problem}`);
  });
  if (problems.length > 0) return { ok: false, errors: problems };

  const configDir = dirname(configPath);
  let staged: StagedUserModule;
  try {
    staged = await stageUserModule(resolve(configDir, config.entry), options.evaluate);
  } catch (error) {
    return { ok: false, errors: [`failed to bundle entry ${config.entry}: ${errorMessage(error)}`] };
  }
  try {
    let instances = 0;
    const load = async () =>
      ((await import(`${staged.href}?instance=${instances++}`)) as { default?: unknown }).default;
    const first = await load();
    const ir = buildPluginIR(first);
    if (!ir.ir) return { ok: false, errors: [formatDiagnostics(ir.diagnostics)] };
    // What `build` would refuse for this target, dispatch refuses too: a test
    // must not pass against hooks that cannot ship there.
    const analysis = analyzeCapabilities(ir.ir, config, options.registry, [options.target]);
    if (analysis.targets[options.target]?.ok !== true) {
      return { ok: false, errors: [formatDiagnostics(analysis.diagnostics.filter((d) => d.severity === "error"))] };
    }

    const pluginRoot = hookPluginRoot(config, configDir, options.target, adapter);
    const common = {
      targetId: options.target,
      capabilities: levelsFromMatrix(
        adapter.capabilities(targetSpecFromConfig(options.target, targetConfig)).matrix ?? {},
      ),
      minimumCapabilityLevel: effectiveCompatibility(config, options.target).minimum,
      policy: effectiveRuntime(config),
      ...(adapter.shellCodec === undefined ? {} : { shellCodec: adapter.shellCodec }),
      ...(pluginRoot === undefined ? {} : { plugin: { root: pluginRoot } }),
    };
    const results: DispatchResult[] = [];
    for (const [index, event] of events.entries()) {
      // A command harness starts a fresh process for every dispatch, so no
      // module state may carry between events there; an in-process one keeps a
      // single instance for its lifetime.
      const plugin = (index === 0 || adapter.shimExecution === "module" ? first : await load()) as PluginSpec;
      const result = await dispatch(plugin.hooks, event, { ...common, harness: event.harness });
      const native = await adapter.runtime.apply(result, event.raw, {
        targetId: adapter.id,
        ...(event.harness.version === undefined ? {} : { harnessVersion: event.harness.version }),
      });
      results.push({ ...result, target: options.target, native });
    }
    return { ok: true, results };
  } catch (error) {
    return { ok: false, errors: [`failed to dispatch through entry ${config.entry}: ${errorMessage(error)}`] };
  } finally {
    await staged.dispose();
  }
}

/**
 * `hooknostic dispatch`: JSON Lines of portable events in, one JSON result line
 * out per event. Every line must be an event; a single trailing newline is
 * allowed, so event N is line N.
 */
export async function runDispatch(options: DispatchCommandOptions): Promise<number> {
  const { input, io, ...rest } = options;
  const lines = input.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const events: unknown[] = [];
  const problems: string[] = [];
  lines.forEach((line, index) => {
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      problems.push(`line ${index + 1}: not JSON (${errorMessage(error)})`);
    }
  });
  const outcome =
    problems.length > 0 ? { ok: false as const, errors: problems } : await dispatchEvents({ ...rest, events });
  if (!outcome.ok) {
    for (const error of outcome.errors) io.stderr(error);
    return 2;
  }
  for (const result of outcome.results) io.stdout(JSON.stringify(result));
  return 0;
}
