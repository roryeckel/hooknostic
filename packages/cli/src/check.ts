import { resolve } from "node:path";
import type { AdapterRegistry, AnalysisResult, Diagnostic, EvaluateOptions } from "@hooknostic/core";
import {
  buildProject,
  formatDiagnostics,
  hasFatal,
} from "@hooknostic/core";

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
    Pick<
      AnalysisResult["targets"][string],
      "ok" | "adapter" | "requestedVersion" | "counts" | "resolutions"
    >
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
  return 1;
}

/** `hooknostic check` — semantic analysis only; no artifacts are produced. */
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
        Object.entries(analysis.targets).map(([id, t]) => [
          id,
          {
            ok: result.report.targets[id]?.status === "success",
            adapter: t.adapter,
            requestedVersion: t.requestedVersion,
            counts: t.counts,
            resolutions: t.resolutions,
          },
        ]),
      ),
      diagnostics: result.report.diagnostics,
    };
    options.io.stdout(JSON.stringify(report, null, 2));
    return result.ok ? 0 : 1;
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
  }
  const failed = hasFatal(result.report.diagnostics);
  options.io.stdout(
    failed
      ? "\ncheck failed: fix the errors above or adjust the target set."
      : "\ncheck passed: all selected targets satisfy the declared hook semantics.",
  );
  return failed ? 1 : 0;
}
