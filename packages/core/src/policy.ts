import type { CompatibilityPolicy, HooknosticConfig, RuntimePolicy } from "@hooknostic/sdk";
import { DEFAULT_COMPATIBILITY, DEFAULT_RUNTIME } from "@hooknostic/sdk";

/**
 * Effective compatibility policy for a target: defaults, overridden by the
 * global policy, overridden by the per-target policy.
 */
export function effectiveCompatibility(
  config: Pick<HooknosticConfig, "compatibility" | "targets">,
  targetId: string,
): Required<CompatibilityPolicy> {
  const target = config.targets[targetId]?.compatibility;
  return {
    ...DEFAULT_COMPATIBILITY,
    ...config.compatibility,
    ...target,
    // Acceptances add up rather than override: a target-level list that
    // silently dropped the global one would un-accept what the author accepted.
    accept: [...new Set([...(config.compatibility?.accept ?? []), ...(target?.accept ?? [])])],
  };
}

export function effectiveRuntime(config: Pick<HooknosticConfig, "runtime">): Required<RuntimePolicy> {
  return { ...DEFAULT_RUNTIME, ...config.runtime };
}

/**
 * The part of the runtime policy the bundled dispatcher reads.
 *
 * `processAllowanceMs` is build-time only (ADR-0039): it sizes each native
 * deadline, and nothing in the dispatcher reads it. Passing the whole policy
 * would suggest otherwise.
 */
export function dispatcherRuntimePolicy(
  runtime: Required<RuntimePolicy>,
): Omit<Required<RuntimePolicy>, "processAllowanceMs"> {
  return {
    onHookError: runtime.onHookError,
    timeoutMs: runtime.timeoutMs,
    contextCharLimit: runtime.contextCharLimit,
    notifyCharLimit: runtime.notifyCharLimit,
  };
}
