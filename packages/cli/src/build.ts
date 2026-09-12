import { resolve } from "node:path";

import type { AdapterRegistry, AgentPluginTargetReport, EvaluateOptions } from "@hooknostic/core";
import { buildProject, formatDiagnostics } from "@hooknostic/core";

import type { CommandIO } from "./check.js";

/** One-line Agent Plugin projection summary for human output. */
export function describeProjection(projection: AgentPluginTargetReport): string {
  const components = Object.values(projection.components);
  const emitted = components.reduce((sum, component) => sum + (component?.emitted ?? 0), 0);
  const omitted = projection.omissions.length;
  const files = projection.copiedFileCount === undefined ? "" : `, ${projection.copiedFileCount} package files copied`;
  return `Agent Plugin projection ${projection.status}: ${emitted} components emitted, ${omitted} omitted${files}`;
}

export interface BuildCommandOptions {
  config?: string;
  targets?: string[];
  json?: boolean;
  registry: AdapterRegistry;
  io: CommandIO;
  evaluate?: EvaluateOptions;
}

/** `hooknostic build` — check compatibility, bundle, emit target artifacts. */
export async function runBuild(options: BuildCommandOptions): Promise<number> {
  const result = await buildProject({
    configPath: resolve(options.config ?? "hooknostic.config.ts"),
    registry: options.registry,
    ...(options.targets ? { targets: options.targets } : {}),
    ...(options.evaluate ? { evaluate: options.evaluate } : {}),
  });

  if (options.json) {
    options.io.stdout(JSON.stringify(result.report, null, 2));
    return result.ok ? 0 : 2;
  }

  if (result.report.diagnostics.length > 0) {
    options.io.stdout(formatDiagnostics(result.report.diagnostics));
    options.io.stdout("");
  }
  for (const [id, target] of Object.entries(result.report.targets)) {
    const counts = target.capabilities;
    options.io.stdout(
      `${target.status === "success" ? "BUILT" : "FAIL "}  ${id} → ${target.output}  (${target.adapter}, harness ${target.requestedVersion}) — ${counts.exact} exact, ${counts.emulated} emulated, ${counts.approximate} approximate, ${counts.unsupported} unsupported`,
    );
    if (target.projection !== undefined) options.io.stdout(`         ${describeProjection(target.projection)}`);
    for (const artifact of target.artifacts ?? []) {
      options.io.stdout(`         ${artifact}`);
    }
  }
  if (result.report.components) {
    options.io.stdout(
      `\nAgent Plugin ${result.report.components.root} → ${result.report.components.targets.join(", ")}`,
    );
  }
  options.io.stdout(
    result.ok
      ? `\nbuild succeeded${result.reportPath ? `; report written to ${result.reportPath}` : ""}`
      : "\nbuild failed: no artifacts were committed.",
  );
  return result.ok ? 0 : 2;
}
