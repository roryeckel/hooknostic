import type { AgentPluginProjectionProfile, AgentPluginProjector, ProjectComponents } from "@hooknostic/agent-plugin";
import type {
  CapabilityId,
  HookEvent,
  HookResult,
  RuntimePolicy,
  ShellCodec,
  ShellShapes,
  SupportLevel,
  TargetConfig,
} from "@hooknostic/sdk";

import type { Diagnostic } from "./diagnostics.js";
import type { PluginIR } from "./ir.js";
import type { ProjectIntegration } from "./project-files.js";

export interface ProjectComponentOptions {
  /** Effective startup timeout per MCP server for this target. */
  mcpStartupTimeoutMs?: Readonly<Record<string, number>>;
  /** Stdio cwd overrides already validated as contained by the project root. */
  mcpProjectCwdServers?: readonly string[];
}

/** A configured build target: config entry keyed by adapter/target id. */
export interface TargetSpec {
  id: string;
  /** Requested harness version range (never the locally installed version). */
  version: string;
  delivery: "package" | "project";
  output: string;
  /** npm coordinate for this target's output; see `TargetConfig.npmName`. */
  npmName?: string;
}

export function targetSpecFromConfig(id: string, target: TargetConfig): TargetSpec {
  return {
    id,
    version: target.version,
    delivery: target.delivery,
    output: target.output,
    ...(target.npmName === undefined ? {} : { npmName: target.npmName }),
  };
}

/**
 * One capability's support on a target range. Non-exact levels must carry a
 * rationale, enforced by `describeAdapterContract` in `@hooknostic/testkit` --
 * which every shipped adapter runs, and which a third-party adapter should.
 */
export interface CapabilityEntry {
  level: SupportLevel;
  rationale?: string;
}

/** Capabilities absent from the matrix are `unsupported`. */
export type CapabilityMatrix = Partial<Record<CapabilityId, CapabilityEntry>>;

/**
 * Per-harness version metadata: the single source the rest of the repository
 * derives its version literals from. Profiles record what was *validated*;
 * this records what is *recommended* and what the tests exercise.
 * Contract-audited by `describeAdapterContract` (recommendedRange must be a
 * subset of profile coverage, referenceVersion must be a captured build, and
 * fixtureDir must match the adapter's fixture directory basename).
 */
export interface HarnessMetadata {
  /** Human name for docs and generated tables, e.g. "Claude Code". */
  readonly displayName: string;
  /**
   * The range this project recommends consumers target. Deliberately allowed
   * to be narrower than the widest validated profile range.
   */
  readonly recommendedRange: string;
  /** Basename of the adapter's fixture directory, e.g. "2.1". */
  readonly fixtureDir: string;
  /**
   * The exact harness build tests pass as `InvocationContext.harnessVersion`.
   * Must satisfy `recommendedRange` and appear as a `captured` validation
   * record in some profile.
   */
  readonly referenceVersion: string;
}

/**
 * How a validation fact was established. Mirrors the provenance classes the
 * capture discipline records (see `.agents/skills/harness-capture/SKILL.md`);
 * `router-log` is the carved exception for shapes observed one level below
 * the hook boundary.
 */
export type ValidationMethod =
  "captured" | "live-probe" | "schema-derived" | "type-derived" | "doc-derived" | "router-log";

/** One validation event: which build, when, how, and what it established. */
export interface ValidationRecord {
  /** Exact harness version, e.g. "2.1.250". */
  readonly version: string;
  /** ISO date (yyyy-mm-dd) of the validation session. */
  readonly date: string;
  readonly method: ValidationMethod;
  /** Repo-relative evidence path, e.g. "fixtures/claude/2.1". */
  readonly artifact?: string;
  /** What this run established, one line. */
  readonly what: string;
}

/**
 * Capability support is a function of harness *and version*. Adapters encode
 * it as data — versioned profiles — rather than scattering version checks.
 */
export interface CapabilityProfile {
  /** Semver range of native harness versions this matrix was validated for. */
  range: string;
  matrix: CapabilityMatrix;
  /** Provenance: structured validation events, not prose. */
  source: {
    date: string;
    validatedOn: readonly ValidationRecord[];
    /** Non-version notes that are not validation events (e.g. doc URLs). */
    notes?: readonly string[];
  };
}

export interface CapabilityResolutionResult {
  matrix?: CapabilityMatrix;
  /** Profiles that intersected the requested range, in declaration order. */
  profilesUsed: CapabilityProfile[];
  diagnostics: Diagnostic[];
}

export interface DetectionResult {
  installed: boolean;
  version?: string;
  detail?: string;
}

/**
 * A generated file. `path` is a POSIX-style relative path inside the target's
 * output directory: no absolute paths, no backslashes, no `.`/`..`/empty
 * segments, unique within the artifact set (enforced by the build pipeline as
 * HN301 before anything is staged). `executable` requests mode 0o755 on POSIX
 * filesystems.
 */
export interface GeneratedArtifact {
  path: string;
  contents: string | Uint8Array;
  /** Permission bits to preserve for copied package files. */
  mode?: number;
  executable?: boolean;
}

