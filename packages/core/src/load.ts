import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { errorMessage, exitCodeText, HookSourceExitError, isInstance } from "@hooknostic/runtime";
import type { HooknosticConfig, PluginSpec } from "@hooknostic/sdk";
import { hooknosticConfigSchema } from "@hooknostic/sdk/schemas";

import { createRequireBanner } from "./bundle-support.mjs";
import type { Diagnostic } from "./diagnostics.js";
import { formatSchemaIssue } from "./schema-issues.js";
import { withSdkSubpathAliases } from "./sdk-resolution.js";

export interface EvaluateOptions {
  /**
   * Module specifier overrides for bundling (e.g. mapping "@hooknostic/sdk"
   * to a workspace path when evaluating fixtures outside an installed
   * project).
   */
  alias?: Record<string, string>;
}

/** A bundled user module written where `import()` can load it. */
export interface StagedUserModule {
  /** File URL of the bundle; a distinct query string imports a fresh module instance. */
  href: string;
  /** The temp directory holding the bundle, which `dispose` removes. */
  directory: string;
  dispose(): Promise<void>;
}

/**
 * Bundle a user TypeScript module (config or hook entry) self-contained with
 * esbuild and write it to a temp file, so nothing from the user's module graph
 * escapes evaluation.
 */
export async function stageUserModule(file: string, options?: EvaluateOptions): Promise<StagedUserModule> {
  const absolute = resolve(file);
  const bundled = await build({
    entryPoints: [absolute],
    // Same reason as bundleRuntime: esbuild anchors its path bookkeeping to
    // absWorkingDir, which defaults to process.cwd(). This output is evaluated
    // rather than committed, so the stakes are lower -- but a config that
    // resolves differently depending on where you invoked the CLI is its own
    // bug, and the inline sourcemap embeds those paths too.
    absWorkingDir: dirname(absolute),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    banner: { js: createRequireBanner },
    sourcemap: "inline",
    logLevel: "silent",
    ...(options?.alias ? { alias: withSdkSubpathAliases(options.alias) } : {}),
  });
  const code = bundled.outputFiles[0]?.text;
  if (code === undefined) {
    throw new Error(`esbuild produced no output for ${file}`);
  }

  // Resolve the long path so 8.3 short names (RUNNER~1) never reach
  // import(): pathToFileURL percent-encodes "~" as %7E and vite-node then
  // fails to load the URL (node fine, vitest runner not — vitest#7084).
  const dir = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-eval-"));
  const dispose = () => rm(dir, { recursive: true, force: true });
  const out = join(dir, "module.mjs");
  try {
    await writeFile(out, code, "utf8");
  } catch (error) {
    await dispose();
    throw error;
  }
  return { href: pathToFileURL(out).href, directory: dir, dispose };
}

/**
 * Internal (#193): how the CLI's process guard watches one evaluation of user
 * code. The CLI sets one for the command it runs; the programmatic API never
 * does, and then nothing here installs a process listener.
 */
export interface EvaluationGuard {
  /**
   * Settle as `evaluation` does, or reject first: with a failure of user code
   * the guard attributes to this load, or with an {@link EvaluationStalledError}
   * when the event loop empties while it is pending. `directory` holds the
   * staged bundle, and must be removed even if the process ends first.
   */
  watch<T>(directory: string, evaluation: Promise<T>): Promise<T>;
}

let evaluationGuard: EvaluationGuard | undefined;

/** Internal (#193): the CLI sets this for the command it runs, and clears it after. */
export function setEvaluationGuard(guard: EvaluationGuard | undefined): void {
  evaluationGuard = guard;
}

/** Internal (#193): the event loop emptied while a module was still loading. */
export class EvaluationStalledError extends Error {
  constructor() {
    super("the event loop emptied while the module loaded");
    this.name = "EvaluationStalledError";
  }
}

