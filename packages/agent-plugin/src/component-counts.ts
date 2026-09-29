import type { AgentDefinition } from "./agent-definitions.js";
import {
  AGENT_PLUGIN_COMPONENT_IDS,
  type AgentPluginPackage,
  type AgentPluginProjectionPlan,
  type ComponentId,
} from "./types.js";

export interface ComponentDiscoveryOptions {
  /**
   * The reverse-DNS client-extension namespace this projector supports, if any.
   *
   * Support may be native or an evidence-backed bridge into the harness's own
   * format. Leave this unset when neither exists. Agent Plugins 1.0 registers
   * no namespaces -- it only says a client SHOULD base one on a domain it
   * controls -- so inventing one still makes
   * `agent-plugin.client-extension.files` discoverable without a contract the
   * projector can faithfully deliver.
   */
  namespace?: string;
  hasRuntimePackage?: boolean;
  /** Agent definitions configured beside the package (ADR-0027). */
  agents?: readonly AgentDefinition[];
  /** The harness key whose `native` blocks `agents.native` counts. */
  harness?: string;
}

export interface ComponentSummaryOptions extends ComponentDiscoveryOptions {
  /** How many of `discovered` this projector will not hand the harness. */
  skipped?: (component: ComponentId, discovered: number) => number;
}

/**
 * Every component a package build carries, with how many items each has.
 *
 * The one discovery the analysis phase, the analyzed report and every projector
 * share: the build report replaces the analyzed counts with the projector's, so
 * two discoveries that disagree are a standing chance for a component the
 * analysis phase saw to vanish from the report.
 */
export function discoverComponents(
  source: AgentPluginPackage,
  options: ComponentDiscoveryOptions = {},
): Map<ComponentId, number> {
  const namespace = options.namespace ?? "";
  const discovered = new Map<ComponentId, number>([["agent-plugin.manifest", 1]]);

  if (source.skills.length > 0) discovered.set("agent-plugin.skills", source.skills.length);

  for (const id of AGENT_PLUGIN_COMPONENT_IDS) {
    if (!id.startsWith("agent-plugin.mcp.")) continue;
    const transport = id.slice("agent-plugin.mcp.".length);
    const servers = Object.values(source.mcp?.mcpServers ?? {}).filter((server) => server.type === transport);
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

  const agents = options.agents ?? [];
  if (agents.length > 0) discovered.set("agents.definition", agents.length);
  const harness = options.harness;
  const native = harness === undefined ? 0 : agents.filter((agent) => Object.hasOwn(agent.native, harness)).length;
  if (native > 0) discovered.set("agents.native", native);

  return discovered;
}

/**
 * What a projector found in the package, and how much of it the harness gets.
 * Only presence is decided here; the emitted/skipped split is per-harness and
 * comes from `skipped`.
 */
export function componentSummary(
  source: AgentPluginPackage,
  options: ComponentSummaryOptions = {},
): AgentPluginProjectionPlan["summary"]["components"] {
  const components: AgentPluginProjectionPlan["summary"]["components"] = {};
  for (const [component, count] of discoverComponents(source, options)) {
    const skipped = Math.min(options.skipped?.(component, count) ?? 0, count);
    components[component] = { discovered: count, emitted: count - skipped, skipped };
  }
  return components;
}

/**
 * Guards the one invariant every Agent Plugin projector shares: it runs for
 * package delivery only.
 *
 * `build.ts` enforces this by construction -- the projection phase is gated on
 * `delivery === "package"` -- and `inspect` routes a project-delivery query to
 * `projectComponentProfiles` instead. Project delivery goes through
 * `adapter.projectComponents`, which edits a tree the user owns rather than
 * emitting one the adapter owns.
 *
 * Nothing enforced it at the projector's own entry point, though, and
 * `project()` takes a `TargetSpec` carrying a `delivery` it otherwise ignores.
 * A caller passing "project" therefore got package-shaped output and no
 * complaint -- which is exactly how a playback cell came to assert a layout no
 * build produces, and stayed plausible until package delivery changed shape
 * underneath it. Failing here turns that into one legible line at the call
 * site, before a harness runs.
 */
export function assertPackageDelivery(id: string, delivery: string): void {
  if (delivery === "package") return;
  throw new Error(
    `${id}: the Agent Plugin projector runs for package delivery only, got ${JSON.stringify(delivery)}. ` +
      `Project delivery goes through adapter.projectComponents and adapter.projectComponentProfiles.`,
  );
}
