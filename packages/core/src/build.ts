import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  loadAgentPlugin,
  type AgentPluginComponentId,
  type AgentPluginPackage,
  type AgentPluginProjectionSummary,
} from "@hooknostic/agent-plugin";
import type { SupportLevel } from "@hooknostic/sdk";
import type { AdapterRegistry, CapabilityMatrix, GeneratedArtifact, TargetSpec } from "./adapter.js";
import { targetSpecFromConfig } from "./adapter.js";
import {
  analyzeAgentPluginProjection,
  diagnosticsFromAgentPluginIssues,
  type AgentPluginProjectionResolution,
} from "./agent-plugin.js";
import type { AnalysisResult } from "./analysis.js";
import { analyzeCapabilities } from "./analysis.js";
import { validateGeneratedArtifacts } from "./artifacts.js";
import { bundleHasMainModuleGuard, bundleRuntime } from "./bundle.js";
import { commitStagedOutputs } from "./commit.js";
import type { Diagnostic } from "./diagnostics.js";
import { hasFatal } from "./diagnostics.js";
import type { PluginIR } from "./ir.js";
import { buildPluginIR } from "./ir.js";
import type { EvaluateOptions } from "./load.js";
import { loadConfig, loadPluginSource } from "./load.js";
import { isStrictDescendant, validateOutputLayout } from "./output-layout.js";
import { effectiveCompatibility, effectiveRuntime } from "./policy.js";

export const HOOKNOSTIC_VERSION = "0.1.0";

export interface BuildOptions {
  configPath: string;
  registry: AdapterRegistry;
  targets?: string[];
  evaluate?: EvaluateOptions;
  dryRun?: boolean;
}

export interface AgentPluginTargetReport {
  status: "success" | "failed" | "skipped";
  contentDigest?: string;
  copiedFileCount?: number;
  components: Partial<
    Record<
      AgentPluginComponentId,
      { support: SupportLevel; discovered: number; emitted: number; skipped: number }
    >
  >;
  omissions: AgentPluginProjectionSummary["omissions"];
}

export interface BuildTargetReport {
  status: "success" | "failed" | "skipped";
  adapter: string;
  requestedVersion: string;
  output: string;
  capabilities: Record<SupportLevel, number>;
  artifacts?: string[];
  projection?: AgentPluginTargetReport;
}

export interface BuildReport {
  schemaVersion: 2;
  hooknosticVersion: string;
  source?: string;
  targets: Record<string, BuildTargetReport>;
  agentPlugin?: {
    root: string;
    specVersion: "1.0.0";
    targets: string[];
    sourceFileCount: number;
    contentDigest: string;
  };
  diagnostics: Diagnostic[];
}

export interface BuildResult {
  ok: boolean;
  report: BuildReport;
  analysis?: AnalysisResult;
  reportPath?: string;
}

function levelsFromMatrix(matrix: CapabilityMatrix): Partial<Record<string, SupportLevel>> {
  return Object.fromEntries(Object.entries(matrix).map(([id, entry]) => [id, entry.level]));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveProjectSdk(configDir: string): string | undefined {
  try {
    return createRequire(join(configDir, "package.json")).resolve("@hooknostic/sdk");
  } catch {
    return undefined;
  }
}

function projectionExcludes(
  root: string,
  configDir: string,
  outputs: readonly string[],
  configured: readonly string[],
): string[] {
  const exclusions = new Set<string>([
    ".hooknostic-*",
    ".hooknostic-*/**",
    "**/.hooknostic-*",
    "**/.hooknostic-*/**",
  ]);
  const configRelative = relative(root, configDir).replaceAll("\\", "/");
  if (
    configRelative !== "" &&
    !isAbsolute(configRelative) &&
    configRelative !== ".." &&
    !configRelative.startsWith("../")
  ) {
    exclusions.add(`${configRelative}/.hooknostic-*`);
    exclusions.add(`${configRelative}/.hooknostic-*/**`);
  }
  for (const path of [join(configDir, "hooknostic-build.json"), ...outputs.map((p) => resolve(configDir, p))]) {
    const rel = relative(root, path);
    if (rel === "") continue;
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../")) {
      const portable = rel.replaceAll("\\", "/");
      exclusions.add(portable);
      exclusions.add(`${portable}/**`);
    }
  }
  for (const pattern of configured) exclusions.add(pattern);
  return [...exclusions];
}

