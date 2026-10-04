import { AGENT_PLUGIN_COMPONENT_IDS, type AgentPluginComponentId } from "@hooknostic/agent-plugin";
import type { AdapterRegistry } from "@hooknostic/core";
import { resolveAgentPluginProjection, resolveTargetAdapter } from "@hooknostic/core";
import type { CapabilityId, EventFieldId } from "@hooknostic/sdk";
import { ALL_CAPABILITY_IDS, ALL_EVENT_FIELD_IDS, isCapabilityId, isEventFieldId } from "@hooknostic/sdk";

import type { CommandIO } from "./check.js";

export interface InspectCommandOptions {
  target: string;
  delivery?: "project" | "package";
  capability?: string;
  component?: string;
  /** An optional event field id (ADR-0027). */
  field?: string;
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
  const errors: string[] = [];
  const failure = (): number => {
    if (options.json)
      options.io.stdout(JSON.stringify({ schemaVersion: 1, command: "inspect", ok: false, errors }, null, 2));
    else for (const message of errors) options.io.stderr(message);
    return 2;
  };
  let adapter = Object.hasOwn(options.registry, options.target) ? options.registry[options.target] : undefined;
  if (!adapter) {
    errors.push(`unknown target "${options.target}"; available: ${Object.keys(options.registry).join(", ")}`);
    return failure();
  }
  if (options.capability !== undefined && !isCapabilityId(options.capability)) {
    errors.push(
      `unknown capability "${options.capability}"; run \`hooknostic inspect ${options.target}\` without --capability to list valid capability IDs.`,
    );
    return failure();
  }
  if (
    options.component !== undefined &&
    !AGENT_PLUGIN_COMPONENT_IDS.includes(options.component as AgentPluginComponentId)
  ) {
    errors.push(
      `unknown component "${options.component}"; valid Agent Plugin component IDs: ${AGENT_PLUGIN_COMPONENT_IDS.join(", ")}.`,
    );
    return failure();
  }
  if (options.field !== undefined && !isEventFieldId(options.field)) {
    errors.push(
      `unknown field "${options.field}"; fields are named <event>.<path>, such as turn.stop.lastMessage or tool.before.correlation.toolCallId.`,
    );
    return failure();
  }
  if ([options.capability, options.component, options.field].filter((value) => value !== undefined).length > 1) {
    errors.push("--capability, --component and --field are mutually exclusive.");
    return failure();
  }

  // Default to the RECOMMENDED range, not the widest validated one: without
  // --version this command should answer for the range users are told to
  // target, which can be deliberately narrower than the validated union.
  const version = options.version ?? adapter.harness.recommendedRange;
  const selected = resolveTargetAdapter(adapter, {
    id: options.target,
    version,
    delivery: options.delivery ?? "project",
    output: ".",
  });
  if (!selected.adapter) {
    errors.push(...selected.diagnostics.map((d) => `${d.code}: ${d.message}`));
    return failure();
  }
  adapter = selected.adapter;
  const resolved = adapter.capabilities({
    id: adapter.id,
    version,
    delivery: "project",
    output: ".",
  });
  if (!resolved.matrix) {
    for (const diagnostic of resolved.diagnostics) {
      errors.push(`${diagnostic.code}: ${diagnostic.message}`);
    }
    return failure();
  }

  const single = options.capability ?? options.component ?? options.field;
  const ids: CapabilityId[] =
    options.capability !== undefined ? [options.capability] : single !== undefined ? [] : [...ALL_CAPABILITY_IDS];
  const fieldIds: EventFieldId[] =
    options.field !== undefined
      ? [options.field as EventFieldId]
      : single !== undefined
        ? []
        : [...ALL_EVENT_FIELD_IDS];
  const fieldRows = fieldIds.map((id) => {
    const entry = resolved.fields?.[id];
    return {
      field: id,
      level: entry?.level ?? "unsupported",
      ...(entry?.rationale !== undefined ? { rationale: entry.rationale } : {}),
    };
  });

