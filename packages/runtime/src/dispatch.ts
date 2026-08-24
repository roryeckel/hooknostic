import type {
  CapabilityId,
  CapabilitySet,
  Effect,
  HandlerError,
  HookContext,
  HookDefinition,
  HookEvent,
  HookResult,
  RuntimePolicy,
  SupportLevel,
  ToolInvocation,
} from "@hooknostic/sdk";
import {
  DEFAULT_RUNTIME,
  capabilityForEffect,
  effectSchema,
  isTerminalEffect,
  matchesTool,
  meetsMinimum,
} from "@hooknostic/sdk";

/** Support levels for the executing target, as data (capability → level). */
export type CapabilityLevels = Partial<Record<CapabilityId, SupportLevel>>;

export function createCapabilitySet(levels: CapabilityLevels): CapabilitySet {
  return {
    has(id) {
      const level = levels[id];
      return level !== undefined && level !== "unsupported";
    },
    level(id) {
      return levels[id] ?? "unsupported";
    },
  };
}

export interface DispatchOptions {
  /** The executing target's id, for intentional hook target scoping. */
  targetId: string;
  harness: { id: string; version?: string };
  capabilities: CapabilityLevels;
  /** Compatibility floor applied to optional capabilities for this target. */
  minimumCapabilityLevel?: SupportLevel;
  policy?: RuntimePolicy;
}

function appliesToTarget(hook: HookDefinition, targetId: string): boolean {
  if (hook.targets?.include && !hook.targets.include.includes(targetId)) return false;
  if (hook.targets?.exclude && hook.targets.exclude.includes(targetId)) return false;
  return true;
}

function toolOf(event: HookEvent): ToolInvocation | undefined {
  return "tool" in event ? event.tool : undefined;
}

/** Convert an arbitrary thrown value without letting hostile proxies escape dispatch. */
function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return typeof error.message === "string" ? error.message : "Error";
    }
  } catch {
    // `instanceof` and property reads can both invoke hostile proxy traps.
  }

  try {
    return String(error);
  } catch {
    return "uninspectable thrown value";
  }
}

/**
 * Dispatch one decoded native event through all matching portable handlers
 * (ADR-0003): sequential declaration order, immediate mutation visibility,
 * first terminal effect wins, fail-open by default. Effects whose capability
 * is undeclared or unavailable on this target are HN401 runtime contract
 * violations handled per the hook-error policy — never silently applied.
 */