function artifactDigest(artifacts: readonly GeneratedArtifact[]): string {
  const hash = createHash("sha256");
  for (const artifact of [...artifacts].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(artifact.path);
    hash.update("\0");
    hash.update(String(artifact.mode ?? (artifact.executable ? 0o755 : 0o644)));
    hash.update("\0");
    hash.update(artifact.contents);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function projectionReport(
  resolution: AgentPluginProjectionResolution,
  summary: AgentPluginProjectionSummary,
  artifacts: readonly GeneratedArtifact[],
): AgentPluginTargetReport {
  const components: AgentPluginTargetReport["components"] = {};
  for (const [id, counts] of Object.entries(summary.components)) {
    const component = id as AgentPluginComponentId;
    if (counts !== undefined) {
      components[component] = {
        support: resolution.matrix?.[component]?.level ?? "unsupported",
        ...counts,
      };
    }
  }
  return {
    status: "success",
    contentDigest: artifactDigest(artifacts),
    copiedFileCount: summary.copiedFileCount,
    components,
    omissions: summary.omissions,
  };
}

function analyzedProjectionReport(
  source: AgentPluginPackage,
  resolution: AgentPluginProjectionResolution,
  namespace: string | undefined,
  hasRuntimePackage: boolean,
): AgentPluginTargetReport {
  const discovered = new Map<AgentPluginComponentId, number>([["agent-plugin.manifest", 1]]);
  if (source.skills.length > 0) discovered.set("agent-plugin.skills", source.skills.length);
  for (const type of ["stdio", "streamable-http", "sse"] as const) {
    const count = Object.values(source.mcp?.mcpServers ?? {}).filter((server) => server.type === type).length;
    if (count > 0) discovered.set(`agent-plugin.mcp.${type}`, count);
  }
  if (namespace !== undefined) {
    const files = source.files.filter((file) => file.path.startsWith(`${namespace}/`)).length;
    if (files > 0) discovered.set("agent-plugin.client-extension.files", files);
  }
  if (hasRuntimePackage) discovered.set("agent-plugin.runtime-package", 1);
  const unsupported = new Set(
    resolution.diagnostics.flatMap((diagnostic) =>
      diagnostic.code === "HN205" && diagnostic.component !== undefined
        ? [diagnostic.component]
        : [],
    ),
  );
  return {
    status: hasFatal(resolution.diagnostics) ? "failed" : "success",
    components: Object.fromEntries(
      [...discovered].map(([component, count]) => [
        component,
        {
          support: resolution.matrix?.[component]?.level ?? "unsupported",
          discovered: count,
          emitted: 0,
          skipped: unsupported.has(component) ? count : 0,
        },
      ]),
    ),
    omissions: [...unsupported].map((component) => ({
      component,
      reason: `component is unsupported on the selected target`,
    })),
  };
}

async function writeArtifacts(stagingRoot: string, key: string, artifacts: GeneratedArtifact[]): Promise<string> {
  const dir = join(stagingRoot, key);
  await mkdir(dir, { recursive: true });
  for (const artifact of artifacts) {
    const file = join(dir, artifact.path);
    if (!isStrictDescendant(dir, file)) {
      throw new Error(`artifact path ${JSON.stringify(artifact.path)} resolves outside its output directory`);
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, artifact.contents, {
      mode: artifact.mode ?? (artifact.executable ? 0o755 : 0o644),
    });
  }
  return dir;
}

export async function buildProject(options: BuildOptions): Promise<BuildResult> {
  const configPath = resolve(options.configPath);
  const configDir = dirname(configPath);
  const diagnostics: Diagnostic[] = [];
  const report: BuildReport = { schemaVersion: 2, hooknosticVersion: HOOKNOSTIC_VERSION, targets: {}, diagnostics };
  const fail = (): BuildResult => ({ ok: false, report });

  const configResult = await loadConfig(configPath, options.evaluate);
  diagnostics.push(...configResult.diagnostics);
  if (!configResult.config) return fail();
  const config = configResult.config;

  let agentPlugin: AgentPluginPackage | undefined;
  if (config.agentPlugin !== undefined) {
    const agentPluginRoot = resolve(configDir, config.agentPlugin.root);
    const loaded = await loadAgentPlugin({
      root: agentPluginRoot,
      exclude: projectionExcludes(
        agentPluginRoot,
        configDir,
        Object.values(config.targets).map((target) => target.output),
        config.agentPlugin.exclude ?? [],
      ),
    });
    diagnostics.push(...diagnosticsFromAgentPluginIssues(loaded.issues));
    if (!loaded.package || hasFatal(diagnostics)) return fail();
    agentPlugin = loaded.package;
    report.agentPlugin = {
      root: relative(configDir, agentPluginRoot).replaceAll("\\", "/") || ".",
      specVersion: agentPlugin.specVersion,
      targets: config.agentPlugin.targets,
      sourceFileCount: agentPlugin.files.length,
      contentDigest: agentPlugin.contentDigest,
    };
  }

  let entryPath: string | undefined;
  let ir: PluginIR;
  if (config.entry !== undefined) {
    report.source = config.entry;
    entryPath = resolve(configDir, config.entry);
    const sourceResult = await loadPluginSource(entryPath, options.evaluate);
    diagnostics.push(...sourceResult.diagnostics);
    if (!sourceResult.plugin) return fail();
    const irResult = buildPluginIR(sourceResult.plugin);
    diagnostics.push(...irResult.diagnostics.filter((item) => !diagnostics.includes(item)));
    if (!irResult.ir) return fail();
    ir = irResult.ir;
    if (agentPlugin !== undefined) {
      if (ir.version === undefined && agentPlugin.manifest.version !== undefined) {
        ir.version = agentPlugin.manifest.version;
      }
      if (ir.description === undefined && agentPlugin.manifest.description !== undefined) {
        ir.description = agentPlugin.manifest.description;
      }
    }
  } else {
    if (agentPlugin === undefined) return fail();
    ir = {
      name: agentPlugin.manifest.name,
      ...(agentPlugin.manifest.version === undefined ? {} : { version: agentPlugin.manifest.version }),
      ...(agentPlugin.manifest.description === undefined ? {} : { description: agentPlugin.manifest.description }),
      hooks: [],
    };
  }

  const analysis = analyzeCapabilities(ir, config, options.registry, options.targets);
  diagnostics.push(...analysis.diagnostics);
  const projectionResolutions = new Map<string, AgentPluginProjectionResolution>();
  for (const [id, target] of Object.entries(analysis.targets)) {
    report.targets[id] = {
      status: target.ok ? "success" : "failed",
      adapter: target.adapter,
      requestedVersion: target.requestedVersion,
      output: config.targets[id]?.output ?? "",
      capabilities: target.counts,
    };
    if (agentPlugin !== undefined && config.agentPlugin!.targets.includes(id)) {
      const spec = targetSpecFromConfig(id, config.targets[id]!);
      const resolution = analyzeAgentPluginProjection(
        agentPlugin,
        options.registry[id]!,
        spec,
        config.agentPlugin!.onUnsupported ?? "error",
        config.agentPlugin!.runtimePackage,
      );
      projectionResolutions.set(id, resolution);
      diagnostics.push(...resolution.diagnostics);
      report.targets[id]!.projection = analyzedProjectionReport(
        agentPlugin,
        resolution,
        options.registry[id]!.agentPluginProjector?.namespace,
        config.agentPlugin!.runtimePackage !== undefined,
      );
      if (hasFatal(resolution.diagnostics)) report.targets[id]!.status = "failed";
    }
  }

  const layout = await validateOutputLayout({
    configPath,
    ...(entryPath === undefined ? {} : { entryPath }),
    config,
    selectedTargets: Object.keys(analysis.targets),
  });
  diagnostics.push(...layout.diagnostics);
  for (const diagnostic of layout.diagnostics) {
    if (diagnostic.target && report.targets[diagnostic.target]) report.targets[diagnostic.target]!.status = "failed";
  }
  if (!analysis.ok || hasFatal(diagnostics)) return { ok: false, report, analysis };
  if (options.dryRun) return { ok: true, report, analysis };

  const runtimePolicy = effectiveRuntime(config);
  const projectSdk = config.entry === undefined ? undefined : resolveProjectSdk(configDir);
  const outputByKey = new Map(layout.outputs.map((entry) => [entry.key, entry]));
  const staged: { key: string; target?: string; kind?: "directory" | "file"; stagingDir: string; outputDir: string }[] = [];
  const failUncommitted = (): BuildResult => {
    for (const target of Object.values(report.targets)) {
      if (target.status === "success") target.status = "skipped";
      if (target.projection?.status === "success") target.projection.status = "skipped";
    }
    return { ok: false, report, analysis };
  };

  let stagingRoot: string;
  try {
    stagingRoot = await mkdtemp(join(configDir, ".hooknostic-staging-"));
  } catch (error) {
    diagnostics.push({ code: "HN301", severity: "error", message: `could not create the staging directory: ${errorMessage(error)}`, remediation: "check permissions and free space in the directory containing hooknostic.config.ts." });
    return failUncommitted();
  }

  const mainGuardTargets: string[] = [];
  try {
    for (const id of Object.keys(analysis.targets)) {
      const adapter = options.registry[id]!;
      const targetConfig = config.targets[id]!;
      const spec: TargetSpec = targetSpecFromConfig(id, targetConfig);
      const target = report.targets[id]!;
      const hookArtifacts: GeneratedArtifact[] = [];
      let phase = "generation";
      try {
        if (entryPath !== undefined) {
          if (!adapter.shimEntry) throw new Error(`adapter ${JSON.stringify(adapter.id)} does not provide a shim entry`);
          phase = "bundling";
          const resolved = adapter.capabilities(spec);
          const compatibility = effectiveCompatibility(config, id);
          const alias = {
            ...adapter.shimAliases?.(),
            ...(projectSdk === undefined ? {} : { "@hooknostic/sdk": projectSdk }),
            ...options.evaluate?.alias,
          };
          const bundle = await bundleRuntime({
            source: adapter.shimEntry({
              entryImportPath: entryPath.replaceAll("\\", "/"),
              capabilities: levelsFromMatrix(resolved.matrix ?? {}),
              minimumCapabilityLevel: compatibility.minimum,
              policy: runtimePolicy,
            }),
            resolveDir: configDir,
            ...(Object.keys(alias).length === 0 ? {} : { alias }),
          });
          if (adapter.shimExecution === "command" && bundleHasMainModuleGuard(bundle.code)) mainGuardTargets.push(id);
          phase = "generation";
          hookArtifacts.push(...(await adapter.compile(ir, spec, bundle, { runtime: runtimePolicy })));
        }

        let artifacts = hookArtifacts;
        if (agentPlugin !== undefined && config.agentPlugin!.targets.includes(id)) {
          phase = "Agent Plugin projection";
          const projector = adapter.agentPluginProjector;
          if (projector === undefined) {
            target.projection = {
              ...target.projection!,
              status: "skipped",
            };
          } else {
            const plan = await projector.project(agentPlugin, {
              target: spec,
              hookArtifacts,
              ...(config.agentPlugin!.runtimePackage === undefined
                ? {}
                : { runtimePackage: config.agentPlugin!.runtimePackage }),
              onUnsupported: config.agentPlugin!.onUnsupported ?? "error",
            });
            const projectedDiagnostics = diagnosticsFromAgentPluginIssues(plan.issues, id);
            diagnostics.push(...projectedDiagnostics);
            if (hasFatal(projectedDiagnostics)) {
              target.status = "failed";
              target.projection = { status: "failed", components: {}, omissions: plan.summary.omissions };
              continue;
            }
            artifacts = plan.files;
            target.projection = projectionReport(projectionResolutions.get(id)!, plan.summary, artifacts);
          }
        }

        phase = "validation";
        const structural = validateGeneratedArtifacts(artifacts, { adapterId: adapter.id, target: id });
        diagnostics.push(...structural);
        if (hasFatal(structural)) {
          target.status = "failed";
          if (target.projection) target.projection.status = "failed";
          continue;
        }
        const validation = (await adapter.validateArtifacts?.(artifacts, spec)) ?? [];
        diagnostics.push(...validation);
        if (hasFatal(validation)) {
          target.status = "failed";
          if (target.projection) target.projection.status = "failed";
          continue;
        }

        phase = "staging";
        const stagingDir = await writeArtifacts(stagingRoot, id, artifacts);
        staged.push({ key: id, target: id, stagingDir, outputDir: outputByKey.get(id)!.outputDir });
        const generated = new Set(hookArtifacts.map((artifact) => artifact.path));
        if (target.projection !== undefined) {
          generated.add(".claude-plugin/plugin.json");
          if (artifacts.some((artifact) => artifact.path === ".mcp.json")) {
            generated.add(".mcp.json");
          }
          if (config.agentPlugin!.runtimePackage !== undefined) {
            generated.add("package.json");
            generated.add("package-lock.json");
          }
        }
        target.artifacts = artifacts
          .map((artifact) => artifact.path)
          .filter((path) => generated.has(path));
      } catch (error) {
        diagnostics.push({ code: "HN301", severity: "error", target: id, message: `artifact ${phase} failed: ${errorMessage(error)}` });
        target.status = "failed";
        if (target.projection) target.projection.status = "failed";
      }
    }

    if (mainGuardTargets.length > 0) {
      diagnostics.push({ code: "HN502", severity: "warn", message: `the bundled hook source contains a CLI main-module guard (import.meta.url compared against process.argv[1]); ${mainGuardTargets.join(", ")} run the generated artifact as a command, so both sides of that comparison name the artifact and the guarded code executes on every hook dispatch.`, remediation: "move the command-line entry point into a module the hook source does not import, or gate it on an explicit environment variable instead." });
    }
    if (hasFatal(diagnostics)) return failUncommitted();

    const reportPath = join(configDir, "hooknostic-build.json");
    const stagedReportPath = join(stagingRoot, "hooknostic-build.json");
    try {
      await writeFile(stagedReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (error) {
      diagnostics.push({ code: "HN301", severity: "error", message: `could not stage the build report: ${errorMessage(error)}` });
      return failUncommitted();
    }
    staged.push({ key: "build-report", kind: "file", stagingDir: stagedReportPath, outputDir: reportPath });

    const commit = await commitStagedOutputs(staged);
    if (!commit.ok) {
      const failure = commit.failure!;
      diagnostics.push({
        code: "HN302",
        severity: "error",
        ...(failure.failedTarget === undefined ? {} : { target: failure.failedTarget }),
        message: failure.message,
        ...(failure.recoveryPaths.length === 0 ? {} : { remediation: `recover prior outputs from: ${failure.recoveryPaths.join(", ")}.` }),
      });
      for (const [id, target] of Object.entries(report.targets)) {
        target.status = id === failure.failedTarget ? "failed" : "skipped";
        if (target.projection) target.projection.status = target.status;
      }
      return { ok: false, report, analysis };
    }
  } catch (error) {
    diagnostics.push({ code: "HN301", severity: "error", message: `build failed unexpectedly: ${errorMessage(error)}` });
    return failUncommitted();
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const reportPath = join(configDir, "hooknostic-build.json");
  return { ok: true, report, analysis, reportPath };
}
