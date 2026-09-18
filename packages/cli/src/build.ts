import { resolve } from "node:path";

import type { AdapterRegistry, AgentPluginTargetReport, BuildReport, EvaluateOptions } from "@hooknostic/core";
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

/**
 * How each stdio server's declared command is resolved.
 *
 * Hooknostic can report whether the declared command comes from a package,
 * direct project source, or PATH. It does not inspect the command for
 * interpreters, libraries, daemons, or other transitive dependencies.
 * `doctor` probes only PATH-looked-up commands and keeps that result advisory.
 *
 * Every projected stdio server additionally needs Node, because the generated
 * launcher is a Node program. That is a property of the projection rather than
 * the package, so the adapters report it and this does not repeat it.
 */
export function describeMcpCommands(mcpServers: BuildReport["mcpServers"]): string[] {
  return (mcpServers ?? []).map((server) =>
    server.resolution === "package"
      ? `  ${server.server}: command ${server.command} is shipped by the package`
      : server.resolution === "project"
        ? `  ${server.server}: command ${server.command} is resolved relative to the project MCP source`
        : `  ${server.server}: command ${server.command} is looked up on the consumer's PATH`,
  );
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
  const commands = describeMcpCommands(result.report.mcpServers);
  if (commands.length > 0 && result.report.components === undefined) options.io.stdout("\nMCP commands");
  for (const line of commands) options.io.stdout(line);
  options.io.stdout(
    result.ok
      ? `\nbuild succeeded${result.reportPath ? `; report written to ${result.reportPath}` : ""}`
      : "\nbuild failed: no artifacts were committed.",
  );
  return result.ok ? 0 : 2;
}
