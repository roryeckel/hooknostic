import type { CanonicalCapability, CapabilityId, CapabilityKey, CapabilitySpellings } from "./capabilities.js";
import { canonicalCapability } from "./capabilities.js";
import type { Effect, EffectForCapability } from "./effects.js";
import type { HookEventMap, HookEventName, ToolScopedEventName } from "./events.js";
import type { RequirementLevel, SupportLevel } from "./support.js";
import type { MatchedKind, ToolMatch } from "./tools.js";

/**
 * Runtime capability lookup available to handlers for feature detection.
 *
 * Inside a hook, `K` is exactly what that hook declared, in either spelling
 * (`"input.replace"` or `"tool.before.input.replace"`): probing a capability
 * the hook never declared could only ever answer for an effect it is not
 * allowed to return, so it is a compile error rather than a silent `false`.
 */
export interface CapabilitySet<K extends string = CapabilityId> {
  /** True when the capability is usable on the executing target. */
  has(id: K): boolean;
  /** The executing target's support level for a capability. */
  level(id: K): SupportLevel;
}

/** The Agent Plugin package a hook ships in (ADR-0020). */
export interface PluginContext {
  /**
   * Absolute path of the package root on this target: the directory its MCP
   * servers see as `${PLUGIN_ROOT}`, and the place to find files the package
   * ships beside its hooks, such as a script a hook runs.
   */
  root: string;
}

export interface HookContext<K extends string = CapabilityId> {
  capabilities: CapabilitySet<K>;
  harness: {
    id: string;
    version?: string;
  };
  /** Aborted when the configured hook timeout elapses. */
  signal: AbortSignal;
  /**
   * Present exactly when the build projected an Agent Plugin package
   * (`components.root`) for the executing target; absent for a hooks-only
   * build and for direct component sources, which have no package root.
   */
  plugin?: PluginContext;
}

/** Intentional harness scoping — not a portability failure, never a warning. */
export interface TargetScope {
  include?: string[];
  exclude?: string[];
}

/**
 * True when the hook applies to `targetId` given its intentional scoping.
 *
 * This lives in the SDK rather than the compiler because adapter shims need
 * it at dispatch time: importing it from `@hooknostic/core` would drag the
 * build-time dependency graph (esbuild) into every runtime artifact.
 */
export function hookAppliesToTarget(hook: { targets?: TargetScope | undefined }, targetId: string): boolean {
  if (hook.targets?.include && !hook.targets.include.includes(targetId)) return false;
  if (hook.targets?.exclude && hook.targets.exclude.includes(targetId)) return false;
  return true;
}

/**
 * The event a hook's handler receives. On tool-scoped events `tool.kind` is
 * narrowed to what the hook's `match` admits -- sound because an earlier
 * hook's input rewrite re-derives a tool's views but never its kind.
 */
export type MatchedEvent<E extends HookEventName, M> = E extends ToolScopedEventName
  ? HookEventMap[E] & { tool: { kind: MatchedKind<M> } }
  : HookEventMap[E];

/**
 * Authoring shape for a single portable hook. `K` is inferred from the
 * declared capability map, and constrains which effects `run` may return:
 * an undeclared effect is a compile-time error (and independently a runtime
 * HN401, since type information can be bypassed). `M` is inferred from
 * `match` and narrows the event `run` receives.
 */
export interface HookSpec<
  E extends HookEventName,
  K extends CapabilityKey<E> = never,
  M extends ToolMatch = ToolMatch,
> {
  /** Stable hook identifier used in diagnostics and the build report. */
  id: string;

  /** Tool matcher; only meaningful on tool-scoped events. */
  match?: E extends ToolScopedEventName ? M : never;

  targets?: TargetScope;

  /**
   * This hook's own dispatch budget, overriding `runtime.timeoutMs`.
   *
   * Size it to what this handler actually does. A hook that spawns a linter
   * needs minutes; a string matcher needs milliseconds, and giving it minutes
   * means a bug in it hangs the harness for that long. The build derives each
   * native event's timeout from the budgets of the hooks that can reach it, so
   * raising one hook no longer inflates the ceiling for its neighbours.
   */
  timeoutMs?: number;

  /**
   * Every non-observation capability the hook may rely on. This map is the
   * compiler's static capability manifest and defines which effect helpers
   * the hook is allowed to return.
   *
   * Keys may be spelled relative to the hook's event (`block`,
   * `"input.replace"`) or in full (`"tool.before.block"`); `hook()` stores the
   * full id either way, and diagnostics always print it.
   */
  capabilities?: Record<K, RequirementLevel>;

  /**
   * Return nothing to continue unchanged, one effect, or an ordered list of
   * effects -- the same as consecutive handlers returning them one at a time,
   * with a terminal effect (`block`, `preventStop`, …) allowed only last
   * (ADR-0025). `undefined` list entries are skipped.
   */
  run(
    event: MatchedEvent<E, M>,
    ctx: HookContext<CapabilitySpellings<E, K>>,
  ):
    | HookReturn<EffectForCapability<CanonicalCapability<E, K>>>
    | Promise<HookReturn<EffectForCapability<CanonicalCapability<E, K>>>>;
}

/** What a handler may return: nothing, one effect, or an ordered list of effects. */
export type HookReturn<T extends Effect = Effect> = T | readonly (T | undefined)[] | undefined | void;

/** Erased runtime representation of an authored hook. */
export interface HookDefinition {
  event: HookEventName;
  id: string;
  match?: ToolMatch;
  targets?: TargetScope;
  timeoutMs?: number;
  capabilities: Partial<Record<CapabilityId, RequirementLevel>>;
  run(event: HookEventMap[HookEventName], ctx: HookContext): HookReturn | Promise<HookReturn>;
}

/**
 * Rewrite an authored capability map to full ids.
 *
 * Here and not in the compiler: `hook()` runs both when the compiler evaluates
 * the entry and again inside every runtime artifact, and dispatch compares the
 * declared map against full ids. Canonicalizing once, at the source, keeps both
 * consumers (and any version skew between them) on one spelling.
 */
function canonicalCapabilities(
  event: HookEventName,
  hookId: string,
  declared: Readonly<Record<string, RequirementLevel>> | undefined,
): Partial<Record<CapabilityId, RequirementLevel>> {
  const canonical: Record<string, RequirementLevel> = {};
  const spelledAs = new Map<string, string>();
  for (const [key, level] of Object.entries(declared ?? {})) {
    const id = canonicalCapability(event, key);
    const earlier = spelledAs.get(id);
    if (earlier !== undefined) {
      throw new Error(`hook "${hookId}" declares capability "${id}" twice (as "${earlier}" and "${key}").`);
    }
    spelledAs.set(id, key);
    canonical[id] = level;
  }
  return canonical as Partial<Record<CapabilityId, RequirementLevel>>;
}

export function hook<
  E extends HookEventName,
  K extends CapabilityKey<E> = never,
  const M extends ToolMatch = ToolMatch,
>(event: E, spec: HookSpec<E, K, M>): HookDefinition {
  const def: HookDefinition = {
    event,
    id: spec.id,
    capabilities: canonicalCapabilities(event, spec.id, spec.capabilities),
    run: spec.run as HookDefinition["run"],
  };
  if (spec.match !== undefined) def.match = spec.match;
  if (spec.targets !== undefined) def.targets = spec.targets;
  if (spec.timeoutMs !== undefined) def.timeoutMs = spec.timeoutMs;
  return def;
}
