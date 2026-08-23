import type { AdapterRegistry } from "@hooknostic/core";
import type { CapabilityId } from "@hooknostic/sdk";
import { ALL_CAPABILITY_IDS, isCapabilityId } from "@hooknostic/sdk";
import type { CommandIO } from "./check.js";

export interface InspectCommandOptions {
  target: string;
  capability?: string;
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

  const version = options.version ?? adapter.supportedHarnessVersions()[0] ?? "*";
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
    options.capability !== undefined ? [options.capability] : [...ALL_CAPABILITY_IDS];

  const rows = ids.map((id) => {
    const entry = resolved.matrix![id];
    return {
      capability: id,
      level: entry?.level ?? "unsupported",
      ...(entry?.rationale !== undefined ? { rationale: entry.rationale } : {}),
    };
  });

  if (options.json) {
    options.io.stdout(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: "inspect",
          target: adapter.id,
          adapterVersion: adapter.adapterVersion,
          version,
          profiles: resolved.profilesUsed.map((p) => ({
            range: p.range,
            ...(p.source !== undefined ? { source: p.source } : {}),
          })),
          capabilities: rows,
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
  return 0;
}