async function evaluateModule(file: string, subject: "config" | "entry", options?: EvaluateOptions): Promise<unknown> {
  const staged = await stageUserModule(file, options);
  // Read once: the CLI clears it when its command returns.
  const guard = evaluationGuard;
  let imported = false;
  try {
    const evaluation = (async () => {
      const mod = (await import(staged.href)) as { default?: unknown };
      imported = true;
      // Returned from an async function, so a thenable default export is
      // adopted, as an async config may rely on.
      return mod.default;
    })();
    return await (guard === undefined ? evaluation : guard.watch(staged.directory, evaluation));
  } catch (error) {
    if (guard === undefined) throw error;
    if (isInstance(error, EvaluationStalledError))
      throw new Error(
        imported ? "its default export is a thenable that never settles" : "its top-level await never settles",
      );
    // The runtime's message names the hook source, which a config is not.
    // Dispatch runs without this guard, and keeps it.
    if (subject === "config" && isInstance(error, HookSourceExitError))
      throw new Error(`the config called process.exit(${exitCodeText(error.code)})`);
    throw error;
  } finally {
    await staged.dispose();
  }
}

export interface LoadConfigResult {
  config?: HooknosticConfig;
  diagnostics: Diagnostic[];
}

export interface LoadConfigPolicy {
  /** Allow a project configuration to describe removal of its final target. */
  allowEmptyProjectTargets?: boolean;
}

export async function loadConfig(
  configPath: string,
  options?: EvaluateOptions,
  policy?: LoadConfigPolicy,
): Promise<LoadConfigResult> {
  const diagnostics: Diagnostic[] = [];
  let evaluated: unknown;
  try {
    evaluated = await evaluateModule(configPath, "config", options);
  } catch (error) {
    diagnostics.push({
      code: "HN501",
      severity: "error",
      message: `failed to load config ${configPath}: ${errorMessage(error)}`,
      location: { file: configPath },
      remediation: "the config must be a TypeScript module whose default export is defineConfig({...}).",
    });
    return { diagnostics };
  }

  const parsed = hooknosticConfigSchema.safeParse(evaluated);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push({
        code: "HN501",
        severity: "error",
        message: `invalid configuration: ${formatSchemaIssue(issue)}`,
        location: { file: configPath },
        remediation: "see docs/design.md §8.1 for the configuration shape.",
      });
    }
    return { diagnostics };
  }

  if (
    Object.keys(parsed.data.targets).length === 0 &&
    !(policy?.allowEmptyProjectTargets === true && parsed.data.project !== undefined)
  ) {
    diagnostics.push({
      code: "HN501",
      severity: "error",
      message: "configuration declares no targets.",
      location: { file: configPath },
      remediation: "add at least one entry under targets: { ... }.",
    });
    return { diagnostics };
  }

  return { config: parsed.data as HooknosticConfig, diagnostics };
}

export interface LoadPluginResult {
  plugin?: PluginSpec;
  diagnostics: Diagnostic[];
}

/**
 * Evaluate the plugin entry module. Structural validation (and IR
 * construction) happens in buildPluginIR; this only gets the module loaded.
 */
export async function loadPluginSource(entryPath: string, options?: EvaluateOptions): Promise<LoadPluginResult> {
  const diagnostics: Diagnostic[] = [];
  try {
    const evaluated = await evaluateModule(entryPath, "entry", options);
    if (evaluated === undefined || evaluated === null) {
      diagnostics.push({
        code: "HN501",
        severity: "error",
        message: `entry module ${entryPath} has no default export.`,
        location: { file: entryPath },
        remediation: "export default definePlugin({...}) from the entry module.",
      });
      return { diagnostics };
    }
    return { plugin: evaluated as PluginSpec, diagnostics };
  } catch (error) {
    diagnostics.push({
      code: "HN501",
      severity: "error",
      message: `failed to load entry ${entryPath}: ${errorMessage(error)}`,
      location: { file: entryPath },
    });
    return { diagnostics };
  }
}
