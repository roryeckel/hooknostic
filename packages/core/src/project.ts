import { dirname, join, relative, resolve } from "node:path";

import { resolveTargetAdapter, targetSpecFromConfig } from "./adapter.js";
import { type BuildOptions, buildProject, type McpServerCommand } from "./build.js";
import type { Diagnostic } from "./diagnostics.js";
import { linkedWorktree } from "./git-worktree.js";
import { loadConfig } from "./load.js";
import { applyProject, type ProjectIntegration, reconcileProject, recoverProject } from "./project-files.js";

export interface ProjectCommandResult {
  ok: boolean;
  drift: boolean;
  changes: string[];
  guidance: string[];
  errors: string[];
  diagnostics: Diagnostic[];
  /** How each stdio server's declared command is resolved. */
  mcpServers: McpServerCommand[];
}
export async function runProject(
  options: BuildOptions & { command: "sync" | "verify" | "recover" },
): Promise<ProjectCommandResult> {
  const result: ProjectCommandResult = {
    ok: false,
    drift: false,
    changes: [],
    guidance: [],
    errors: [],
    diagnostics: [],
    mcpServers: [],
  };
  try {
    if (options.targets !== undefined) throw new Error("project commands do not support partial target selection");
    const loaded =
      options.configResult ??
      (await loadConfig(options.configPath, options.evaluate, { allowEmptyProjectTargets: true }));
    if (!loaded.config) throw new Error(loaded.diagnostics.map((d) => d.message).join("\n"));
    const config = loaded.config;
    if (!config.project) throw new Error("project commands require project.root in the configuration");
    const root = resolve(dirname(options.configPath), config.project.root);
    const owner = relative(root, resolve(options.configPath)).replaceAll("\\", "/");
    if (options.command === "recover") {
      await recoverProject(root, owner);
      return { ...result, ok: true };
    }
    // Project commands reconcile the complete project target set, but package
    // targets are unrelated work: generating them can run materializers and
    // perform package-only validation even though none of their output enters
    // the integration transaction.
    const projectTargets = Object.entries(config.targets)
      .filter(([, target]) => target.delivery === "project")
      .map(([name]) => name);
    const built =
      projectTargets.length === 0
        ? undefined
        : await buildProject({ ...options, targets: projectTargets, configResult: loaded, dryRun: true });
    if (built !== undefined) {
      result.diagnostics = built.report.diagnostics;
      result.mcpServers = built.report.mcpServers ?? [];
      if (!built.ok) throw new Error(built.report.diagnostics.map((d) => d.message).join("\n"));
    }
    const integration: ProjectIntegration = {
      files: [
        { path: ".hooknostic/.gitattributes", contents: "** -text\n" },
        {
          path: ".hooknostic/.gitignore",
          contents: "/data/\n/sync.lock\n/recovery.lock\n/transaction.json\n/staging/\n",
        },
      ],
      entries: [],
      guidance: [],
    };
    const rootCheckoutWrites: { target: string; harness: string; path: string }[] = [];
    for (const target of built?.plan ?? []) {
      const configured = config.targets[target.target]!;
      if (configured.delivery !== "project") continue;
      const registered = options.registry[configured.adapter ?? target.target];
      const adapter =
        registered && resolveTargetAdapter(registered, targetSpecFromConfig(target.target, configured)).adapter;
      if (!adapter?.projectIntegration)
        throw new Error(`adapter ${configured.adapter ?? target.target} has no project integrator`);
      const output = relative(root, target.outputDir).replaceAll("\\", "/");
      for (const artifact of target.artifacts)
        integration.files.push({
          path: `${output}/${artifact.path}`,
          contents: artifact.contents,
          mode: artifact.mode ?? (artifact.executable ? 0o755 : 0o644),
        });
      const native = target.integration ?? adapter.projectIntegration(target.artifacts, output, owner);
      (integration.absent ??= []).push(...(native.absent ?? []));
      (integration.relinquishFiles ??= []).push(...(native.relinquishFiles ?? []));
      (integration.relinquishPrefixes ??= []).push(...(native.relinquishPrefixes ?? []));
      integration.files.push(...native.files);
      integration.entries.push(...native.entries);
      integration.guidance.push(...native.guidance);
      const written = new Set([...native.files, ...native.entries].map((item) => item.path));
      for (const path of adapter.rootCheckoutProjectPaths ?? [])
        if (written.has(path))
          rootCheckoutWrites.push({ target: target.target, harness: adapter.harness.displayName, path });
    }
    const linked = rootCheckoutWrites.length === 0 ? undefined : await linkedWorktree(root);
    if (linked !== undefined) {
      const inWorktree = relative(linked.checkout, root);
      result.diagnostics = [
        ...result.diagnostics,
        ...rootCheckoutWrites.map(({ target, harness, path }): Diagnostic => {
          const read = join(linked.rootCheckout, inWorktree, path);
          return {
            code: "HN107",
            severity: "warn",
            target,
            message:
              `${harness} never loads ${join(root, path)}: ${linked.checkout} is a linked git worktree of the root ` +
              `checkout ${linked.rootCheckout}, and ${harness} runs the root checkout's ${read} for sessions in this worktree.`,
            remediation:
              `The generated wiring takes effect once it is present, and trusted, in ${read}; synchronize from the root ` +
              `checkout ${linked.rootCheckout} before relying on it here. Hook lines the harness prints in this worktree ` +
              `belong to the root checkout's hooks, so verify by effect.`,
          };
        }),
      ];
    }
    const plan = await reconcileProject(root, owner, integration);
    result.changes = plan.changes.map((c) => c.path);
    result.drift = result.changes.length > 0;
    result.guidance = [...new Set(integration.guidance)];
    if (options.command === "sync" && !options.dryRun) await applyProject(root, owner, plan);
    result.ok = options.command !== "verify" || !result.drift;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}
