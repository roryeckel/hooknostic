import {
  AGENT_PLUGIN_COMPONENT_IDS,
  type AgentPluginComponentId,
  type AgentPluginPackage,
  type AgentPluginProjectionContext,
  type AgentPluginProjectionFile,
  type AgentPluginProjectionPlan,
  type AgentPluginProjectionProfile,
  type AgentPluginProjector,
} from "./types.js";

/**
 * A projector for a harness that consumes an Agent Plugins package unmodified.
 *
 * Projection exists to translate the portable package into a proprietary native
 * layout. A harness that reads the specification directly needs none of that,
 * and the only thing it still needs from a build is the FILTERED package: a
 * native installer copies the plugin source wholesale, so the exclusion set is
 * what keeps worktrees, build output and scratch directories from shipping.
 *
 * Emitting a translation-free copy through the same projector slot keeps the
 * capability table, the build report and `hooknostic inspect` reporting on this
 * target like any other, rather than making native conformance an untracked
 * special case.
 */
export interface NativeAgentPluginProjectorOptions {
  profiles: readonly AgentPluginProjectionProfile[];
  /**
   * The reverse-DNS client-extension namespace this harness reads, if any.
   *
   * Omit it when the harness reads none. Agent Plugins 1.0 registers no
   * namespaces -- it only says a client SHOULD base one on a domain it controls
   * -- so a namespace is only real once the harness actually consumes it.
   * Inventing one would make `agent-plugin.client-extension.files` discoverable
   * against a namespace nothing reads, and the component would then be reported
   * as projected while the harness ignored it.
   */
  namespace?: string;
  /**
   * Set only if this harness loads hooks out of the installed package. Defaults
   * to `false`: Agent Plugins 1.0 defines no hook component, so a package is not
   * a hook channel unless the harness has its own convention on top.
   */
  deliversHooks?: boolean;
}

function identityComponentCounts(
  source: AgentPluginPackage,
): AgentPluginProjectionPlan["summary"]["components"] {
  const components: Partial<
    Record<AgentPluginComponentId, { discovered: number; emitted: number; skipped: number }>
  > = {};
  const count = (id: AgentPluginComponentId, n: number) => {
    if (n > 0) components[id] = { discovered: n, emitted: n, skipped: 0 };
  };
  count("agent-plugin.manifest", 1);
  count("agent-plugin.skills", source.skills.length);
  for (const id of AGENT_PLUGIN_COMPONENT_IDS) {
    if (!id.startsWith("agent-plugin.mcp.")) continue;
    const transport = id.slice("agent-plugin.mcp.".length);
    const servers = Object.values(source.mcp?.mcpServers ?? {}).filter(
      (server) => server.type === transport,
    );
    count(id, servers.length);
  }
  return components;
}

/**
 * Build a projector that emits the portable package verbatim.
 *
 * Every file is passed through with its inventoried mode, so the emitted tree is
 * byte-identical to the filtered source and `summary.copiedPaths` covers all of
 * it -- there is no generated file to tell apart from copied content.
 */
export function createNativeAgentPluginProjector<TTarget>(
  options: NativeAgentPluginProjectorOptions,
): AgentPluginProjector<TTarget> {
  const deliversHooks = options.deliversHooks ?? false;
  return {
    namespace: options.namespace ?? "",
    deliversHooks,
    profiles: options.profiles,
    project: async (
      source: AgentPluginPackage,
      context: AgentPluginProjectionContext<TTarget>,
    ): Promise<AgentPluginProjectionPlan> => {
      const files: AgentPluginProjectionFile[] = source.files.map((file) => ({
        path: file.path,
        contents: file.contents,
        mode: file.mode,
      }));
      // Generated beside the package, not copied from it, so they stay out of
      // `copiedPaths`. Only appended when this harness reads hooks from the
      // installed package; otherwise core writes them to the target's own output.
      if (deliversHooks) files.push(...context.hookArtifacts.map((file) => ({ ...file })));
      return {
        files,
        ...(source.directories === undefined ? {} : { directories: source.directories }),
        issues: [],
        summary: {
          components: identityComponentCounts(source),
          omissions: [],
          copiedPaths: source.files
            .map((file) => file.path)
            .sort((a, b) => a.localeCompare(b)),
        },
      };
    },
  };
}
