import { projectPath } from "./project-files.js";
import type { ProjectIntegration } from "./project-files.js";
import { minimatch } from "minimatch";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  loadAgentPlugin,
  classifyStdioCwd,
  hasUnportableCommandPath,
  loadProjectComponents,
  packageComponents,
  type ProjectComponents,
  type AgentPluginComponentId,
  type AgentPluginPackage,
  type AgentPluginProjectionSummary,
} from "@hooknostic/agent-plugin";
import { meetsMinimum, type SupportLevel } from "@hooknostic/sdk";
import type { AdapterRegistry, CapabilityMatrix, GeneratedArtifact, TargetSpec } from "./adapter.js";
import { targetSpecFromConfig } from "./adapter.js";
import {
  analyzeAgentPluginProjection,
  resolveAgentPluginProjection,
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
  /** Reuse the already evaluated configuration inside a project command. */
  configResult?: Awaited<ReturnType<typeof loadConfig>>;
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
  project?: { components: AgentPluginTargetReport["components"]; omissions: AgentPluginTargetReport["omissions"]; guidance: string[] };
}

export interface BuildReport {
  schemaVersion: 2;
  hooknosticVersion: string;
  source?: string;
  targets: Record<string, BuildTargetReport>;
  components?: {
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
  componentSource?: ProjectComponents;
  plan?: { target: string; outputDir: string; artifacts: GeneratedArtifact[]; directories: readonly string[]; integration?: ProjectIntegration }[];
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

  const configResult = options.configResult ?? await loadConfig(configPath, options.evaluate);
  diagnostics.push(...configResult.diagnostics);
  if (!configResult.config) return fail();
  const config = configResult.config;

  let components: AgentPluginPackage | undefined;
  if (config.components?.root !== undefined) {
    const agentPluginRoot = resolve(configDir, config.components.root);
    const loaded = await loadAgentPlugin({
      root: agentPluginRoot,
      ...(config.components.executableFiles === undefined ? {} : { executableFiles: config.components.executableFiles }),
      exclude: await projectionExcludes(
        agentPluginRoot,
        configPath,
        config.entry,
        // Or a build inventories the previous package as source: with
        // `root: "."` a projector then copies it into the next one, nesting a
        // level deeper every run until path validation fails.
        Object.values(config.targets).map((target) => target.output),
        config.components.exclude ?? [],
      ),
    });
    diagnostics.push(
      ...diagnosticsFromAgentPluginIssues(loaded.issues, {
        onInvalid: config.components.onInvalid ?? "error",
      }),
    );
    if (!loaded.package || hasFatal(diagnostics)) return fail();
    components = loaded.package;
    report.components = {
      root: relative(configDir, agentPluginRoot).replaceAll("\\", "/") || ".",
      specVersion: components.specVersion,
      targets: (config.components.targets ?? Object.keys(config.targets)),
      sourceFileCount: components.files.length,
      sourceFiles: components.files.map((file) => file.path).sort(),
      contentDigest: components.contentDigest,
    };
  }

  let componentSource: ProjectComponents | undefined;
  if (components) componentSource = packageComponents(components);
  else if (config.components) {
    const loaded = await loadProjectComponents({
      ...(config.components.skills === undefined ? {} : { skills: config.components.skills.map(p => resolve(configDir, p)) }),
      ...(config.components.mcp === undefined ? {} : { mcp: resolve(configDir, config.components.mcp) }),
    });
    diagnostics.push(...diagnosticsFromAgentPluginIssues(loaded.issues, { onInvalid: config.components.onInvalid ?? "error" }));
    if (hasFatal(diagnostics)) return fail();
    componentSource = loaded.source;
  }
  if (config.components?.root === undefined && componentSource && Object.values(config.targets).some(t => t.delivery === "package")) {
    diagnostics.push({ code: "HN501", severity: "error", message: "package delivery requires components.root with an Agent Plugins manifest" });
    return fail();
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
    if (components !== undefined) {
      if (ir.version === undefined && components.manifest.version !== undefined) {
        ir.version = components.manifest.version;
      }
      if (ir.description === undefined && components.manifest.description !== undefined) {
        ir.description = components.manifest.description;
      }
    }
  } else {
    if (components === undefined && componentSource === undefined) return fail();
    ir = {
      name: components?.manifest.name ?? "project-components",
      ...(components?.manifest.version === undefined ? {} : { version: components.manifest.version }),
      ...(components?.manifest.description === undefined ? {} : { description: components.manifest.description }),
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
    if (components !== undefined && config.targets[id]!.delivery === "package" && (config.components!.targets ?? Object.keys(config.targets)).includes(id)) {
      const spec = targetSpecFromConfig(id, config.targets[id]!);
      const resolution = analyzeAgentPluginProjection(
        components,
        options.registry[config.targets[id]!.adapter ?? id]!,
        spec,
        config.components!.onUnsupported ?? "error",
        config.components!.runtimePackage,
      );
      projectionResolutions.set(id, resolution);
      diagnostics.push(...resolution.diagnostics);
      report.targets[id]!.projection = analyzedProjectionReport(
        components,
        resolution,
        options.registry[config.targets[id]!.adapter ?? id]!.agentPluginProjector?.namespace,
        config.components!.runtimePackage !== undefined,
      );
      if (hasFatal(resolution.diagnostics)) report.targets[id]!.status = "failed";
    }
  }

  const layout = await validateOutputLayout({
    configPath,
    ...(entryPath === undefined ? {} : { entryPath }),
    config,
    selectedTargets: Object.keys(analysis.targets),
    protectedPaths: [
      ...(config.components?.skills ?? []).map(path => resolve(configDir, path)),
      ...(config.components?.mcp ? [resolve(configDir, config.components.mcp)] : []),
      ...(config.project ? [
        ...["integration.json", "transaction.json", "sync.lock", "recovery.lock", "staging", "data"].map(path => resolve(configDir, config.project!.root, ".hooknostic", path)),
        ...Object.entries(config.targets).flatMap(([name, target]) => (options.registry[target.adapter ?? name]?.projectPaths ?? []).map(path => resolve(configDir, config.project!.root, path))),
      ] : []),
    ],
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
  const outputFor = (target: string) =>
    layout.outputs.find((entry) => entry.target === target);
  const staged: { key: string; target?: string; kind?: "directory" | "file"; stagingDir: string; outputDir: string }[] = [];
  /** Outputs a successful target will replace, whether or not this run stages. */
  const planned: NonNullable<BuildResult["plan"]> = [];
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
      const adapter = options.registry[config.targets[id]!.adapter ?? id]!;
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
              targetId: id,
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
        if (components !== undefined && config.targets[id]!.delivery === "package" && (config.components!.targets ?? Object.keys(config.targets)).includes(id)) {
          phase = "Agent Plugin projection";
          const projector = adapter.agentPluginProjector;
          // Analysis already fails a projection target whose adapter has no
          // projector, so this is unreachable; keep it a hard failure rather
          // than a silently empty output if that invariant ever slips.
          if (projector === undefined) throw new Error(`adapter ${JSON.stringify(adapter.id)} has no Agent Plugin projector`);
          const plan = await projector.project(components, {
            target: spec,
            hookArtifacts,
            ...(config.components!.runtimePackage === undefined
              ? {}
              : { runtimePackage: config.components!.runtimePackage }),
            support: projectionResolutions.get(id)?.matrix ?? {},
            onUnsupported: config.components!.onUnsupported ?? "error",
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
            diagnostics.push({ code: "HN301", severity: "error", target: id, message: `Agent Plugin projection for ${JSON.stringify(id)} produced no artifacts.`, remediation: "remove the target from components.targets or report the projector defect." });
            target.status = "failed";
            target.projection = { status: "failed", components: {}, omissions: plan.summary.omissions };
            continue;
          }
          // The projected package replaces the compiled artifacts wholesale, so
          // it is also the harness's hook channel and has to carry every hook
          // artifact through. Verified rather than trusted: a projector that
          // dropped one would install a package that looks complete and runs no
          // hooks, with nothing else in the build to notice.
          const projected = new Set(plan.files.map((file) => file.path));
          const dropped = hookArtifacts
            .map((artifact) => artifact.path)
            .filter((path) => !projected.has(path));
          if (dropped.length > 0) {
            diagnostics.push({
              code: "HN301",
              severity: "error",
              target: id,
              message: `Agent Plugin projection for ${JSON.stringify(id)} dropped compiled hook artifacts: ${dropped.map((path) => JSON.stringify(path)).join(", ")}.`,
              remediation: "report the projector defect; a projected package must carry context.hookArtifacts.",
            });
            target.status = "failed";
            target.projection = { status: "failed", components: {}, omissions: plan.summary.omissions };
            continue;
          }
          artifacts = plan.files;
          directories = plan.directories ?? [];
          projectionCopiedPaths = new Set(plan.summary.copiedPaths);
          target.projection = projectionReport(
            projectionResolutions.get(id)!,
            plan.summary,
            artifacts,
            directories,
          );
        }

        let integration: ProjectIntegration | undefined;
        if (targetConfig.delivery === "project" && config.project) {
          if (!adapter.projectIntegration) throw new Error(`adapter ${adapter.id} has no project integrator`);
          const root = resolve(configDir, config.project.root);
          const output = relative(root, outputFor(id)!.outputDir).replaceAll("\\", "/");
          await projectPath(root, relative(root, configPath).replaceAll("\\", "/"));
          await projectPath(root, output);
          integration = adapter.projectIntegration(artifacts, output);
          if (componentSource && (config.components?.targets ?? Object.keys(config.targets)).includes(id)) {
            if (!adapter.projectComponents) throw new Error(`adapter ${adapter.id} has no project component integrator`);
            const support = resolveAgentPluginProjection(spec, { profiles: adapter.projectComponentProfiles ?? [] });
            diagnostics.push(...support.diagnostics);
            if (!support.matrix) throw new Error("project component support is unavailable for the configured version range");
            const selectedSource: ProjectComponents = { skills: [...componentSource.skills], ...(componentSource.mcp === undefined ? {} : { mcp: { ...componentSource.mcp, config: { ...componentSource.mcp.config, mcpServers: { ...componentSource.mcp.config.mcpServers } } } }) };
            const counts: AgentPluginTargetReport["components"] = {};
            const omissions: AgentPluginTargetReport["omissions"] = [];
            const count = (component: AgentPluginComponentId, discovered: number): boolean => {
              if (!discovered) return true;
              const cell = support.matrix![component];
              const supported = cell !== undefined && cell.level !== "unsupported";
              counts[component] = { support: cell?.level ?? "unsupported", discovered, emitted: supported ? discovered : 0, skipped: supported ? 0 : discovered };
              if (!supported) {
                const reason = cell?.rationale ?? "component has no project delivery representation";
                omissions.push({ component, reason });
                diagnostics.push({ code: "HN205", severity: config.components?.onUnsupported ?? "error", target: id, component, message: reason });
              }
              if (supported) {
                const policy = effectiveCompatibility(config, id);
                if (!meetsMinimum(cell.level, policy.minimum)) diagnostics.push({ code: "HN205", severity: policy.onBelowMinimum, target: id, component, message: `${component} project support ${cell.level} is below ${policy.minimum}` });
              }
              return supported;
            };
            if (!count("agent-plugin.skills", selectedSource.skills.length)) selectedSource.skills = [];
            for (const type of ["stdio", "streamable-http", "sse"] as const) {
              const servers = Object.entries(selectedSource.mcp?.config.mcpServers ?? {}).filter(([, server]) => server.type === type);
              if (!count(`agent-plugin.mcp.${type}`, servers.length)) for (const [name] of servers) delete selectedSource.mcp!.config.mcpServers[name];
            }
            for (const [name, server] of Object.entries(selectedSource.mcp?.config.mcpServers ?? {})) {
              if (server.type !== "stdio" || (!hasUnportableCommandPath(server.command) && classifyStdioCwd(server.cwd) !== undefined)) continue;
              const reason = `MCP server ${name} has unsupported portable command or working-directory semantics`;
              diagnostics.push({ code: "HN205", severity: config.components?.onUnsupported ?? "error", target: id, component: "agent-plugin.mcp.stdio", message: reason });
              omissions.push({ component: "agent-plugin.mcp.stdio", reason });
              delete selectedSource.mcp!.config.mcpServers[name];
              const counted = counts["agent-plugin.mcp.stdio"]!; counted.emitted--; counted.skipped++;
            }
            count("agent-plugin.runtime-package", config.components?.runtimePackage === undefined ? 0 : 1);
            const namespace = adapter.agentPluginProjector?.namespace;
            count("agent-plugin.client-extension.files", components && namespace ? components.files.filter(file => file.path.startsWith(namespace + "/")).length + (components.manifest.extensions?.[namespace] ? 1 : 0) : 0);
            target.project = { components: counts, omissions, guidance: [] };
            if (hasFatal(diagnostics)) { target.status = "failed"; continue; }
            const projected = await adapter.projectComponents(selectedSource, root, output, relative(root, configPath).replaceAll("\\", "/"));
            target.project = { components: counts, omissions, guidance: projected.guidance };
            integration.files.push(...projected.files);
            integration.entries.push(...projected.entries);
            integration.guidance.push(...projected.guidance);
            integration.absent = [...integration.absent ?? [], ...projected.absent ?? []];
          }
          for (const destination of [...integration.files, ...integration.entries]) await projectPath(root, destination.path);
          for (const file of integration.files) {
            if (file.path.startsWith(output + "/")) artifacts.push({ path: file.path.slice(output.length + 1), contents: file.contents, ...(file.mode === undefined ? {} : { mode: file.mode }) });
          }
          integration.files = integration.files.filter(file => !file.path.startsWith(output + "/"));
        }

        phase = "validation";
        const structural = validateGeneratedArtifacts(
          artifacts,
          { adapterId: adapter.id, target: id },
          directories,
        );
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

        planned.push({ target: id, outputDir: outputFor(id)!.outputDir, artifacts, directories, ...(integration === undefined ? {} : { integration }) });
        if (stagingRoot === undefined) continue;
        phase = "staging";
        const stagingDir = await writeArtifacts(stagingRoot, id, artifacts, directories);
        staged.push({ key: id, target: id, stagingDir, outputDir: outputFor(id)!.outputDir });
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
    if (stagingRoot === undefined) return { ok: true, report, analysis, plan: planned, ...(componentSource === undefined ? {} : { componentSource }) };

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
