import type { CapabilityId, DeclarableCapability } from "./capabilities.js";
import type { Effect, EffectForCapability } from "./effects.js";
import type { HookEventMap, HookEventName, ToolScopedEventName } from "./events.js";
import type { SupportLevel, RequirementLevel } from "./support.js";
import type { ToolMatch } from "./tools.js";

/** Runtime capability lookup available to handlers for feature detection. */
export interface CapabilitySet {
  /** True when the capability is usable on the executing target. */
  has(id: CapabilityId): boolean;
  /** The executing target's support level for a capability. */
  level(id: CapabilityId): SupportLevel;
}

export interface HookContext {
  capabilities: CapabilitySet;
  harness: {
    id: string;
    version?: string;
  };
  /** Aborted when the configured hook timeout elapses. */
  signal: AbortSignal;
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
export function hookAppliesToTarget(
  hook: { targets?: TargetScope | undefined },
  targetId: string,
): boolean {
  if (hook.targets?.include && !hook.targets.include.includes(targetId)) return false;
  if (hook.targets?.exclude && hook.targets.exclude.includes(targetId)) return false;
  return true;
}

/**
 * Authoring shape for a single portable hook. `C` is inferred from the
 * declared capability map, and constrains which effects `run` may return:
 * an undeclared effect is a compile-time error (and independently a runtime
 * HN401, since type information can be bypassed).
 */
export interface HookSpec<
  E extends HookEventName,
  C extends DeclarableCapability<E> = never,
> {
  /** Stable hook identifier used in diagnostics and the build report. */
  id: string;

  /** Tool matcher; only meaningful on tool-scoped events. */
  match?: E extends ToolScopedEventName ? ToolMatch : never;

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
   */
  capabilities?: Record<C, RequirementLevel>;

  run(
    event: HookEventMap[E],
    ctx: HookContext,
  ):
    | Promise<EffectForCapability<C> | undefined | void>
    | EffectForCapability<C>
    | undefined
    | void;
}

/** Erased runtime representation of an authored hook. */
export interface HookDefinition {
  event: HookEventName;
  id: string;
  match?: ToolMatch;
  targets?: TargetScope;
  timeoutMs?: number;
  capabilities: Partial<Record<CapabilityId, RequirementLevel>>;
  run(
    event: HookEventMap[HookEventName],
    ctx: HookContext,
  ): Promise<Effect | undefined | void> | Effect | undefined | void;
}

export function hook<E extends HookEventName, C extends DeclarableCapability<E> = never>(
  event: E,
  spec: HookSpec<E, C>,
): HookDefinition {
  const def: HookDefinition = {
    event,
    id: spec.id,
    capabilities: (spec.capabilities ?? {}) as Partial<
      Record<CapabilityId, RequirementLevel>
    >,
    run: spec.run as HookDefinition["run"],
  };
  if (spec.match !== undefined) def.match = spec.match;
  if (spec.targets !== undefined) def.targets = spec.targets;
  if (spec.timeoutMs !== undefined) def.timeoutMs = spec.timeoutMs;
  return def;
}
