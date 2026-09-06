import { AGENT_PLUGIN_COMPONENT_IDS, type AgentPluginComponentId } from "@hooknostic/agent-plugin";
import type { AdapterRegistry } from "@hooknostic/core";
import { resolveAgentPluginProjection } from "@hooknostic/core";
import type { CapabilityId } from "@hooknostic/sdk";
import { ALL_CAPABILITY_IDS, isCapabilityId } from "@hooknostic/sdk";
import type { CommandIO } from "./check.js";

export interface InspectCommandOptions {
  target: string;
  capability?: string;
  component?: string;
  /** Harness version range to resolve; defaults to the adapter's first validated range. */
  version?: string;
  json?: boolean;
  registry: AdapterRegistry;
  io: CommandIO;
}

/**
 * `hooknostic inspect <target>` — why does this adapter map a capability or
 * event the way it does? Renders the adapter-owned capability matrix with
 * rationale and provenance-bearing version ranges.
 */
export async function runInspect(options: InspectCommandOptions): Promise<number> {
  const adapter = Object.hasOwn(options.registry, options.target)
    ? options.registry[options.target]
    : undefined;
  if (!adapter) {
    options.io.stderr(
      `unknown target "${options.target}"; available: ${Object.keys(options.registry).join(", ")}`,
    );
    return 2;
  }
  if (options.capability !== undefined && !isCapabilityId(options.capability)) {
    options.io.stderr(
      `unknown capability "${options.capability}"; run \`hooknostic inspect ${options.target}\` without --capability to list valid capability IDs.`,
    );
    return 2;
  }
  if (
    options.component !== undefined &&
    !AGENT_PLUGIN_COMPONENT_IDS.includes(options.component as AgentPluginComponentId)
  ) {
    options.io.stderr(
      `unknown component "${options.component}"; valid Agent Plugin component IDs: ${AGENT_PLUGIN_COMPONENT_IDS.join(", ")}.`,
    );
    return 2;
  }
  if (options.capability !== undefined && options.component !== undefined) {
    options.io.stderr("--capability and --component are mutually exclusive.");
    return 2;
  }

  // Default to the RECOMMENDED range, not the widest validated one: without
  // --version this command should answer for the range users are told to
  // target, which can be deliberately narrower than the validated union.
  const version = options.version ?? adapter.harness.recommendedRange;
  const resolved = adapter.capabilities({
    id: adapter.id,
    version,
    mode: "local",
    output: ".",
  });
  if (!resolved.matrix) {
    for (const diagnostic of resolved.diagnostics) {
      options.io.stderr(`${diagnostic.code}: ${diagnostic.message}`);
    }
    return 1;
  }

  const ids: CapabilityId[] =
    options.capability !== undefined
      ? [options.capability]
      : options.component !== undefined
        ? []
        : [...ALL_CAPABILITY_IDS];

  const rows = ids.map((id) => {
    const entry = resolved.matrix![id];
    return {
      capability: id,
      level: entry?.level ?? "unsupported",
      ...(entry?.rationale !== undefined ? { rationale: entry.rationale } : {}),
    };
  });
  const projection = adapter.agentPluginProjector
    ? resolveAgentPluginProjection(
        {
          id: adapter.id,
          version,
          mode: adapter.supportedModes()[0] ?? "local",
          output: ".",
        },
        adapter.agentPluginProjector,
      )
    : undefined;
  if (projection && !projection.matrix) {
    for (const diagnostic of projection.diagnostics) {
      options.io.stderr(`${diagnostic.code}: ${diagnostic.message}`);
    }
    return 1;
  }
  const componentIds: AgentPluginComponentId[] =
    options.component === undefined
      ? options.capability === undefined
        ? [...AGENT_PLUGIN_COMPONENT_IDS]
        : []
      : [options.component as AgentPluginComponentId];
  const componentRows = componentIds.map((id) => {
    const entry = projection?.matrix?.[id];
    return {
      component: id,
      level: entry?.level ?? "unsupported",
      ...(entry?.rationale === undefined ? {} : { rationale: entry.rationale }),
    };
  });

  if (options.json) {
    options.io.stdout(
      JSON.stringify(
        {
          schemaVersion: 2,
          command: "inspect",
          target: adapter.id,
          adapterVersion: adapter.adapterVersion,
          harness: adapter.harness,
          version,
          profiles: resolved.profilesUsed.map((p) => ({
            range: p.range,
            source: p.source,
          })),
          capabilities: rows,
          components: componentRows,
          projectionProfiles: projection?.profilesUsed ?? [],
        },
        null,
        2,
      ),
    );
    return 0;
  }

  options.io.stdout(
    `${adapter.id} (adapter ${adapter.adapterVersion}) — harness range ${version}`,
  );
  for (const profile of resolved.profilesUsed) {
    options.io.stdout(
      `profile ${profile.range}${profile.source ? ` (validated ${profile.source.date})` : ""}`,
    );
  }
  options.io.stdout("");
  for (const row of rows) {
    options.io.stdout(
      `${row.level.padEnd(12)} ${row.capability}${row.rationale ? `\n             ${row.rationale}` : ""}`,
    );
  }
  if (componentRows.length > 0) {
    options.io.stdout("");
    for (const row of componentRows) {
      options.io.stdout(
        `${row.level.padEnd(12)} ${row.component}${row.rationale ? `\n             ${row.rationale}` : ""}`,
      );
    }
  }
  return 0;
}
