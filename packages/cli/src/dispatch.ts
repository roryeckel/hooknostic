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
  resolveTargetAdapter,
  stageUserModule,
  targetSpecFromConfig,
} from "@hooknostic/core";
import { dispatch } from "@hooknostic/runtime";
import type { HookEvent, HookEventName, HookResult, PluginSpec } from "@hooknostic/sdk";
import { baseHookEventSchema, isToolScopedEvent } from "@hooknostic/sdk";

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

type FieldCheck = (value: unknown) => string | undefined;

const optionalString: FieldCheck = (value) =>
  value === undefined || typeof value === "string" ? undefined : "must be a string when present";
const requiredString: FieldCheck = (value) => (typeof value === "string" ? undefined : "must be a string");
const anyValue: FieldCheck = () => undefined;

function objectOfOptionalStrings(keys: readonly string[]): FieldCheck {
  return (value) =>
    isRecord(value) && Object.entries(value).every(([key, field]) => keys.includes(key) && typeof field === "string")
      ? undefined
      : `must be an object with optional string ${keys.join(" and ")}`;
}

const ENVELOPE_FIELDS = ["schemaVersion", "event", "harness", "session", "correlation", "raw"];

/**
 * Each event's own fields beyond the envelope and `tool`, mirroring its
 * interface in the SDK's events.ts. A decoder always supplies the required
 * ones, so a test must too, and a new event does not compile until it is listed.
 */
const EVENT_FIELDS: Record<HookEventName, Readonly<Record<string, FieldCheck>>> = {
  "session.start": { how: optionalString },
  "session.end": { reason: optionalString },
  "prompt.before": { prompt: requiredString },
  "model.request.before": {},
  "tool.before": {},
  "tool.after": { output: anyValue },
  "tool.error": { error: objectOfOptionalStrings(["message"]) },
  "permission.request": {},
  "context.compact.before": { trigger: optionalString },
  "context.compact.after": {},
  "agent.start": { agent: objectOfOptionalStrings(["id", "type"]) },
  "agent.stop": { agent: objectOfOptionalStrings(["id", "type"]), lastMessage: optionalString },
  "turn.stop": { lastMessage: optionalString },
};

/** What the target's classifier derives; a test supplies only `nativeName` and `input`. */
const DERIVED_TOOL_FIELDS = ["kind", "mcp", "shell"];

/**
 * Complete a portable event the way a decoder completes a native one, so a
 * test cannot hand a hook an event its harness never would (ADR-0023). The
 * envelope gets its defaults, the event's own fields must be as its type
 * declares them, and the tool is the target's classification of its name and
 * input.
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
  const fields = EVENT_FIELDS[name];
  const tool = value["tool"] as Record<string, unknown> | undefined;
  if (tool === undefined && isToolScopedEvent(name)) return { problem: `${name} needs a tool` };
  if (tool !== undefined && !isToolScopedEvent(name)) {
    return { problem: `${name} is not tool-scoped, so it takes no tool` };
  }
  const unknown = Object.keys(value).find(
    (key) => !ENVELOPE_FIELDS.includes(key) && key !== "tool" && !Object.hasOwn(fields, key),
  );
  if (unknown !== undefined) return { problem: `${name} has no field ${JSON.stringify(unknown)}` };
  for (const [field, check] of Object.entries(fields)) {
    const problem = check(value[field]);
    if (problem !== undefined) return { problem: `${field} ${problem}` };
  }
  if (tool === undefined) return { event: event as unknown as HookEvent };

  const derived = DERIVED_TOOL_FIELDS.filter((key) => key in tool);
  if (derived.length > 0) {
    const [verb, pronoun] = derived.length === 1 ? ["is", "it"] : ["are", "them"];
    return {
      problem: `${derived.map((key) => `tool.${key}`).join(" and ")} ${verb} derived from tool.nativeName and tool.input by the target's classifier; omit ${pronoun}`,
    };
  }
  const extra = Object.keys(tool).find((key) => key !== "nativeName" && key !== "input");
  if (extra !== undefined) return { problem: `tool has no field ${JSON.stringify(extra)}` };
  const nativeName = tool["nativeName"];
  if (typeof nativeName !== "string" || nativeName === "")
    return { problem: "tool.nativeName must be a non-empty string" };
  if (adapter.classifyTool === undefined) {
    return { problem: `the ${adapter.id} adapter cannot classify tools, so it cannot dispatch ${name}` };
  }
  event["tool"] = adapter.classifyTool(nativeName, tool["input"]);
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
  let adapter = options.registry[adapterId];
  if (adapter === undefined)
    return { ok: false, errors: [`no adapter is registered as ${JSON.stringify(adapterId)}.`] };
  const selected = resolveTargetAdapter(adapter, targetSpecFromConfig(options.target, targetConfig));
  if (!selected.adapter) return { ok: false, errors: selected.diagnostics.map((d) => `${d.code}: ${d.message}`) };
  adapter = selected.adapter;
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
      ...(adapter.runtime.validateEffect === undefined
        ? {}
        : { validateEffect: adapter.runtime.validateEffect.bind(adapter.runtime) }),
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
