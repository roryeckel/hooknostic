import type { AgentDefinition } from "./agent-definitions.js";

export const AGENT_PLUGIN_MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" as const;
export const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" as const;

export interface AgentPluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface AgentPluginManifest {
  $schema: typeof AGENT_PLUGIN_MANIFEST_SCHEMA;
  name: string;
  version?: string;
  description?: string;
  author?: AgentPluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, Record<string, unknown>>;
}

export interface AgentPluginStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface AgentPluginRemoteServer {
  type: "streamable-http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type AgentPluginMcpServer = AgentPluginStdioServer | AgentPluginRemoteServer;

export interface AgentPluginMcpConfig {
  $schema: typeof AGENT_PLUGIN_MCP_SCHEMA;
  mcpServers: Record<string, AgentPluginMcpServer>;
}

export interface AgentPluginSkill {
  name: string;
  description: string;
  directory: string;
  manifestPath: string;
}

/** Materialized package file. `contents` may be binary; `mode` is canonical 0644 or 0755. */
export interface AgentPluginFile {
  path: string;
  contents: Uint8Array;
  mode: number;
}

export type AgentPluginIssueSeverity = "error" | "warn" | "info";
export type AgentPluginIssueScope = "manifest" | "skill" | "mcp" | "agent" | "file" | "projection";

export interface AgentPluginIssue {
  severity: AgentPluginIssueSeverity;
  scope: AgentPluginIssueScope;
  message: string;
  path?: string;
  component?: ComponentId;
}

export interface AgentPluginPackage {
  specVersion: "1.0.0";
  root: string;
  manifest: AgentPluginManifest;
  skills: AgentPluginSkill[];
  mcp?: AgentPluginMcpConfig;
  files: AgentPluginFile[];
  /** Included package-relative directories, excluding the root itself. */
  directories?: readonly string[];
  /** Digest of inventoried files, including their paths, bytes, and modes. */
  contentDigest: string;
}

export interface LoadAgentPluginOptions {
  root: string;
  /** Exact, case-sensitive POSIX paths of included files to emit as 0755; others use 0644. */
  executableFiles?: string[];
  /**
   * Canonical package-relative roots whose files will be supplied after package
   * inventory. Missing contained MCP commands beneath one of these roots are
   * retained for a later final-tree validation.
   */
  deferredCommandRoots?: readonly string[];
  /**
   * POSIX-style package-relative exclusion globs, added to the built-in set
   * (`.git`, `node_modules`, `.env`, `.env.*`, `.npmrc` at any depth; see
   * `AGENT_PLUGIN_DEFAULT_EXCLUDED_NAMES`). Patterns match case-insensitively
   * on every platform, since the package is installed on case-insensitive
   * filesystems whatever built it. Excluding `mcp.json`, a skill
   * directory, or its `SKILL.md` removes that component. `plugin.json` is
   * mandatory and cannot be excluded.
   */
  exclude?: string[];
}

export interface LoadAgentPluginResult {
  package?: AgentPluginPackage;
  issues: AgentPluginIssue[];
}

export const AGENT_PLUGIN_COMPONENT_IDS = [
  "agent-plugin.manifest",
  "agent-plugin.skills",
  "agent-plugin.mcp.stdio",
  "agent-plugin.mcp.streamable-http",
  "agent-plugin.mcp.sse",
  "agent-plugin.client-extension.files",
  "agent-plugin.runtime-package",
] as const;

export type AgentPluginComponentId = (typeof AGENT_PLUGIN_COMPONENT_IDS)[number];

/**
 * Agent definitions (ADR-0027). Not an Agent Plugins 1.0 component -- the
 * standard leaves agents out until their formats converge -- but delivered and
 * reported through the same profiles, levels and shortfall policy, so both
 * share one id space. `agents.definition` is the portable core (name,
 * description, instructions); `agents.native` is the per-harness
 * passthrough under `native`.
 */
export const AGENT_COMPONENT_IDS = ["agents.definition", "agents.native"] as const;
export type AgentComponentId = (typeof AGENT_COMPONENT_IDS)[number];

/** Every component a projector or project integrator reports on. */
export const COMPONENT_IDS = [...AGENT_PLUGIN_COMPONENT_IDS, ...AGENT_COMPONENT_IDS] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export type AgentPluginProjectionSupportLevel = "exact" | "emulated" | "approximate" | "unsupported";

/**
 * A known way a harness departs from Agent Plugins 1.0 for some instances of a
 * component (ADR-0019).
 *
 * Declared on the profile, next to the level, because it is a fact about a
 * harness version range: a range that no longer declares it stops reporting
 * it. It is not a level. A level describes every instance, and an `emulated`
 * component still conforms. A deviation applies only to packages containing
 * the triggering text, and those packages do not get what the specification
 * says.
 */
export interface AgentPluginDeviationDeclaration {
  /** Stable kebab-case id, unique within the adapter; `<adapter>:<id>` qualifies it. */
  id: string;
  /** What the harness does instead, in one sentence. */
  summary: string;
  /** The capture establishing it; must also be one of the profile's `validatedOn` artifacts. */
  evidence: string;
}

/**
 * A known way the projection itself falls short of its component's level for
 * some instances (ADR-0021).
 *
 * The counterpart of a deviation: there the harness departs from the
 * specification, here Hooknostic cannot deliver its own translation for one
 * item -- an OpenCode skill it cannot name for its plugin, say. The item is
 * still emitted. Declared on the profile with the capture that makes the
 * translation necessary, so a range that no longer needs it stops reporting it.
 */
export type AgentPluginDegradationDeclaration = AgentPluginDeviationDeclaration;

export interface AgentPluginComponentSupport {
  level: AgentPluginProjectionSupportLevel;
  rationale?: string;
  deviations?: readonly AgentPluginDeviationDeclaration[];
  degradations?: readonly AgentPluginDegradationDeclaration[];
}

/** One instance of a declared deviation found in the package being projected. */
export interface AgentPluginDeviation {
  /** A declaration id from the resolved matrix cell for `component`. */
  id: string;
  component: ComponentId;
  /** The MCP server, skill or other named item it applies to. */
  name?: string;
  /** Package location, such as `mcp.json#server`. */
  path?: string;
  /** What in this instance triggers it. */
  reason: string;
}

/** One instance of a declared degradation, in the same shape as a deviation. */
export type AgentPluginDegradation = AgentPluginDeviation;

export interface AgentPluginProjectionProfile {
  range: string;
  components: Partial<Record<ComponentId, AgentPluginComponentSupport>>;
  source: {
    date: string;
    validatedOn: readonly {
      version: string;
      date: string;
      method: "captured" | "live-probe" | "schema-derived" | "type-derived" | "doc-derived";
      artifact?: string;
      what: string;
    }[];
    notes?: readonly string[];
  };
}

export interface AgentPluginProjectionFile {
  path: string;
  contents: string | Uint8Array;
  mode?: number;
  executable?: boolean;
}

export interface AgentPluginProjectionTarget {
  id: string;
  version: string;
  delivery: "package" | "project";
}

export interface AgentPluginRuntimePackage {
  /** Package-root-relative source path for the manifest. */
  manifest: string;
  /** Package-root-relative source path for the npm lockfile. */
  lockfile: string;
  /**
   * Dependency names allowed to declare an npm lifecycle install script. The
   * script still never runs; this records that the author verified the package
   * works without it.
   */
  allowInstallScripts?: readonly string[];
}

export interface AgentPluginProjectionContext<TTarget = AgentPluginProjectionTarget> {
  target: TTarget;
  /**
   * The compiled hook artifacts. A projection replaces the target's output
   * wholesale, so every one of these paths must appear in the returned plan or
   * the installed package runs no hooks; core fails the target if any is
   * missing. Contents may be rewritten -- Claude merges its own hooks document
   * into the generated one -- but a path may not be dropped.
   */
  hookArtifacts: readonly AgentPluginProjectionFile[];
  runtimePackage?: AgentPluginRuntimePackage;
  /**
   * Opaque package trees author-supplied providers produced for this projector.
   *
   * Handed over as bytes rather than a path because the package root is
   * read-only input (ADR-0011) and because where a tree has to land differs by
   * adapter: it must be reachable from that harness's own plugin root, which
   * for OpenCode is the nested `package/` directory rather than the output.
   */
  materializedTrees?: readonly {
    provider: string;
    /** Destination relative to this projector's plugin root. */
    into: string;
    files: readonly { path: string; contents: Uint8Array; mode: 0o644 | 0o755 }[];
  }[];
  /**
   * This projector's own `profiles`, resolved against the target's version
   * range. Supplied rather than re-derived so a projector cannot disagree with
   * the matrix the build reports and `onUnsupported` acts on: a range spanning
   * several profiles resolves to the least capable level per component, and a
   * projector reimplementing that resolution would drift from it silently.
   *
   * A component absent from the map is `unsupported`.
   */
  support: Partial<Record<ComponentId, AgentPluginComponentSupport>>;
  onUnsupported: "error" | "warn";
  /**
   * Ambient variable NAMES each MCP server reads, keyed by server name.
   *
   * Names only. A projector whose harness starts a server with the environment
   * it was launched with ignores this; one that withholds it forwards exactly
   * these. It arrives from `components.mcpEnvironment` rather than from the
   * package, because a package cannot ask: unrecognized placeholder-like text
   * MUST remain literal (ADR-0011, ADR-0018).
   */
  mcpEnvironment?: Readonly<Record<string, readonly string[]>>;
  /**
   * Agent definitions configured beside the package (`components.agents`,
   * ADR-0027). They are Hooknostic input, like hook source, not package
   * content, so they arrive here rather than in the package: the Agent Plugins
   * 1.0 format has no agents component to carry them.
   */
  agents?: readonly AgentDefinition[];
}

export interface AgentPluginProjectionSummary {
  components: Partial<Record<ComponentId, { discovered: number; emitted: number; skipped: number }>>;
  omissions: { component: ComponentId; name?: string; reason: string }[];
  /**
   * Emitted items the harness will treat differently from the specification.
   * Reported here, not as issues: core applies `components.onDeviation` and
   * checks each id against the resolved matrix, so no projector chooses the
   * severity itself.
   */
  deviations?: AgentPluginDeviation[];
  /**
   * Emitted items the projection could not deliver at its component's level.
   * Reported here for the same reason as deviations: core applies
   * `components.onDegraded` and checks each id against the resolved matrix.
   */
  degradations?: AgentPluginDegradation[];
  /**
   * Plan paths copied byte-for-byte from the source package after overlay
   * resolution, sorted. Every other plan file the projector generated, so this
   * is also how a consumer tells the two apart without knowing the harness's
   * own path layout.
   */
  copiedPaths: readonly string[];
}

export interface AgentPluginProjectionPlan {
  files: AgentPluginProjectionFile[];
  /** Directories required by the projection, including those with no files. */
  directories?: readonly string[];
  issues: AgentPluginIssue[];
  summary: AgentPluginProjectionSummary;
}

export interface AgentPluginProjector<TTarget = AgentPluginProjectionTarget> {
  namespace: string;
  profiles: readonly AgentPluginProjectionProfile[];
  /**
   * Where the package's own files land in the projected output, as a POSIX
   * path relative to it -- the directory `${PLUGIN_ROOT}` names. Default `"."`.
   */
  packageRoot?: string;
  /**
   * Whether this projector renames skills for their plugin, which is what
   * makes `TargetSpec.skillNames` mean anything. Undeclared reads as no, and
   * a build that sets `skillNames` for such a projector fails (ADR-0021).
   */
  qualifiesSkillNames?: boolean;
  /**
   * The resolved support for one target, adjusted for target options this
   * projector reads. Profiles describe the harness; an option such as
   * `skillNames: "authored"` changes what the projection does with it, and
   * so the level and declarations the build reports. Pure: it may depend on
   * the target and the matrix only.
   */
  supportFor?(
    target: TTarget,
    matrix: Partial<Record<ComponentId, AgentPluginComponentSupport>>,
  ): Partial<Record<ComponentId, AgentPluginComponentSupport>>;
  project(
    source: AgentPluginPackage,
    context: AgentPluginProjectionContext<TTarget>,
  ): Promise<AgentPluginProjectionPlan>;
}
