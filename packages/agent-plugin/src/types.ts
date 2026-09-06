export const AGENT_PLUGIN_MANIFEST_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" as const;
export const AGENT_PLUGIN_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" as const;

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

/** Materialized package file. `contents` may be binary; `mode` is permission bits only. */
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
  contentDigest: string;
}

export interface LoadAgentPluginOptions {
  root: string;
  /**
   * POSIX-style package-relative exclusion globs. `.git` is always excluded.
   * Excluding `mcp.json`, a skill directory, or its `SKILL.md` removes that
   * component. `plugin.json` is mandatory and cannot be excluded.
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
export type AgentPluginProjectionSupportLevel =
  | "exact"
  | "emulated"
  | "approximate"
  | "unsupported";

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
  mode: "plugin" | "local";
}

export interface AgentPluginRuntimePackage {
  /** Package-root-relative source path for the manifest. */
  manifest: string;
  /** Package-root-relative source path for the npm lockfile. */
  lockfile: string;
}

export interface AgentPluginProjectionContext<TTarget = AgentPluginProjectionTarget> {
  target: TTarget;
  hookArtifacts: readonly AgentPluginProjectionFile[];
  runtimePackage?: AgentPluginRuntimePackage;
  onUnsupported: "error" | "warn";
}

export interface AgentPluginProjectionSummary {
  components: Partial<
    Record<AgentPluginComponentId, { discovered: number; emitted: number; skipped: number }>
  >;
  omissions: { component: AgentPluginComponentId; name?: string; reason: string }[];
  /** Source-package files copied byte-for-byte after overlay resolution. */
  copiedFileCount: number;
}

export interface AgentPluginProjectionPlan {
  files: AgentPluginProjectionFile[];
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
