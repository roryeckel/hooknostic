import type {
  CapabilityId,
  HookEvent,
  HookResult,
  ShellCodec,
  ShellShapes,
  SupportLevel,
  TargetConfig,
  RuntimePolicy,
} from "@hooknostic/sdk";
import type { Diagnostic } from "./diagnostics.js";
import type { PluginIR } from "./ir.js";

/** A configured build target: config entry keyed by adapter/target id. */
export interface TargetSpec {
  id: string;
  /** Requested harness version range (never the locally installed version). */
  version: string;
  mode: "plugin" | "local";
  output: string;
}

export function targetSpecFromConfig(id: string, target: TargetConfig): TargetSpec {
  return { id, version: target.version, mode: target.mode, output: target.output };
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
 * Capability support is a function of harness *and version*. Adapters encode
 * it as data — versioned profiles — rather than scattering version checks.
 */
export interface CapabilityProfile {
  /** Semver range of native harness versions this matrix was validated for. */
  range: string;
  matrix: CapabilityMatrix;
  /** Provenance: when and from what sources the profile was derived. */
  source?: {
    date: string;
    references?: string[];
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
  contents: string;
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
  apply(
    result: HookResult,
    nativeEvent: unknown,
    invocation: InvocationContext,
  ): Promise<NativeHookResult>;
}

/** Build-time inputs for generating a target's shim entry module source. */
export interface ShimEntryOptions {
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

  /** Ranges with validated capability data, in profile declaration order. */
  supportedHarnessVersions(): string[];

  /** Artifact modes this adapter can emit for its validated implementation. */
  supportedModes(): readonly TargetSpec["mode"][];

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

  compile(
    plugin: PluginIR,
    target: TargetSpec,
    bundle: RuntimeBundle,
    options: AdapterCompileOptions,
  ): Promise<GeneratedArtifact[]>;

  validateArtifacts?(
    artifacts: GeneratedArtifact[],
    target: TargetSpec,
  ): Promise<Diagnostic[]>;

  runtime: RuntimeAdapter;
}

export type AdapterRegistry = Record<string, HarnessAdapter>;
