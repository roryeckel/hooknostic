import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { SupportLevel } from "@hooknostic/sdk";
import type {
  AdapterRegistry,
  CapabilityMatrix,
  GeneratedArtifact,
  TargetSpec,
} from "./adapter.js";
import { targetSpecFromConfig } from "./adapter.js";
import { AGENT_PLUGIN_NAMESPACES, readAgentPluginMetadata } from "./agent-plugin.js";
import type { AnalysisResult } from "./analysis.js";
import { analyzeCapabilities } from "./analysis.js";
import { validateGeneratedArtifacts } from "./artifacts.js";
import type { EvaluateOptions } from "./load.js";
import { loadConfig, loadPluginSource } from "./load.js";
import { bundleRuntime } from "./bundle.js";
import type { Diagnostic } from "./diagnostics.js";
import { hasFatal } from "./diagnostics.js";
import { buildPluginIR } from "./ir.js";
import { effectiveRuntime } from "./policy.js";
import { effectiveCompatibility } from "./policy.js";
import { isStrictDescendant, validateOutputLayout } from "./output-layout.js";
import { commitStagedOutputs } from "./commit.js";

export const HOOKNOSTIC_VERSION = "0.1.0";

export interface BuildOptions {
  /** Path to hooknostic.config.ts. */
  configPath: string;
  registry: AdapterRegistry;
  /** Narrow the configured target set; never introduces targets. */
  targets?: string[];
  /** Module resolution overrides for bundling/evaluation (tests, self-hosting). */
  evaluate?: EvaluateOptions;
  /** Skip artifact emission (used by `check`-with-report flows). */
  dryRun?: boolean;
}

export interface BuildTargetReport {
  status: "success" | "failed" | "skipped";
  adapter: string;
  requestedVersion: string;
  output: string;
  capabilities: Record<SupportLevel, number>;
  artifacts?: string[];
}

export interface BuildReport {
  schemaVersion: 1;
  hooknosticVersion: string;
  source: string;
  targets: Record<string, BuildTargetReport>;
  agentPlugin?: { root: string; extensions: string[] };
  diagnostics: Diagnostic[];
}

export interface BuildResult {
  ok: boolean;
  report: BuildReport;
  analysis?: AnalysisResult;
  reportPath?: string;
}

