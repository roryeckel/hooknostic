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
  return {
    ...DEFAULT_COMPATIBILITY,
    ...config.compatibility,
    ...config.targets[targetId]?.compatibility,
  };
}

export function effectiveRuntime(config: Pick<HooknosticConfig, "runtime">): Required<RuntimePolicy> {
  return { ...DEFAULT_RUNTIME, ...config.runtime };
}
