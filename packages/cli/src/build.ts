import { resolve } from "node:path";
import type { AdapterRegistry, EvaluateOptions } from "@hooknostic/core";
import { buildProject, formatDiagnostics } from "@hooknostic/core";
import type { CommandIO } from "./check.js";

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
    return result.ok ? 0 : 1;
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
    for (const artifact of target.artifacts ?? []) {
      options.io.stdout(`         ${artifact}`);
    }
  }
  if (result.report.agentPlugin && result.report.agentPlugin.extensions.length > 0) {
    options.io.stdout(
      `\nAgent Plugins extensions: ${result.report.agentPlugin.extensions.join(", ")} → ${result.report.agentPlugin.root}`,
    );
  }
  options.io.stdout(
    result.ok
      ? `\nbuild succeeded${result.reportPath ? `; report written to ${result.reportPath}` : ""}`
      : "\nbuild failed: no artifacts were committed.",
  );
  return result.ok ? 0 : 1;
}
