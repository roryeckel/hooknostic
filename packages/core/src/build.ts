import { minimatch } from "minimatch";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { commitStagedOutputs, existingKindProblem } from "./commit.js";
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
  /** Package directories explicitly retained by the projection. */
  directories?: readonly string[];
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
    /** Every inventoried package-relative path, sorted: exactly what projection may ship. */
    sourceFiles: string[];
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

/**
 * The realpath of `path`. A path that does not exist yet (a target output
 * before its first build) is resolved through its deepest existing ancestor,
 * so `alias/dist/claude` and `real/dist/claude` name the same place.
 */
async function canonical(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Hooknostic-project paths that must never ship inside a projected package:
 * transaction directories, the build report, every target output, the config
 * file itself, and the hook source entry (its compiled runtime ships instead).
 * Package-level junk (`node_modules`, `.env`, …) is excluded by the loader.
 *
 * The loader inventories the root's realpath, so every pattern is derived from
 * canonical paths: a root reached through a symlink or junction alias must
 * still exclude the config and entry spelled via the real directory.
 */
async function projectionExcludes(
  lexicalRoot: string,
  lexicalConfigPath: string,
  entry: string | undefined,
  outputs: readonly string[],
  configured: readonly string[],
): Promise<string[]> {
  const root = await canonical(lexicalRoot);
  const configDir = await canonical(dirname(lexicalConfigPath));
  // A project file may itself be a link (`hooknostic.config.ts -> config/real.ts`
  // inside the package): exclude both its name and where it resolves, or the
  // target ships under its own name.
  const spellings = async (path: string): Promise<string[]> => [path, await canonical(path)];
  const configPaths = await spellings(join(configDir, basename(lexicalConfigPath)));
  const entryPaths = entry === undefined ? [] : await spellings(resolve(configDir, entry));
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
    exclusions.add(`${minimatch.escape(configRelative, { magicalBraces: true })}/.hooknostic-*`);
    exclusions.add(`${minimatch.escape(configRelative, { magicalBraces: true })}/.hooknostic-*/**`);
  }
  const projectPaths = [
    ...configPaths,
    ...(await spellings(join(configDir, "hooknostic-build.json"))),
    ...entryPaths,
    // Outputs get both spellings too: canonical, or an output spelled through
    // the root's alias falls outside the canonical root and the next build
    // inventories its own previous output; lexical, or an output spelled
    // through a link inside the package (`link -> dist`) is walked under the
    // link's name and rejected as resolving to an excluded path.
    ...(await Promise.all(outputs.map((p) => spellings(resolve(configDir, p))))).flat(),
  ];
  for (const path of projectPaths) {
    const rel = relative(root, path);
    if (rel === "") continue;
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../")) {
      const portable = minimatch.escape(rel.replaceAll("\\", "/"), { magicalBraces: true });
      exclusions.add(portable);
      exclusions.add(`${portable}/**`);
    }
  }
  for (const pattern of configured) exclusions.add(pattern);
  return [...exclusions];
}

