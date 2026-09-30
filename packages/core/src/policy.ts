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
