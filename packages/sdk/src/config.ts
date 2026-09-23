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
  /**
   * How skills are named on a harness that lists every installed plugin's
   * skills in one namespace (OpenCode). `"qualified"`, the default, names each
   * one `<plugin>-<skill>` so two plugins' `status` skills both stay
   * reachable. `"authored"` keeps the name the author wrote, so the emitted
   * SKILL.md still matches its directory as Agent Skills requires, at the risk
   * of another plugin's skill of the same name hiding it (ADR-0021).
   *
   * Only meaningful where the projection qualifies skill names. Set on any
   * other target, it is a configuration error rather than a setting that
   * quietly does nothing.
   */
  skillNames?: "qualified" | "authored";
  compatibility?: CompatibilityPolicy;
}

export interface PackageMaterializerFile {
  path: string;
  contents: Uint8Array;
  /** Canonical portable mode. Host filesystem permission bits are never inferred. */
  mode: 0o644 | 0o755;
}

export interface PackageMaterializerInput {
  /** The package-relative path declared in `components.materialize`. */
  path: string;
  /** Canonical absolute path, proven to remain inside the package root. */
  absolutePath: string;
  contents: Uint8Array;
}

export interface PackageMaterializerContext {
  /** Canonical absolute Agent Plugin package root. */
  root: string;
  inputs: Readonly<Record<string, PackageMaterializerInput>>;
}

export interface PackageMaterializationPlan {
  /** Executable name or path. Hooknostic invokes it without a shell. */
  command: string;
  args: readonly string[];
}

export interface PackageMaterializationResult {
  files: readonly PackageMaterializerFile[];
  problems: readonly string[];
}

export interface PackageMaterializer {
  /** Stable, human-readable identity used in diagnostics. */
  id: string;
  /** Provider-owned input validation performed before any command is run. */
  validate?(context: PackageMaterializerContext): readonly string[] | Promise<readonly string[]>;
  /** Plan an install or generation into `outputDir`. */
  plan(
    context: PackageMaterializerContext & { outputDir: string },
  ): PackageMaterializationPlan | Promise<PackageMaterializationPlan>;
  /** Normalize or validate the produced opaque tree, including provider-owned portability rules. */
  postprocess?(
    files: readonly PackageMaterializerFile[],
    context: PackageMaterializerContext,
  ): PackageMaterializationResult | Promise<PackageMaterializationResult>;
}

/** Identity helper that preserves a materializer's concrete TypeScript shape. */
export function definePackageMaterializer<const T extends PackageMaterializer>(materializer: T): T {
  return materializer;
}

export interface PackageMaterializationConfig {
  /** Trusted provider imported by `hooknostic.config.ts`. */
  provider: PackageMaterializer;
  /** Provider-named package-relative regular-file inputs. */
  inputs: Record<string, string>;
  /** Portable POSIX destination relative to each projected plugin root. */
  into: string;
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
   * Opaque package trees produced by trusted, author-supplied Node providers.
   * Materializers are package content, not MCP declarations: Hooknostic knows
   * how to stage and place their output but carries no ecosystem-specific
   * installer policy of its own (ADR-0017).
   */
  materialize?: PackageMaterializationConfig[];
  /** Whether a valid but unrepresentable component fails or degrades the build. Default `"error"`. */
  onUnsupported?: "error" | "warn";
  /**
   * Whether an invalid component the loader would otherwise skip (a malformed
   * skill or MCP server, an ignored `extensions` block) fails or degrades the
   * build. Default `"error"`: a skipped component in a package you are
   * publishing is an authoring mistake, not a portable-spec recovery.
   */
  onInvalid?: "error" | "warn";
  /**
   * Whether an emitted component the harness will treat differently from Agent
   * Plugins 1.0 fails the build. Default `"warn"`. `"error"` is strict mode:
   * a build fails rather than ship a package that behaves outside the
   * specification on some target. Nothing is omitted either way. Each deviation
   * is a known, captured harness behavior declared on the adapter's profile
   * (ADR-0019), reported as HN106.
   */
  onDeviation?: "error" | "warn";
  /**
   * Whether an emitted item the projection could not deliver at its
   * component's level fails the build -- an OpenCode skill that cannot be
   * named for its plugin, say. Default `"error"`, because the author can
   * usually fix it in the package; `"warn"` ships it with an HN101 warning.
   * Each degradation is declared on the adapter's profile (ADR-0021).
   */
  onDegraded?: "error" | "warn";
  /**
   * Qualified deviation and degradation ids to ship whatever `onDeviation`
   * and `onDegraded` say, such as `"opencode:skill-name-unqualified"`. Each
   * accepted instance is still reported, as information, and still recorded in
   * the build report. An id no adapter declares is an error, so a typo cannot
   * silently accept nothing.
   */
  accept?: string[];
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
        /**
         * Ambient environment variable NAMES each packaged MCP server reads,
         * keyed by the server name in `mcp.json`.
         *
         * Names only, never values: nothing here is read, expanded or embedded
         * in an artifact. It states which variables a server expects the
         * harness to pass through from its own environment, so a target that
         * withholds them can be told to forward exactly those.
         *
         * It lives here rather than in the package because a package may not
         * ask: Agent Plugins 1.0 says "unrecognized placeholder-like text MUST
         * remain literal", so a `${NAME}` in `mcp.json` is text, not a request
         * (ADR-0011, ADR-0018). Only Codex needs this today -- Claude and
         * OpenCode start a server with the environment they were launched
         * with -- and a name no server reads is a warning, not a failure.
         */
        mcpEnvironment?: Record<string, string[]>;
      }
    | ({
        root?: never;
        skills: string[];
        mcp?: string;
        /** Exact, case-sensitive `<skill>/<path>` POSIX paths to emit as 0755; others use 0644. */
        executableFiles?: string[];
        materialize?: never;
        // A direct source resolves `${NAME}` from the launch environment
        // already, so it states what it needs in the declaration itself.
        mcpEnvironment?: never;
      } & DirectComponentPolicy<TTarget>)
    // A direct MCP source alone. `skills` is `never` rather than optional
    // because the variant above already covers skills-with-MCP, and leaving it
    // optional here made both variants match that shape -- which meant the
    // type could not tell "MCP alone" from "MCP and skills", and so could not
    // refuse `executableFiles` on the one route that owns no tree to mark.
    | ({
        root?: never;
        skills?: never;
        mcp: string;
        executableFiles?: never;
        materialize?: never;
        mcpEnvironment?: never;
      } & DirectComponentPolicy<TTarget>)
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