function artifactDigest(artifacts: readonly GeneratedArtifact[], directories: readonly string[]): string {
  const hash = createHash("sha256");
  for (const artifact of [...artifacts].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(artifact.path);
    hash.update("\0");
    hash.update(String(artifact.mode ?? (artifact.executable ? 0o755 : 0o644)));
    hash.update("\0");
    hash.update(artifact.contents);
    hash.update("\0");
  }
  for (const directory of [...directories].sort()) {
    hash.update("directory\0");
    hash.update(directory);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function projectionReport(
  resolution: AgentPluginProjectionResolution,
  summary: AgentPluginProjectionSummary,
  artifacts: readonly GeneratedArtifact[],
  directories: readonly string[],
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
    contentDigest: artifactDigest(artifacts, directories),
    copiedFileCount: summary.copiedPaths.length,
    ...(directories.length === 0 ? {} : { directories }),
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
    const extensionFiles = source.files.filter((file) => file.path.startsWith(`${namespace}/`)).length;
    const manifestExtension = source.manifest.extensions?.[namespace] === undefined ? 0 : 1;
    const extensions = extensionFiles + manifestExtension;
    if (extensions > 0) discovered.set("agent-plugin.client-extension.files", extensions);
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

async function writeArtifacts(stagingRoot: string, key: string, artifacts: GeneratedArtifact[], directories: readonly string[]): Promise<string> {
  const dir = join(stagingRoot, key);
  await mkdir(dir, { recursive: true });
  for (const directory of directories) {
    const path = join(dir, directory);
    if (!isStrictDescendant(dir, path)) {
      throw new Error(`directory path ${JSON.stringify(directory)} resolves outside its output directory`);
    }
    await mkdir(path, { recursive: true });
  }
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
      exclude: await projectionExcludes(
        agentPluginRoot,
        configPath,
        config.entry,
        Object.values(config.targets).map((target) => target.output),
        config.agentPlugin.exclude ?? [],
      ),
    });
    diagnostics.push(
      ...diagnosticsFromAgentPluginIssues(loaded.issues, {
        onInvalid: config.agentPlugin.onInvalid ?? "error",
      }),
    );
    if (!loaded.package || hasFatal(diagnostics)) return fail();
    agentPlugin = loaded.package;
    report.agentPlugin = {
      root: relative(configDir, agentPluginRoot).replaceAll("\\", "/") || ".",
      specVersion: agentPlugin.specVersion,
      targets: config.agentPlugin.targets,
      sourceFileCount: agentPlugin.files.length,
      sourceFiles: agentPlugin.files.map((file) => file.path).sort(),
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

  // A dry run (`hooknostic check`) performs every generation step — bundling,
  // compilation, Agent Plugin projection, artifact validation — in memory so
  // that anything `build` would reject before touching the filesystem is
  // reported now. Only staging and the commit are skipped; nothing is written,
  // so a write the target filesystem itself refuses (path length, reserved
  // names) is the one failure only `build` can report.
  const dryRun = options.dryRun === true;
  const runtimePolicy = effectiveRuntime(config);
  const projectSdk = config.entry === undefined ? undefined : resolveProjectSdk(configDir);
  const outputByKey = new Map(layout.outputs.map((entry) => [entry.key, entry]));
  const staged: { key: string; target?: string; kind?: "directory" | "file"; stagingDir: string; outputDir: string }[] = [];
  /** Outputs a successful target will replace, whether or not this run stages. */
  const planned: { target: string; outputDir: string }[] = [];
  const failUncommitted = (): BuildResult => {
    // Under a dry run nothing would have been committed anyway; leave each
    // target's own verdict intact so `check` reports per-target results.
    if (dryRun) return { ok: false, report, analysis };
    for (const target of Object.values(report.targets)) {
      if (target.status === "success") target.status = "skipped";
      if (target.projection?.status === "success") target.projection.status = "skipped";
    }
    return { ok: false, report, analysis };
  };

  let stagingRoot: string | undefined;
  if (!dryRun) {
    try {
      stagingRoot = await mkdtemp(join(configDir, ".hooknostic-staging-"));
    } catch (error) {
      diagnostics.push({ code: "HN301", severity: "error", message: `could not create the staging directory: ${errorMessage(error)}`, remediation: "check permissions and free space in the directory containing hooknostic.config.ts." });
      return failUncommitted();
    }
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
        let directories: readonly string[] = [];
        let projectionCopiedPaths: ReadonlySet<string> | undefined;
        if (agentPlugin !== undefined && config.agentPlugin!.targets.includes(id)) {
          phase = "Agent Plugin projection";
          const projector = adapter.agentPluginProjector;
          // Analysis already fails a projection target whose adapter has no
          // projector, so this is unreachable; keep it a hard failure rather
          // than a silently empty output if that invariant ever slips.
          if (projector === undefined) throw new Error(`adapter ${JSON.stringify(adapter.id)} has no Agent Plugin projector`);
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
          if (plan.files.length === 0) {
            // A projected package always carries at least its native manifest;
            // an empty plan means the projector produced nothing to install.
            diagnostics.push({ code: "HN301", severity: "error", target: id, message: `Agent Plugin projection for ${JSON.stringify(id)} produced no artifacts.`, remediation: "remove the target from agentPlugin.targets or report the projector defect." });
            target.status = "failed";
            target.projection = { status: "failed", components: {}, omissions: plan.summary.omissions };
            continue;
          }
          artifacts = plan.files;
          directories = plan.directories ?? [];
          projectionCopiedPaths = new Set(plan.summary.copiedPaths);
          target.projection = projectionReport(projectionResolutions.get(id)!, plan.summary, artifacts, directories);
        }

        phase = "validation";
        const structural = validateGeneratedArtifacts(artifacts, { adapterId: adapter.id, target: id }, directories);
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

        const generated = new Set(hookArtifacts.map((artifact) => artifact.path));
        if (projectionCopiedPaths !== undefined) {
          // The projector reports what it copied byte-for-byte; the rest of its
          // plan it generated. Deriving the list this way keeps every harness's
          // own path layout inside its adapter, where ADR-0011 puts it.
          for (const artifact of artifacts) {
            if (!projectionCopiedPaths.has(artifact.path)) generated.add(artifact.path);
          }
        }
        target.artifacts = artifacts
          .map((artifact) => artifact.path)
          .filter((path) => generated.has(path));

        planned.push({ target: id, outputDir: outputByKey.get(id)!.outputDir });
        if (stagingRoot === undefined) continue;
        phase = "staging";
        const stagingDir = await writeArtifacts(stagingRoot, id, artifacts, directories);
        staged.push({ key: id, target: id, stagingDir, outputDir: outputByKey.get(id)!.outputDir });
      } catch (error) {
        diagnostics.push({ code: "HN301", severity: "error", target: id, message: `artifact ${phase} failed: ${errorMessage(error)}` });
        target.status = "failed";
        if (target.projection) target.projection.status = "failed";
      }
    }

    // The commit refuses to replace an output whose on-disk kind differs (a
    // regular file where a directory goes). Checked read-only here so a dry
    // run reports it too, instead of passing what `build` would refuse.
    const reportOutput = { target: undefined, outputDir: join(configDir, "hooknostic-build.json"), kind: "file" as const };
    for (const output of [...planned.map((p) => ({ ...p, kind: "directory" as const })), reportOutput]) {
      const problem = await existingKindProblem(output.outputDir, output.kind);
      if (problem === undefined) continue;
      diagnostics.push({
        code: "HN302",
        severity: "error",
        ...(output.target === undefined ? {} : { target: output.target }),
        message: problem,
        remediation: "move or remove the existing entry; hooknostic replaces only an output of the kind it writes.",
      });
      const target = output.target === undefined ? undefined : report.targets[output.target];
      if (target) target.status = "failed";
    }

    if (mainGuardTargets.length > 0) {
      diagnostics.push({ code: "HN502", severity: "warn", message: `the bundled hook source contains a CLI main-module guard (import.meta.url compared against process.argv[1]); ${mainGuardTargets.join(", ")} run the generated artifact as a command, so both sides of that comparison name the artifact and the guarded code executes on every hook dispatch.`, remediation: "move the command-line entry point into a module the hook source does not import, or gate it on an explicit environment variable instead." });
    }
    if (hasFatal(diagnostics)) return failUncommitted();
    if (stagingRoot === undefined) return { ok: true, report, analysis };

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
    if (stagingRoot !== undefined) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const reportPath = join(configDir, "hooknostic-build.json");
  return { ok: true, report, analysis, reportPath };
}
