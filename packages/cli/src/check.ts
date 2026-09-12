import { resolve } from "node:path";

import type {
  AdapterRegistry,
  AgentPluginTargetReport,
  AnalysisResult,
  Diagnostic,
  EvaluateOptions,
} from "@hooknostic/core";
import { buildProject, formatDiagnostics, hasFatal } from "@hooknostic/core";

import { describeProjection } from "./build.js";

export interface CommandIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CheckOptions {
  /** Path to hooknostic.config.ts; defaults to ./hooknostic.config.ts. */
  config?: string;
  /** Narrow the configured target set; never introduces new targets. */
  targets?: string[];
  json?: boolean;
  registry: AdapterRegistry;
  io: CommandIO;
  /** Module resolution overrides for fixture/self-hosted evaluation. */
  evaluate?: EvaluateOptions;
}

interface CheckReport {
  schemaVersion: 1;
  command: "check";
  ok: boolean;
  targets: Record<
    string,
    Pick<AnalysisResult["targets"][string], "ok" | "adapter" | "requestedVersion" | "counts" | "resolutions"> & {
      /** Paths `build` would generate for this target (nothing is written by `check`). */
      artifacts?: string[];
      projection?: AgentPluginTargetReport;
    }
  >;
  diagnostics: Diagnostic[];
}

function emitFailure(options: CheckOptions, diagnostics: Diagnostic[]): number {
  if (options.json) {
    const report: CheckReport = {
      schemaVersion: 1,
      command: "check",
      ok: false,
      targets: {},
      diagnostics,
    };
    options.io.stdout(JSON.stringify(report, null, 2));
  } else {
    options.io.stderr(formatDiagnostics(diagnostics));
  }
  return 2;
}

/**
 * `hooknostic check` — the full build pipeline (analysis, bundling, Agent
 * Plugin projection, artifact validation) without writing anything. Whatever
 * `build` would reject before touching the filesystem, `check` rejects; only
 * a write the filesystem itself refuses is left for `build` to report.
 */
export async function runCheck(options: CheckOptions): Promise<number> {
  const configPath = resolve(options.config ?? "hooknostic.config.ts");
  const result = await buildProject({
    configPath,
    registry: options.registry,
    ...(options.targets === undefined ? {} : { targets: options.targets }),
    ...(options.evaluate === undefined ? {} : { evaluate: options.evaluate }),
    dryRun: true,
  });
  const analysis = result.analysis;
  if (analysis === undefined) return emitFailure(options, result.report.diagnostics);

  if (options.json) {
    const report: CheckReport = {
      schemaVersion: 1,
      command: "check",
      ok: result.ok,
      targets: Object.fromEntries(
        Object.entries(analysis.targets).map(([id, t]) => {
          const built = result.report.targets[id];
          return [
            id,
            {
              ok: built?.status === "success",
              adapter: t.adapter,
              requestedVersion: t.requestedVersion,
              counts: t.counts,
              resolutions: t.resolutions,
              ...(built?.artifacts === undefined ? {} : { artifacts: built.artifacts }),
              ...(built?.projection === undefined ? {} : { projection: built.projection }),
            },
          ];
        }),
      ),
      diagnostics: result.report.diagnostics,
    };
    options.io.stdout(JSON.stringify(report, null, 2));
    return result.ok ? 0 : 2;
  }

  if (result.report.diagnostics.length > 0) {
    options.io.stdout(formatDiagnostics(result.report.diagnostics));
    options.io.stdout("");
  }
  for (const [id, target] of Object.entries(analysis.targets)) {
    const ok = result.report.targets[id]?.status === "success";
    const summary = `${target.counts.exact} exact, ${target.counts.emulated} emulated, ${target.counts.approximate} approximate, ${target.counts.unsupported} unsupported`;
    options.io.stdout(
      `${ok ? "PASS" : "FAIL"}  ${id}  (${target.adapter}, harness ${target.requestedVersion}) — ${summary}`,
    );
    const projection = result.report.targets[id]?.projection;
    if (projection !== undefined) options.io.stdout(`      ${describeProjection(projection)}`);
  }
  const failed = hasFatal(result.report.diagnostics);
  options.io.stdout(
    failed
      ? "\ncheck failed: fix the errors above or adjust the target set."
      : "\ncheck passed: every selected target generates cleanly; nothing was written.",
  );
  return failed ? 2 : 0;
}
