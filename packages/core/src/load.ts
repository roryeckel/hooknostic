import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import type { HooknosticConfig, PluginSpec } from "@hooknostic/sdk";
import { hooknosticConfigSchema } from "@hooknostic/sdk";

import { createRequireBanner } from "./bundle-support.mjs";
import type { Diagnostic } from "./diagnostics.js";

export interface EvaluateOptions {
  /**
   * Module specifier overrides for bundling (e.g. mapping "@hooknostic/sdk"
   * to a workspace path when evaluating fixtures outside an installed
   * project).
   */
  alias?: Record<string, string>;
}

/**
 * Bundle-safe evaluation of user TypeScript modules (config and hook entry).
 * The module is bundled self-contained with esbuild, written to a temp file,
 * and imported; nothing from the user's module graph escapes evaluation.
 */
async function evaluateModule(file: string, options?: EvaluateOptions): Promise<unknown> {
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
    ...(options?.alias ? { alias: options.alias } : {}),
  });
  const code = bundled.outputFiles[0]?.text;
  if (code === undefined) {
    throw new Error(`esbuild produced no output for ${file}`);
  }

  // Resolve the long path so 8.3 short names (RUNNER~1) never reach
  // import(): pathToFileURL percent-encodes "~" as %7E and vite-node then
  // fails to load the URL (node fine, vitest runner not — vitest#7084).
  const dir = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-eval-"));
  const out = join(dir, "module.mjs");
  try {
    await writeFile(out, code, "utf8");
    const mod = (await import(pathToFileURL(out).href)) as { default?: unknown };
    return mod.default;
  } finally {
    await rm(dir, { recursive: true, force: true });
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
    evaluated = await evaluateModule(configPath, options);
  } catch (error) {
    diagnostics.push({
      code: "HN501",
      severity: "error",
      message: `failed to load config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
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
        message: `invalid configuration: ${issue.path.join(".") || "<root>"}: ${issue.message}`,
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
    const evaluated = await evaluateModule(entryPath, options);
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
      message: `failed to load entry ${entryPath}: ${error instanceof Error ? error.message : String(error)}`,
      location: { file: entryPath },
    });
    return { diagnostics };
  }
}
