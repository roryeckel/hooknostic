import type { Diagnostic } from "./diagnostics.js";
import { dirname, relative, resolve } from "node:path";
import { loadConfig } from "./load.js";
import { buildProject, type BuildOptions } from "./build.js";
import { applyProject, reconcileProject, recoverProject, type ProjectIntegration } from "./project-files.js";

export interface ProjectCommandResult { ok: boolean; drift: boolean; changes: string[]; guidance: string[]; errors: string[]; diagnostics: Diagnostic[] }
export async function runProject(options: BuildOptions & { command: "sync" | "verify" | "recover" }): Promise<ProjectCommandResult> {
  const result: ProjectCommandResult = { ok: false, drift: false, changes: [], guidance: [], errors: [], diagnostics: [] };
  try {
    if (options.targets !== undefined) throw new Error("project commands do not support partial target selection");
    const loaded = options.configResult ?? await loadConfig(options.configPath, options.evaluate);
    if (!loaded.config) throw new Error(loaded.diagnostics.map(d => d.message).join("\n"));
    const config = loaded.config;
    if (!config.project) throw new Error("project commands require project.root in the configuration");
    const root = resolve(dirname(options.configPath), config.project.root);
    const owner = relative(root, resolve(options.configPath)).replaceAll("\\", "/");
    if (options.command === "recover") {
      await recoverProject(root, owner);
      return { ...result, ok: true };
    }
    const built = await buildProject({ ...options, configResult: loaded, dryRun: true });
    result.diagnostics = built.report.diagnostics;
    if (!built.ok) throw new Error(built.report.diagnostics.map(d => d.message).join("\n"));
    const integration: ProjectIntegration = { files: [
      { path: ".hooknostic/.gitattributes", contents: "** -text\n" },
      { path: ".hooknostic/.gitignore", contents: "/data/\n/sync.lock\n/recovery.lock\n/transaction.json\n/staging/\n" },
    ], entries: [], guidance: [] };
    for (const target of built.plan ?? []) {
      const configured = config.targets[target.target]!;
      if (configured.delivery !== "project") continue;
      const adapter = options.registry[configured.adapter ?? target.target];
      if (!adapter?.projectIntegration) throw new Error(`adapter ${configured.adapter ?? target.target} has no project integrator`);
      const output = relative(root, target.outputDir).replaceAll("\\", "/");
      for (const artifact of target.artifacts) integration.files.push({ path: `${output}/${artifact.path}`, contents: artifact.contents, mode: artifact.mode ?? (artifact.executable ? 0o755 : 0o644) });
      const native = target.integration ?? adapter.projectIntegration(target.artifacts, output, owner);
      (integration.absent ??= []).push(...native.absent ?? []);
      integration.files.push(...native.files);
      integration.entries.push(...native.entries);
      integration.guidance.push(...native.guidance);
    }
    const plan = await reconcileProject(root, owner, integration);
    result.changes = plan.changes.map(c => c.path);
    result.drift = result.changes.length > 0;
    result.guidance = [...new Set(integration.guidance)];
    if (options.command === "sync" && !options.dryRun) await applyProject(root, owner, plan);
    result.ok = options.command !== "verify" || !result.drift;
  } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
  return result;
}
