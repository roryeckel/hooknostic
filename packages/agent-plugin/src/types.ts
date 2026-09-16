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
export type AgentPluginIssueScope = "manifest" | "skill" | "mcp" | "file" | "projection";

export interface AgentPluginIssue {
  severity: AgentPluginIssueSeverity;
  scope: AgentPluginIssueScope;
  message: string;
  path?: string;
  component?: AgentPluginComponentId;
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
export type AgentPluginProjectionSupportLevel = "exact" | "emulated" | "approximate" | "unsupported";

export interface AgentPluginComponentSupport {
  level: AgentPluginProjectionSupportLevel;
  rationale?: string;
}

export interface AgentPluginProjectionProfile {
  range: string;
  components: Partial<Record<AgentPluginComponentId, AgentPluginComponentSupport>>;
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
   * Runtimes Hooknostic installed at build time, for this projector to place.
   *
   * Handed over as bytes rather than a path because the package root is
   * read-only input (ADR-0011) and because where a tree has to land differs by
   * adapter: it must be reachable from that harness's own plugin root, which
   * for OpenCode is the nested `package/` directory rather than the output.
   */
  materializedRuntimes?: readonly {
    ecosystem: string;
    /** Destination relative to this projector's plugin root. */
    into: string;
    files: readonly { path: string; contents: Uint8Array }[];
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
  support: Partial<Record<AgentPluginComponentId, AgentPluginComponentSupport>>;
  onUnsupported: "error" | "warn";
}

export interface AgentPluginProjectionSummary {
  components: Partial<Record<AgentPluginComponentId, { discovered: number; emitted: number; skipped: number }>>;
  omissions: { component: AgentPluginComponentId; name?: string; reason: string }[];
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
  project(
    source: AgentPluginPackage,
    context: AgentPluginProjectionContext<TTarget>,
  ): Promise<AgentPluginProjectionPlan>;
}
