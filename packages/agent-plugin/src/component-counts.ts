import {
  AGENT_PLUGIN_COMPONENT_IDS,
  type AgentPluginComponentId,
  type AgentPluginPackage,
  type AgentPluginProjectionPlan,
} from "./types.js";

export interface ComponentSummaryOptions {
  /**
   * The reverse-DNS client-extension namespace this harness reads, if any.
   *
   * Leave it unset when the harness reads none. Agent Plugins 1.0 registers no
   * namespaces -- it only says a client SHOULD base one on a domain it controls
   * -- so a namespace is only real once the harness actually consumes it.
   * Naming one the harness ignores makes `agent-plugin.client-extension.files`
   * discoverable against something nothing reads, and the build then reports
   * the component as projected.
   */
  namespace?: string;
  hasRuntimePackage?: boolean;
  /** How many of `discovered` this projector will not hand the harness. */
  skipped?: (component: AgentPluginComponentId, discovered: number) => number;
}

/**
 * What a projector found in the package, and how much of it the harness gets.
 *
 * Discovery mirrors core's own (`discoveredComponents`), which is the point of
 * sharing it: the build report replaces the analyzed counts with the
 * projector's, so a projector counting for itself is a standing chance for a
 * component the analysis phase saw to vanish from the report. Only presence is
 * decided here; the emitted/skipped split is per-harness and comes from
 * `skipped`.
 */
export function componentSummary(
  source: AgentPluginPackage,
  options: ComponentSummaryOptions = {},
): AgentPluginProjectionPlan["summary"]["components"] {
  const namespace = options.namespace ?? "";
  const discovered = new Map<AgentPluginComponentId, number>([["agent-plugin.manifest", 1]]);

  if (source.skills.length > 0) discovered.set("agent-plugin.skills", source.skills.length);

  for (const id of AGENT_PLUGIN_COMPONENT_IDS) {
    if (!id.startsWith("agent-plugin.mcp.")) continue;
    const transport = id.slice("agent-plugin.mcp.".length);
    const servers = Object.values(source.mcp?.mcpServers ?? {}).filter(
      (server) => server.type === transport,
    );
    if (servers.length > 0) discovered.set(id, servers.length);
  }

  if (namespace !== "") {
    const files = source.files.filter((file) => file.path.startsWith(`${namespace}/`)).length;
    const manifestExtension = source.manifest.extensions?.[namespace] === undefined ? 0 : 1;
    if (files + manifestExtension > 0) {
      discovered.set("agent-plugin.client-extension.files", files + manifestExtension);
    }
  }

  if (options.hasRuntimePackage === true) discovered.set("agent-plugin.runtime-package", 1);

  const components: AgentPluginProjectionPlan["summary"]["components"] = {};
  for (const [component, count] of discovered) {
    const skipped = Math.min(options.skipped?.(component, count) ?? 0, count);
    components[component] = { discovered: count, emitted: count - skipped, skipped };
  }
  return components;
}
