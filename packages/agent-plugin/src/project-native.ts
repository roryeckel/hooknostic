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
}

/**
 * Components this package contains, and how many of each.
 *
 * Mirrors core's own discovery so that a component the analysis phase counted
 * cannot vanish from the build report, which replaces the analyzed counts with
 * these. Anything absent here is absent from the package.
 */
function discoveredComponentCounts(
  source: AgentPluginPackage,
  namespace: string,
  hasRuntimePackage: boolean,
): Map<AgentPluginComponentId, number> {
  const counts = new Map<AgentPluginComponentId, number>([["agent-plugin.manifest", 1]]);
  if (source.skills.length > 0) counts.set("agent-plugin.skills", source.skills.length);
  for (const id of AGENT_PLUGIN_COMPONENT_IDS) {
    if (!id.startsWith("agent-plugin.mcp.")) continue;
    const transport = id.slice("agent-plugin.mcp.".length);
    const servers = Object.values(source.mcp?.mcpServers ?? {}).filter(
      (server) => server.type === transport,
    );
    if (servers.length > 0) counts.set(id, servers.length);
  }
  if (namespace !== "") {
    const files = source.files.filter((file) => file.path.startsWith(`${namespace}/`)).length;
    const manifestExtension = source.manifest.extensions?.[namespace] === undefined ? 0 : 1;
    if (files + manifestExtension > 0) {
      counts.set("agent-plugin.client-extension.files", files + manifestExtension);
    }
  }
  if (hasRuntimePackage) counts.set("agent-plugin.runtime-package", 1);
  return counts;
}

/**
 * Build a projector that emits the portable package verbatim.
 *
 * Every file is passed through with its inventoried mode, so the emitted tree is
 * byte-identical to the filtered source and `summary.copiedPaths` covers all of
 * it -- there is no generated file to tell apart from copied content.
 *
 * An unsupported component is reported, not filtered. Filtering one out means
 * rewriting the file that declares it -- dropping an `sse` server would
 * re-serialize `mcp.json` -- which forfeits both the byte-identical guarantee
 * above and forward compatibility: the harness ignores the component today, so
 * passing it through is what makes it start working on an upgrade rather than
 * needing a rebuild to reappear. The summary therefore counts it as `skipped`
 * with an omission, because the report answers what the harness will act on,
 * not which bytes are on disk.
 */
export function createNativeAgentPluginProjector<TTarget>(
  options: NativeAgentPluginProjectorOptions,
): AgentPluginProjector<TTarget> {
  const namespace = options.namespace ?? "";
  return {
    namespace,
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
      // `copiedPaths`.
      files.push(...context.hookArtifacts.map((file) => ({ ...file })));

      const components: AgentPluginProjectionPlan["summary"]["components"] = {};
      const omissions: AgentPluginProjectionPlan["summary"]["omissions"] = [];
      const discovered = discoveredComponentCounts(
        source,
        namespace,
        context.runtimePackage !== undefined,
      );
      for (const [component, count] of discovered) {
        const unsupported = (context.support[component]?.level ?? "unsupported") === "unsupported";
        components[component] = {
          discovered: count,
          emitted: unsupported ? 0 : count,
          skipped: unsupported ? count : 0,
        };
        if (unsupported) {
          omissions.push({
            component,
            reason:
              "unsupported on this target; the package still carries it verbatim, but the harness does not consume it",
          });
        }
      }

      return {
        files,
        ...(source.directories === undefined ? {} : { directories: source.directories }),
        issues: [],
        summary: {
          components,
          omissions,
          copiedPaths: source.files
            .map((file) => file.path)
            .sort((a, b) => a.localeCompare(b)),
        },
      };
    },
  };
}
