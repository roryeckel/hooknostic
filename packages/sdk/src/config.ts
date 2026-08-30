import type { SupportLevel } from "./support.js";

/**
 * Compatibility policy: the minimum acceptable fidelity for required
 * capabilities and how to report shortfalls. Fidelity order:
 * exact > emulated > approximate > unsupported.
 */
export interface CompatibilityPolicy {
  /** Minimum acceptable support level for required capabilities. */
  minimum?: SupportLevel;
  /** What a required capability below the minimum produces. */
  onBelowMinimum?: "error" | "warn";
  /** How an unavailable optional capability is reported. */
  optionalUnavailable?: "info" | "warn" | "silent";
}

export const DEFAULT_COMPATIBILITY: Required<CompatibilityPolicy> = {
  minimum: "emulated",
  onBelowMinimum: "error",
  optionalUnavailable: "info",
};

export interface RuntimePolicy {
  /** Fail-open by default: a general SDK must not block on hook bugs. */
  onHookError?: "continue" | "block";
  /**
   * Default per-*handler* timeout, overridable per hook with
   * `HookSpec.timeoutMs`. Note this is not a whole-dispatch budget: the timer is
   * armed around each matching handler in turn, so N handlers on one native
   * event can occupy up to N times this. The build accounts for that when it
   * translates the budget into each harness's native timeout.
   */
  timeoutMs?: number;
  /** Conservative cap on accumulated model-visible context per dispatch. */
  contextCharLimit?: number;
  /**
   * Cap on accumulated user-visible notification text per dispatch. Much smaller
   * than the context budget: this is terminal chrome for a person to read, not
   * material for a model.
   */
  notifyCharLimit?: number;
}

export const DEFAULT_RUNTIME: Required<RuntimePolicy> = {
  onHookError: "continue",
  timeoutMs: 5_000,
  contextCharLimit: 16_000,
  notifyCharLimit: 2_000,
};

export interface TargetConfig {
  /** Requested harness version range (semver range). Builds use this, never the locally installed version. */
  version: string;
  /** Artifact mode; adapters define which modes they support. */
  mode: "plugin" | "local";
  /** Output directory for this target's self-contained artifact. */
  output: string;
  compatibility?: CompatibilityPolicy;
}

export interface AgentPluginConfig {
  /** Root of an Agent Plugins package to consume/augment. */
  root: string;
}

export interface HooknosticConfig {
  /** Path to the plugin source entry (TypeScript). */
  entry: string;
  compatibility?: CompatibilityPolicy;
  runtime?: RuntimePolicy;
  /** The allowed target set. CLI flags may narrow, never extend, this set. */
  targets: Record<string, TargetConfig>;
  agentPlugin?: AgentPluginConfig;
}

export function defineConfig(config: HooknosticConfig): HooknosticConfig {
  return config;
}