export async function dispatch(
  hooks: readonly HookDefinition[],
  event: HookEvent,
  options: DispatchOptions,
): Promise<HookResult> {
  const policy = { ...DEFAULT_RUNTIME, ...options.policy };
  const targetCapabilities = createCapabilitySet(options.capabilities);

  const result: HookResult = {
    schemaVersion: 1,
    event: event.event,
    effects: [],
    errors: [],
  };

  let contextBudget = policy.contextCharLimit;

  const matching = hooks.filter((hook) => {
    if (hook.event !== event.event) return false;
    if (!appliesToTarget(hook, options.targetId)) return false;
    const tool = toolOf(event);
    if (hook.match && tool && !matchesTool(hook.match, tool)) return false;
    return true;
  });

  const failDispatch = (
    hookId: string,
    error: HandlerError,
    capabilities: CapabilitySet,
  ): boolean => {
    result.errors.push(error);
    if (policy.onHookError === "block") {
      const blockCapability = capabilityForEffect(event.event, "block");
      if (blockCapability && capabilities.has(blockCapability)) {
        result.effects.push({
          hookId,
          effect: { kind: "block", reason: `hook "${hookId}" failed: ${error.message}` },
        });
        result.terminatedBy = hookId;
        return true; // terminal
      }
    }
    return false; // fail-open: continue with remaining handlers
  };

  for (const hook of matching) {
    const capabilities: CapabilitySet = {
      has(id) {
        return this.level(id) !== "unsupported";
      },
      level(id) {
        const level = targetCapabilities.level(id);
        const minimum = options.minimumCapabilityLevel;
        if (
          minimum !== undefined &&
          hook.capabilities[id] !== "required" &&
          !meetsMinimum(level, minimum)
        ) {
          return "unsupported";
        }
        return level;
      },
    };
    const controller = new AbortController();
    const ctx: HookContext = {
      capabilities,
      harness: { ...options.harness },
      signal: controller.signal,
    };

    let outcome: Effect | undefined | void;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await Promise.race([
        Promise.resolve(hook.run(event, ctx)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error(`timed out after ${policy.timeoutMs}ms`));
          }, policy.timeoutMs);
        }),
      ]);
    } catch (error) {
      const terminal = failDispatch(hook.id, {
        hookId: hook.id,
        kind: timedOut ? "timeout" : "error",
        message: errorMessage(error),
      }, capabilities);
      if (terminal) break;
      continue;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (outcome === undefined) continue; // no effect means continue unchanged

    // Runtime contract validation: shape, event compatibility, declaration,
    // and target availability. Type information can be bypassed, so all four
    // are enforced here regardless of the compile-time story.
    let parsedEffect: ReturnType<typeof effectSchema.safeParse>;
    try {
      // Zod may inspect a hostile proxy before jsonValueSchema can reject it.
      // Validation itself is part of the handler boundary, so it must not
      // violate the fail-open contract.
      parsedEffect = effectSchema.safeParse(outcome);
    } catch (error) {
      const terminal = failDispatch(hook.id, {
        hookId: hook.id,
        kind: "unsupported-effect",
        message: `HN401: hook "${hook.id}" returned a value that could not be validated as an effect: ${errorMessage(error)}`,
      }, capabilities);
      if (terminal) break;
      continue;
    }
    if (!parsedEffect.success) {
      const detail = parsedEffect.error.issues[0]?.message;
      const terminal = failDispatch(hook.id, {
        hookId: hook.id,
        kind: "unsupported-effect",
        message: `HN401: hook "${hook.id}" returned a value that is not a valid effect${detail !== undefined ? `: ${detail}` : "."}`,
      }, capabilities);
      if (terminal) break;
      continue;
    }
    const effect = parsedEffect.data as Effect;

    const capability = capabilityForEffect(event.event, effect.kind);
    if (capability === undefined) {
      const terminal = failDispatch(hook.id, {
        hookId: hook.id,
        kind: "unsupported-effect",
        message: `HN401: effect "${effect.kind}" is not defined for event "${event.event}".`,
      }, capabilities);
      if (terminal) break;
      continue;
    }
    if (hook.capabilities[capability] === undefined) {
      const terminal = failDispatch(hook.id, {
        hookId: hook.id,
        kind: "unsupported-effect",
        message: `HN401: hook "${hook.id}" returned "${effect.kind}" without declaring capability "${capability}".`,
      }, capabilities);
      if (terminal) break;
      continue;
    }
    if (!capabilities.has(capability)) {
      const terminal = failDispatch(hook.id, {
        hookId: hook.id,
        kind: "unsupported-effect",
        message: `HN401: capability "${capability}" is unavailable on target "${options.targetId}"; feature-detect with ctx.capabilities.has().`,
      }, capabilities);
      if (terminal) break;
      continue;
    }

    // Apply the effect (mutations become visible to subsequent handlers).
    switch (effect.kind) {
      case "replaceInput": {
        const tool = toolOf(event);
        if (tool) tool.input = effect.input;
        result.effects.push({ hookId: hook.id, effect });
        break;
      }
      case "replaceOutput": {
        if (event.event === "tool.after") event.output = effect.output;
        result.effects.push({ hookId: hook.id, effect });
        break;
      }
      case "addContext": {
        if (contextBudget <= 0) break; // cap reached: deterministic drop
        const context =
          effect.context.length > contextBudget
            ? effect.context.slice(0, contextBudget)
            : effect.context;
        contextBudget -= context.length;
        result.effects.push({ hookId: hook.id, effect: { kind: "addContext", context } });
        break;
      }
      default: {
        result.effects.push({ hookId: hook.id, effect });
        break;
      }
    }

    if (isTerminalEffect(effect)) {
      result.terminatedBy = hook.id;
      break;
    }
  }

  return result;
}

/** Accumulated model-visible context additions, in application order. */
export function contextAdditions(result: HookResult): string[] {
  return result.effects
    .filter((e) => e.effect.kind === "addContext")
    .map((e) => (e.effect as { context: string }).context);
}

/** The terminal effect, when dispatch was terminated. */
export function terminalEffect(result: HookResult): Effect | undefined {
  if (result.terminatedBy === undefined) return undefined;
  return result.effects[result.effects.length - 1]?.effect;
}

/** The final replaced input, when any handler replaced it. */
export function replacedInput(result: HookResult): { value: unknown } | undefined {
  const last = [...result.effects].reverse().find((e) => e.effect.kind === "replaceInput");
  return last ? { value: (last.effect as { input: unknown }).input } : undefined;
}

/** The final replaced output, when any handler replaced it. */
export function replacedOutput(result: HookResult): { value: unknown } | undefined {
  const last = [...result.effects].reverse().find((e) => e.effect.kind === "replaceOutput");
  return last ? { value: (last.effect as { output: unknown }).output } : undefined;
}