  const rows = ids.map((id) => {
    const entry = resolved.matrix![id];
    return {
      capability: id,
      level: entry?.level ?? "unsupported",
      ...(entry?.rationale !== undefined ? { rationale: entry.rationale } : {}),
    };
  });
  const projector =
    options.delivery === "project"
      ? adapter.projectComponentProfiles
        ? { profiles: adapter.projectComponentProfiles }
        : undefined
      : adapter.agentPluginProjector;
  const projection =
    options.capability === undefined && options.field === undefined && projector
      ? resolveAgentPluginProjection(
          {
            id: adapter.id,
            version,
            delivery: adapter.supportedDeliveries()[0] ?? "project",
            output: ".",
          },
          projector,
        )
      : undefined;
  if (projection && !projection.matrix) {
    for (const diagnostic of projection.diagnostics) {
      errors.push(`${diagnostic.code}: ${diagnostic.message}`);
    }
    return failure();
  }
  const componentIds: AgentPluginComponentId[] =
    options.component === undefined
      ? single === undefined
        ? [...AGENT_PLUGIN_COMPONENT_IDS]
        : []
      : [options.component as AgentPluginComponentId];
  const componentRows = componentIds.map((id) => {
    const entry = projection?.matrix?.[id];
    return {
      component: id,
      level: entry?.level ?? "unsupported",
      ...(entry?.rationale === undefined ? {} : { rationale: entry.rationale }),
      ...(entry?.deviations === undefined
        ? {}
        : { deviations: entry.deviations.map((deviation) => ({ ...deviation, id: `${adapter.id}:${deviation.id}` })) }),
      ...(entry?.degradations === undefined
        ? {}
        : {
            degradations: entry.degradations.map((degradation) => ({
              ...degradation,
              id: `${adapter.id}:${degradation.id}`,
            })),
          }),
    };
  });

  if (options.json) {
    options.io.stdout(
      JSON.stringify(
        {
          schemaVersion: 2,
          command: "inspect",
          target: adapter.id,
          delivery: options.delivery ?? "package",
          adapterVersion: adapter.adapterVersion,
          harness: adapter.harness,
          version,
          profiles: resolved.profilesUsed.map((p) => ({
            range: p.range,
            source: p.source,
          })),
          capabilities: rows,
          fields: fieldRows,
          components: componentRows,
          projectionProfiles: projection?.profilesUsed ?? [],
        },
        null,
        2,
      ),
    );
    return 0;
  }

  options.io.stdout(`${adapter.id} (adapter ${adapter.adapterVersion}) — harness range ${version}`);
  for (const profile of resolved.profilesUsed) {
    options.io.stdout(`profile ${profile.range}${profile.source ? ` (validated ${profile.source.date})` : ""}`);
  }
  options.io.stdout("");
  for (const row of rows) {
    options.io.stdout(
      `${row.level.padEnd(12)} ${row.capability}${row.rationale ? `\n             ${row.rationale}` : ""}`,
    );
  }
  // Fields the decoder never sets are the majority, so a full listing names only
  // what is produced; asking for one field answers for it either way.
  const shownFields = options.field !== undefined ? fieldRows : fieldRows.filter((row) => row.level !== "unsupported");
  if (fieldIds.length > 0) {
    options.io.stdout("");
    for (const row of shownFields) {
      options.io.stdout(
        `${row.level.padEnd(12)} ${row.field}${row.rationale ? `\n             ${row.rationale}` : ""}`,
      );
    }
    if (options.field === undefined) options.io.stdout("Other optional event fields are never produced (ADR-0027).");
  }
  if (componentRows.length > 0) {
    options.io.stdout("");
    for (const row of componentRows) {
      options.io.stdout(
        `${row.level.padEnd(12)} ${row.component}${row.rationale ? `\n             ${row.rationale}` : ""}`,
      );
      for (const deviation of row.deviations ?? []) {
        options.io.stdout(`             deviation ${deviation.id}: ${deviation.summary} (${deviation.evidence})`);
      }
      for (const degradation of row.degradations ?? []) {
        options.io.stdout(
          `             degradation ${degradation.id}: ${degradation.summary} (${degradation.evidence})`,
        );
      }
    }
  }
  return 0;
}
