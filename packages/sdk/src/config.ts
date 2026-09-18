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
  /** Adapter id; defaults to the target name. */
  adapter?: string;
  /** Requested harness version range (semver range). Builds use this, never the locally installed version. */
  version: string;
  /** Delivery scope; native formats are adapter-owned. */
  delivery: "package" | "project";
  /** Output directory for this target's self-contained artifact. */
  output: string;
  /**
   * The npm coordinate this target's output is published under.
   *
   * An Agent Plugins manifest name cannot be one: the specification's name
   * grammar admits only `[a-z0-9.-]`, so `@scope/name` is unspellable there,
   * and the generated npm manifest takes its name from the manifest. This is
   * the only way to publish a scoped package.
   *
   * Per target, not per plugin, because each target's output is a different npm
   * package -- an OpenCode package and a plugin directory are not
   * interchangeable contents, so publishing two means two coordinates.
   *
   * Only meaningful where the projection emits an npm manifest. Set on a target
   * whose output carries no such manifest, it is a configuration error rather
   * than a setting that quietly does nothing.
   */
  npmName?: string;
  compatibility?: CompatibilityPolicy;
}

/**
 * Source files for a Node.js runtime package. Projectors choose how, or whether,
 * a target can materialize this input.
 */
/** One declared runtime dependency set; see `ComponentPolicy.runtime`. */
export interface AgentPluginRuntimeConfig {
  /** `npm`, `pypi`, `nuget`, `cargo`, `golang`. */
  ecosystem: string;
  /** Installed runtimes only: dependency manifest, relative to the Agent Plugin root. */
  manifest?: string;
  /** Installed runtimes only: lockfile, relative to the Agent Plugin root. */
  lockfile?: string;
  delivery: "harness-installed" | "build-materialized" | "author-supplied";
  /** Where a materialized tree is written, relative to the target output. */
  into?: string;
  /** npm + `harness-installed` only; see `AgentPluginRuntimePackageConfig`. */
  allowInstallScripts?: string[];
}

export interface AgentPluginRuntimePackageConfig {
  /** Package manifest, relative to the Agent Plugin root. */
  manifest: string;
  /** npm lockfile, relative to the Agent Plugin root. */
  lockfile: string;
  /**
   * Dependency names allowed to declare an npm lifecycle install script.
   *
   * This does not make the script run: the harness installs with scripts
   * disabled, and Hooknostic performs no npm install of its own. It records that
   * you have verified the named package works without its script — a
   * `postinstall` that only prints, or a build step that falls back to a
   * prebuilt binary shipped in the tarball. Anything that genuinely needs its
   * script is outside the runtime package contract (ADR-0012).
   */
  allowInstallScripts?: string[];
}

export interface ProjectMcpServerOverride {
  /** Replace the portable stdio arguments for this target. */
  args?: string[];
  /** Replace the portable stdio working directory for this target. */
  cwd?: string;
  /** Target-native MCP startup timeout. */
  startupTimeoutMs?: number;
}

export interface ProjectMcpTargetOverride {
  /** Default startup timeout for every MCP server on this target. */
  startupTimeoutMs?: number;
  /** Per-server portable and startup overrides. */
  servers?: Record<string, ProjectMcpServerOverride>;
}

interface ComponentPolicy<TTarget extends string> {
  /**
   * Configured targets that must receive a complete native package projection.
   * Every name must be a key of `targets`, and the adapter must provide an
   * Agent Plugin projector; a target without one is a configuration error.
   */
  targets?: [TTarget, ...TTarget[]];
  /**
   * POSIX-style package-relative globs omitted from projected packages, in
   * addition to the built-in exclusions: `.git`, `node_modules`, `.env`,
   * `.env.*`, and `.npmrc` at any depth, plus this config file, the hook
   * `entry`, every target output, the build report, and staging directories.
   */
  exclude?: string[];
  /** Optional runtime dependency input for projectors that support it. */
  runtimePackage?: AgentPluginRuntimePackageConfig;
  /**
   * What an MCP server needs at run time, declared per ecosystem.
   *
   * The generalization of `runtimePackage`, which is the `npm` +
   * `harness-installed` case and still works as a shorthand for it. Which
   * deliveries an ecosystem can offer is a property of the ecosystem:
   *
   * - `harness-installed` needs a harness that installs. Only Claude does, and
   *   only for npm (ADR-0012).
   * - `build-materialized` has Hooknostic run a locked, script-free install at
   *   build time and commit the result into `into`. Admissible only where the
   *   produced bytes are the same on every machine, which is verified rather
   *   than trusted -- an artifact is built once and installed anywhere
   *   (ADR-0006), so a tree containing a native object is refused.
   * - `author-supplied` is a vendored tree or prebuilt binary already in the
   *   package. It is the only delivery a native toolchain such as cargo or go
   *   can offer, because its output is one platform's.
   */
  runtime?: AgentPluginRuntimeConfig[];
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

type DirectComponentPolicy<TTarget extends string> = {
  /** Target-specific project delivery settings for a direct MCP source. */
  mcpOverrides?: Partial<Record<TTarget, ProjectMcpTargetOverride>>;
};

export type ComponentConfig<TTarget extends string = string> = ComponentPolicy<TTarget> &
  (
    | {
        root: string;
        skills?: never;
        mcp?: never;
        mcpOverrides?: never;
        /** Exact, case-sensitive POSIX package paths to emit as 0755; others use 0644. */
        executableFiles?: string[];
      }
    | ({ root?: never; skills: string[]; mcp?: string; executableFiles?: never } & DirectComponentPolicy<TTarget>)
    | ({ root?: never; skills?: string[]; mcp: string; executableFiles?: never } & DirectComponentPolicy<TTarget>)
  );

export type TargetsConfig = Record<string, TargetConfig>;

interface HooknosticConfigBase<TTargets extends TargetsConfig> {
  project?: { root: string };
  compatibility?: CompatibilityPolicy;
  runtime?: RuntimePolicy;
  /** The allowed target set. CLI flags may narrow, never extend, this set. */
  targets: TTargets;
}

/**
 * Hooknostic project configuration. At least one of `entry` (hook source) or
 * `components` (a package to project) is required; `components.targets` may
 * only name keys of `targets`. `defineConfig` infers the target names so both
 * rules are checked by the editor, not only by the schema at build time.
 */
export type HooknosticConfig<TTargets extends TargetsConfig = TargetsConfig> = HooknosticConfigBase<TTargets> &
  (
    | {
        /** Path to the hook source entry. */
        entry: string;
        components?: ComponentConfig<keyof TTargets & string>;
      }
    | {
        /** Agent Plugin-only builds omit the hook entry. */
        entry?: undefined;
        components: ComponentConfig<keyof TTargets & string>;
      }
  );

export function defineConfig<const TTargets extends TargetsConfig>(
  config: HooknosticConfig<TTargets>,
): HooknosticConfig<TTargets> {
  return config;
}
