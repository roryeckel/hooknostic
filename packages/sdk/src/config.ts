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
  /** Per-dispatch handler timeout; also translated to native settings where possible. */
  timeoutMs?: number;
  /** Conservative cap on accumulated model-visible context per dispatch. */
  contextCharLimit?: number;
}

export const DEFAULT_RUNTIME: Required<RuntimePolicy> = {
  onHookError: "continue",
  timeoutMs: 5_000,
  contextCharLimit: 16_000,
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