function levelsFromMatrix(
  matrix: CapabilityMatrix,
): Partial<Record<string, SupportLevel>> {
  return Object.fromEntries(
    Object.entries(matrix).map(([id, entry]) => [id, entry.level]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The project's own `@hooknostic/sdk` entry. Aliasing every SDK import to it
 * keeps a built artifact at exactly one SDK (and zod) copy even when the
 * adapter shim ships inside the CLI rather than in the project's dependency
 * tree. Projects without the SDK installed get no alias (their entry cannot
 * load anyway, which is reported as a diagnostic).
 */
function resolveProjectSdk(configDir: string): string | undefined {
  try {
    return createRequire(join(configDir, "package.json")).resolve("@hooknostic/sdk");
  } catch {
    return undefined;
  }
}

async function writeArtifacts(
  stagingRoot: string,
  key: string,
  artifacts: GeneratedArtifact[],
): Promise<string> {
  const dir = join(stagingRoot, key);
  for (const artifact of artifacts) {
    const file = join(dir, artifact.path);
    // Paths were validated structurally before staging; this guard makes
    // escaping impossible regardless of what an adapter returned.
    if (!isStrictDescendant(dir, file)) {
      throw new Error(
        `artifact path ${JSON.stringify(artifact.path)} resolves outside its output directory`,
      );
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, artifact.contents, {
      encoding: "utf8",
      mode: artifact.executable ? 0o755 : 0o644,
    });
  }
  return dir;
}

/**
 * The full compiler pipeline (design §8.3): load → IR → capability analysis
 * → bundle portable runtime per target → adapter compile → validate → stage
 * → atomically commit outputs → write hooknostic-build.json.
 *
 * The capability pass strictly precedes emission; nothing is committed to a
 * final output directory until every selected target passes. Every failure
 * after analysis is reported as an HN301/HN302 diagnostic in the build report
 * — `buildProject` never rejects for adapter, staging, or commit problems.
 */
export async function buildProject(options: BuildOptions): Promise<BuildResult> {
  const configPath = resolve(options.configPath);
  const configDir = dirname(configPath);
  const diagnostics: Diagnostic[] = [];
  const report: BuildReport = {
    schemaVersion: 1,
    hooknosticVersion: HOOKNOSTIC_VERSION,
    source: "",
    targets: {},
    diagnostics,
  };
  const fail = (): BuildResult => ({ ok: false, report });

  // 1. Load config and source.
  const configResult = await loadConfig(configPath, options.evaluate);
  diagnostics.push(...configResult.diagnostics);
  if (!configResult.config) return fail();
  const config = configResult.config;
  report.source = config.entry;

  const entryPath = resolve(configDir, config.entry);
  const sourceResult = await loadPluginSource(entryPath, options.evaluate);
  diagnostics.push(...sourceResult.diagnostics);
  if (!sourceResult.plugin) return fail();

  const irResult = buildPluginIR(sourceResult.plugin);
  diagnostics.push(...irResult.diagnostics.filter((d) => !diagnostics.includes(d)));
  if (!irResult.ir) return fail();
  const ir = irResult.ir;

  // 2. Agent Plugins metadata reuse (ADR-0004): manifest fills gaps only.
  let agentPluginRoot: string | undefined;
  if (config.agentPlugin) {
    agentPluginRoot = resolve(configDir, config.agentPlugin.root);
    const manifest = await readAgentPluginMetadata(agentPluginRoot);
    diagnostics.push(...manifest.diagnostics);
    if (hasFatal(manifest.diagnostics)) return fail();
    if (manifest.metadata) {
      if (ir.version === undefined && manifest.metadata.version !== undefined) {
        ir.version = manifest.metadata.version;
      }
      if (ir.description === undefined && manifest.metadata.description !== undefined) {
        ir.description = manifest.metadata.description;
      }
    }
    report.agentPlugin = { root: agentPluginRoot, extensions: [] };
  }

  // 3. Capability analysis over the selected target set.
  const analysis = analyzeCapabilities(ir, config, options.registry, options.targets);
  diagnostics.push(...analysis.diagnostics);
  for (const [id, target] of Object.entries(analysis.targets)) {
    report.targets[id] = {
      status: target.ok ? "success" : "failed",
      adapter: target.adapter,
      requestedVersion: target.requestedVersion,
      output: config.targets[id]?.output ?? "",
      capabilities: target.counts,
    };
  }
  const layout = await validateOutputLayout({
    configPath,
    entryPath,
    config,
    selectedTargets: Object.keys(analysis.targets),
  });
  diagnostics.push(...layout.diagnostics);
  for (const diagnostic of layout.diagnostics) {
    if (diagnostic.target && report.targets[diagnostic.target]) {
      report.targets[diagnostic.target]!.status = "failed";
    }
  }
  if (!analysis.ok || hasFatal(layout.diagnostics)) {
    return { ok: false, report, analysis };
  }

  if (options.dryRun) {
    return { ok: true, report, analysis };
  }

  // 4. Bundle + compile per target into a staging directory.
  const runtimePolicy = effectiveRuntime(config);
  const projectSdk = resolveProjectSdk(configDir);
  const outputByKey = new Map(layout.outputs.map((entry) => [entry.key, entry]));
  const staged: {
    key: string;
    target?: string;
    kind?: "directory" | "file";
    stagingDir: string;
    outputDir: string;
  }[] = [];
  /** Nothing was committed: targets that built are "skipped", never "success". */
  const failUncommitted = (): BuildResult => {
    for (const target of Object.values(report.targets)) {
      if (target.status === "success") target.status = "skipped";
    }
    return { ok: false, report, analysis };
  };

  let stagingRoot: string;
  try {
    stagingRoot = await mkdtemp(join(configDir, ".hooknostic-staging-"));
  } catch (error) {
    diagnostics.push({
      code: "HN301",
      severity: "error",
      message: `could not create the staging directory: ${errorMessage(error)}`,
      remediation:
        "check permissions and free space in the directory containing hooknostic.config.ts.",
    });
    return failUncommitted();
  }

  try {
    for (const id of Object.keys(analysis.targets)) {
      const adapter = options.registry[id]!;
      const targetConfig = config.targets[id]!;
      const spec: TargetSpec = targetSpecFromConfig(id, targetConfig);
      const resolved = adapter.capabilities(spec);
      const matrix = resolved.matrix ?? {};
      const compatibility = effectiveCompatibility(config, id);
      const target = report.targets[id]!;

      if (!adapter.shimEntry) {
        diagnostics.push({
          code: "HN301",
          severity: "error",
          target: id,
          message: `adapter "${adapter.id}" does not provide a shim entry; cannot emit artifacts.`,
        });
        target.status = "failed";
        continue;
      }

      // Bundling, generation, validation and staging are adapter-driven; any
      // failure is this target's HN301 — never a crash — and nothing reaches
      // the final output directories.
      let phase = "bundling";
      try {
        const alias = {
          ...adapter.shimAliases?.(),
          ...(projectSdk !== undefined ? { "@hooknostic/sdk": projectSdk } : {}),
          ...options.evaluate?.alias,
        };
        const bundle = await bundleRuntime({
          source: adapter.shimEntry({
            entryImportPath: entryPath.replaceAll("\\", "/"),
            capabilities: levelsFromMatrix(matrix),
            minimumCapabilityLevel: compatibility.minimum,
            policy: runtimePolicy,
          }),
          resolveDir: configDir,
          ...(Object.keys(alias).length > 0 ? { alias } : {}),
        });

        phase = "generation";
        const artifacts = await adapter.compile(ir, spec, bundle, { runtime: runtimePolicy });

        phase = "validation";
        const structural = validateGeneratedArtifacts(artifacts, {
          adapterId: adapter.id,
          target: id,
        });
        diagnostics.push(...structural);
        if (hasFatal(structural)) {
          target.status = "failed";
          continue;
        }
        const validation = (await adapter.validateArtifacts?.(artifacts, spec)) ?? [];
        diagnostics.push(...validation);
        if (hasFatal(validation)) {
          target.status = "failed";
          continue;
        }

        phase = "staging";
        const stagingDir = await writeArtifacts(stagingRoot, id, artifacts);
        staged.push({
          key: id,
          target: id,
          stagingDir,
          outputDir: outputByKey.get(id)!.outputDir,
        });
        target.artifacts = artifacts.map((a) => a.path);

        // Agent Plugins client-extension emission (Claude only in v0.1: Codex
        // 0.148 loads no plugin hooks; OpenCode has no namespace convention).
        const namespace = (AGENT_PLUGIN_NAMESPACES as Record<string, string>)[id];
        if (agentPluginRoot !== undefined && namespace !== undefined) {
          const extensionArtifacts = artifacts.filter(
            (a) => !a.path.startsWith(".claude-plugin/"),
          );
          const extensionKey = `agent-plugin/${namespace}`;
          const extensionStaging = await writeArtifacts(
            stagingRoot,
            extensionKey,
            extensionArtifacts,
          );
          staged.push({
            key: extensionKey,
            target: id,
            stagingDir: extensionStaging,
            outputDir: outputByKey.get(extensionKey)!.outputDir,
          });
          report.agentPlugin!.extensions.push(namespace);
        }
      } catch (error) {
        diagnostics.push({
          code: "HN301",
          severity: "error",
          target: id,
          message: `artifact ${phase} failed: ${errorMessage(error)}`,
        });
        target.status = "failed";
        continue;
      }
    }

    if (hasFatal(diagnostics)) {
      return failUncommitted();
    }

    // The build report is a mandatory managed output. Install it last so a
    // report failure rolls every previously installed target back.
    const reportPath = join(configDir, "hooknostic-build.json");
    const stagedReportPath = join(stagingRoot, "hooknostic-build.json");
    try {
      await writeFile(stagedReportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    } catch (error) {
      diagnostics.push({
        code: "HN301",
        severity: "error",
        message: `could not stage the build report: ${errorMessage(error)}`,
      });
      return failUncommitted();
    }
    staged.push({
      key: "build-report",
      kind: "file",
      stagingDir: stagedReportPath,
      outputDir: reportPath,
    });

    // 5. Transactional commit: prepare same-filesystem replacements first,
    // then retain backups until every selected output has been installed.
    const commit = await commitStagedOutputs(staged);
    if (!commit.ok) {
      const failure = commit.failure!;
      diagnostics.push({
        code: "HN302",
        severity: "error",
        ...(failure.failedTarget !== undefined ? { target: failure.failedTarget } : {}),
        message: failure.message,
        ...(failure.recoveryPaths.length > 0
          ? {
              remediation: `recover prior outputs from: ${failure.recoveryPaths.join(", ")}.`,
            }
          : {}),
      });
      for (const [id, target] of Object.entries(report.targets)) {
        target.status = id === failure.failedTarget ? "failed" : "skipped";
      }
      return { ok: false, report, analysis };
    }
  } catch (error) {
    // Anything not already converted above is still a reported build failure,
    // never an uncaught exception.
    diagnostics.push({
      code: "HN301",
      severity: "error",
      message: `build failed unexpectedly: ${errorMessage(error)}`,
    });
    return failUncommitted();
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  // 6. Every managed output, including the report, is now installed.
  const reportPath = join(configDir, "hooknostic-build.json");
  return { ok: true, report, analysis, reportPath };
}