/** The bundled portable runtime + user handlers, duplicated per target. */
export interface RuntimeBundle {
  /** Self-contained ESM source of the dispatch bundle. */
  code: string;
}

/** Effective build-wide inputs adapters may translate into native manifests. */
export interface AdapterCompileOptions {
  runtime: Required<RuntimePolicy>;
}

/** Per-invocation context handed to runtime decode/apply. */
export interface InvocationContext {
  targetId: string;
  harnessVersion?: string;
}

export interface NativeHookResult {
  /** JSON-serializable native response body, when the protocol uses one. */
  body?: unknown;
  /** Process exit code for command-hook protocols. */
  exitCode?: number;
  /** Text for stderr, e.g. native blocking-reason channels. */
  stderr?: string;
}

export interface RuntimeAdapter {
  decode(nativeEvent: unknown, invocation: InvocationContext): Promise<HookEvent>;
  apply(result: HookResult, nativeEvent: unknown, invocation: InvocationContext): Promise<NativeHookResult>;
}

/** Build-time inputs for generating a target's shim entry module source. */
export interface ShimEntryOptions {
  targetId?: string;
  /** Import path of the user's plugin entry module (POSIX separators). */
  entryImportPath: string;
  /** Resolved capability levels for the target range. */
  capabilities: Partial<Record<CapabilityId, SupportLevel>>;
  /** Target compatibility floor used for policy-aware runtime detection. */
  minimumCapabilityLevel: SupportLevel;
  /** Effective runtime policy. */
  policy: {
    onHookError: "continue" | "block";
    timeoutMs: number;
    contextCharLimit: number;
    notifyCharLimit: number;
  };
  harnessVersion?: string;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly adapterVersion: string;
  projectComponentProfiles?: readonly AgentPluginProjectionProfile[];
  projectPaths?: readonly string[];
  projectComponents?(
    source: ProjectComponents,
    root: string,
    output: string,
    config: string,
    options: ProjectComponentOptions,
  ): Promise<ProjectIntegration>;
  projectIntegration?(
    artifacts: readonly GeneratedArtifact[],
    outputFromRoot: string,
    configFromRoot: string,
  ): ProjectIntegration;
  /** Project MCP options this adapter can encode without dropping policy. */
  projectMcpOptions?: { startupTimeoutMs?: true };

  /** Per-harness version metadata; see {@link HarnessMetadata}. */
  readonly harness: HarnessMetadata;

  /** Ranges with validated capability data, in profile declaration order. */
  supportedHarnessVersions(): string[];

  /** Artifact modes this adapter can emit for its validated implementation. */
  supportedDeliveries(): readonly TargetSpec["delivery"][];

  /**
   * Source of the per-target shim entry module that the build pipeline
   * bundles (user entry + portable runtime + adapter runtime) into the
   * self-contained artifact.
   */
  shimEntry?(options: ShimEntryOptions): string;

  /**
   * How the harness runs the generated artifact: `"command"` spawns it as a
   * process (`node <artifact>`, stdin/stdout protocol), `"module"` imports it
   * in-process. Undeclared means unknown.
   *
   * This is not cosmetic — it decides whether `process.argv[1]` inside the
   * artifact *is* the artifact, which is what makes a bundled CLI main-module
   * guard fire (HN502) on command-executed targets and stay dormant on
   * imported ones.
   */
  readonly shimExecution?: "command" | "module";

  /**
   * Module-specifier aliases needed to bundle the shim entry. User projects
   * depend only on the SDK, so each adapter maps its own shim specifier to a
   * concrete file path resolved from the adapter package itself.
   */
  shimAliases?(): Record<string, string>;

  /**
   * The two-way shell codec this adapter's shim passes to `dispatch()` --
   * built with `shellCodec()` from a per-tool shape table. Required in
   * practice for any adapter whose fixtures carry a `tool.shell` view:
   * `describeAdapterContract` asserts the codec round-trips every such
   * fixture, so the normalized read and the `updateShell` write cannot skew.
   */
  readonly shellCodec?: ShellCodec;

  /**
   * The shape table the codec was built from. Exposed so the contract suite
   * can audit COVERAGE from the table side: every entry must be backed by a
   * shell-bearing fixture, or a new entry ships silently untested.
   */
  readonly shellShapes?: ShellShapes;

  /**
   * Resolve the capability matrix for a target's requested version range.
   * Implementations should delegate to {@link resolveCapabilityMatrix}.
   */
  capabilities(target: TargetSpec): CapabilityResolutionResult;

  /** Detect the locally installed harness for `doctor`, where feasible. */
  detect?(): Promise<DetectionResult>;

  /** Optional complete Agent Plugins package projector for this harness. */
  readonly agentPluginProjector?: AgentPluginProjector<TargetSpec>;

  compile(
    plugin: PluginIR,
    target: TargetSpec,
    bundle: RuntimeBundle,
    options: AdapterCompileOptions,
  ): Promise<GeneratedArtifact[]>;

  validateArtifacts?(artifacts: GeneratedArtifact[], target: TargetSpec): Promise<Diagnostic[]>;

  runtime: RuntimeAdapter;
}

export type AdapterRegistry = Record<string, HarnessAdapter>;
