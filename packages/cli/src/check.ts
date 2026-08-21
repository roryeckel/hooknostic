import { dirname, resolve } from "node:path";
import type { AdapterRegistry, AnalysisResult, Diagnostic, EvaluateOptions } from "@hooknostic/core";
import {
  analyzeCapabilities,
  buildPluginIR,
  formatDiagnostics,
  hasFatal,
  loadConfig,
  loadPluginSource,
  validateOutputLayout,
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

  const configResult = await loadConfig(configPath, options.evaluate);
  if (!configResult.config) return emitFailure(options, configResult.diagnostics);
  const config = configResult.config;

  const entryPath = resolve(dirname(configPath), config.entry);
  const sourceResult = await loadPluginSource(entryPath, options.evaluate);
  if (!sourceResult.plugin) return emitFailure(options, sourceResult.diagnostics);

  const irResult = buildPluginIR(sourceResult.plugin);
  if (!irResult.ir) return emitFailure(options, irResult.diagnostics);

  const analysis = analyzeCapabilities(
    irResult.ir,
    config,
    options.registry,
    options.targets,
  );
  const layout = await validateOutputLayout({
    configPath,
    entryPath,
    config,
    selectedTargets: Object.keys(analysis.targets),
  });
  analysis.diagnostics.push(...layout.diagnostics);
  for (const diagnostic of layout.diagnostics) {
    if (diagnostic.target && analysis.targets[diagnostic.target]) {
      const target = analysis.targets[diagnostic.target]!;
      target.diagnostics.push(diagnostic);
      target.ok = false;
    }
  }
  analysis.ok = !hasFatal(analysis.diagnostics);

  if (options.json) {
    const report: CheckReport = {
      schemaVersion: 1,
      command: "check",
      ok: analysis.ok,
      targets: Object.fromEntries(
        Object.entries(analysis.targets).map(([id, t]) => [
          id,
          {
            ok: t.ok,
            adapter: t.adapter,
            requestedVersion: t.requestedVersion,
            counts: t.counts,
            resolutions: t.resolutions,
          },
        ]),
      ),
      diagnostics: analysis.diagnostics,
    };
    options.io.stdout(JSON.stringify(report, null, 2));
    return analysis.ok ? 0 : 1;
  }

  if (analysis.diagnostics.length > 0) {
    options.io.stdout(formatDiagnostics(analysis.diagnostics));
    options.io.stdout("");
  }
  for (const [id, target] of Object.entries(analysis.targets)) {
    const summary = `${target.counts.exact} exact, ${target.counts.emulated} emulated, ${target.counts.approximate} approximate, ${target.counts.unsupported} unsupported`;
    options.io.stdout(
      `${target.ok ? "PASS" : "FAIL"}  ${id}  (${target.adapter}, harness ${target.requestedVersion}) — ${summary}`,
    );
  }
  const failed = hasFatal(analysis.diagnostics);
  options.io.stdout(
    failed
      ? "\ncheck failed: fix the errors above or adjust the target set."
      : "\ncheck passed: all selected targets satisfy the declared hook semantics.",
  );
  return failed ? 1 : 0;
}
