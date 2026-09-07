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

/**
 * Source files for a Node.js runtime package. Projectors choose how, or whether,
 * a target can materialize this input.
 */
export interface AgentPluginRuntimePackageConfig {
  /** Package manifest, relative to the Agent Plugin root. */
  manifest: string;
  /** npm lockfile, relative to the Agent Plugin root. */
  lockfile: string;
}

export interface AgentPluginConfig<TTarget extends string = string> {
  /** Root of an Agent Plugins package to project into native target packages. */
  root: string;
  /**
   * Configured targets that must receive a complete native package projection.
   * Every name must be a key of `targets`, and the adapter must provide an
   * Agent Plugin projector; a target without one is a configuration error.
   */
  targets: [TTarget, ...TTarget[]];
  /**
   * POSIX-style package-relative globs omitted from projected packages, in
   * addition to the built-in exclusions: `.git`, `node_modules`, `.env`,
   * `.env.*`, and `.npmrc` at any depth, plus this config file, the hook
   * `entry`, every target output, the build report, and staging directories.
   */
  exclude?: string[];
  /** Optional runtime dependency input for projectors that support it. */
  runtimePackage?: AgentPluginRuntimePackageConfig;
  /** Whether a valid but unrepresentable component fails or degrades the build. Default `"error"`. */
  onUnsupported?: "error" | "warn";
  /**
   * Whether an invalid component the loader would otherwise skip (a malformed
   * skill or MCP server, an ignored `extensions` block) fails or degrades the
   * build. Default `"error"`: a skipped component in a package you are
   * publishing is an authoring mistake, not a portable-spec recovery.
   */
  onInvalid?: "error" | "warn";
}

export type TargetsConfig = Record<string, TargetConfig>;

interface HooknosticConfigBase<TTargets extends TargetsConfig> {
  compatibility?: CompatibilityPolicy;
  runtime?: RuntimePolicy;
  /** The allowed target set. CLI flags may narrow, never extend, this set. */
  targets: TTargets;
}

/**
 * Hooknostic project configuration. At least one of `entry` (hook source) or
 * `agentPlugin` (a package to project) is required; `agentPlugin.targets` may
 * only name keys of `targets`. `defineConfig` infers the target names so both
 * rules are checked by the editor, not only by the schema at build time.
 */
export type HooknosticConfig<TTargets extends TargetsConfig = TargetsConfig> =
  HooknosticConfigBase<TTargets> &
    (
      | {
          /** Path to the hook source entry. */
          entry: string;
          agentPlugin?: AgentPluginConfig<keyof TTargets & string>;
        }
      | {
          /** Agent Plugin-only builds omit the hook entry. */
          entry?: undefined;
          agentPlugin: AgentPluginConfig<keyof TTargets & string>;
        }
    );

export function defineConfig<const TTargets extends TargetsConfig>(
  config: HooknosticConfig<TTargets>,
): HooknosticConfig<TTargets> {
  return config;
}
