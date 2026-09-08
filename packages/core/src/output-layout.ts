import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HooknosticConfig } from "@hooknostic/sdk";
import type { Diagnostic } from "./diagnostics.js";

export type ManagedOutputKind = "hooks" | "package";

export interface ManagedOutput {
  /** Display label only -- never an identity. Use `kind` + `target` to look one up. */
  key: string;
  kind: ManagedOutputKind;
  target: string;
  outputDir: string;
}

export interface OutputLayoutResult {
  outputs: ManagedOutput[];
  diagnostics: Diagnostic[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve symlinks in the longest existing prefix, including a final symlink. */
async function canonicalCandidate(path: string): Promise<string> {
  const missing: string[] = [];
  let cursor = resolve(path);
  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  const canonicalBase = await realpath(cursor);
  return resolve(canonicalBase, ...missing);
}

/** Resolve symlinked ancestors while retaining the final directory entry. */
async function canonicalDirectoryEntry(path: string): Promise<string> {
  const absolute = resolve(path);
  return resolve(await canonicalCandidate(dirname(absolute)), basename(absolute));
}

async function pathIdentities(path: string): Promise<string[]> {
  const identities = await Promise.all([canonicalDirectoryEntry(path), canonicalCandidate(path)]);
  return [...new Set(identities)];
}

/** True when `candidate` is strictly below `root` (both absolute and normalized). */
export function isStrictDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function containsPath(container: string, candidate: string): boolean {
  return container === candidate || isStrictDescendant(container, candidate);
}

function layoutError(target: string, message: string, remediation: string): Diagnostic {
  return { code: "HN501", severity: "error", target, message, remediation };
}

/**
 * Human-readable label for a target's separately delivered package output.
 *
 * Deliberately NOT an identity: target ids are arbitrary non-empty strings, so a
 * target literally named `x__package` would collide with the package output of
 * target `x` and one could be staged over the other. Look outputs up by
 * (`kind`, `target`) instead -- `kind` is a closed set, so the pair cannot collide.
 */
export function packageOutputLabel(target: string): string {
  return `${target}__package`;
}

/**
 * Resolve and validate every directory the build may recursively replace.
 * Target outputs are sandboxed to the config directory. An output may be a
 * configured, inventory-excluded descendant of an Agent Plugin root, but may
 * never replace the root itself or an ancestor containing it.
 */
export async function validateOutputLayout(options: {
  configPath: string;
  entryPath?: string;
  config: HooknosticConfig;
  selectedTargets: readonly string[];
}): Promise<OutputLayoutResult> {
  const configPath = resolve(options.configPath);
  const configDir = dirname(configPath);
  const canonicalConfigDir = await canonicalCandidate(configDir);
  const protectedPaths = (
    await Promise.all(
      [
        configPath,
        ...(options.entryPath === undefined ? [] : [resolve(options.entryPath)]),
        join(configDir, "hooknostic-build.json"),
      ].map(
        pathIdentities,
      ),
    )
  ).flat();
  const agentPluginPaths =
    options.config.agentPlugin === undefined
      ? []
      : await pathIdentities(resolve(configDir, options.config.agentPlugin.root));
  const diagnostics: Diagnostic[] = [];
  const outputs: ManagedOutput[] = [];
  const comparisonPaths = new Map<ManagedOutput, string[]>();

  for (const target of options.selectedTargets) {
    const targetConfig = options.config.targets[target];
    if (!targetConfig) continue;
    // `packageOutput` is a managed output like any other: it is replaced
    // wholesale, so it has to clear the same sandbox, protected-path and
    // source-package checks, and join the overlap matrix below.
    const managed: { key: string; kind: ManagedOutputKind; field: string; dir: string }[] = [
      { key: target, kind: "hooks", field: "output", dir: targetConfig.output },
      ...(targetConfig.packageOutput === undefined
        ? []
        : [{
            key: packageOutputLabel(target),
            kind: "package" as const,
            field: "packageOutput",
            dir: targetConfig.packageOutput,
          }]),
    ];
    for (const { key, kind, field, dir } of managed) {
      const outputDir = resolve(configDir, dir);
      const identities = await pathIdentities(outputDir);
      const escapedPath = identities.find(
        (path) => !isStrictDescendant(canonicalConfigDir, path),
      );
      if (escapedPath !== undefined) {
        diagnostics.push(
          layoutError(
            target,
            `target "${target}" ${field} resolves outside the project output sandbox: ${escapedPath}.`,
            "choose an output directory strictly below the directory containing hooknostic.config.ts.",
          ),
        );
        continue;
      }
      const protectedPath = protectedPaths.find((path) =>
        identities.some((outputPath) => containsPath(outputPath, path)),
      );
      if (protectedPath !== undefined) {
        diagnostics.push(
          layoutError(
            target,
            `target "${target}" ${field} would recursively replace a protected project path: ${protectedPath}.`,
            "choose a dedicated output directory that does not contain the config, hook entry, or build report.",
          ),
        );
        continue;
      }
      const overlappingAgentPlugin = agentPluginPaths.find((path) =>
        identities.some((outputPath) => containsPath(outputPath, path)),
      );
      if (overlappingAgentPlugin !== undefined) {
        diagnostics.push(
          layoutError(
            target,
            `target "${target}" ${field} overlaps the Agent Plugin source package: ${overlappingAgentPlugin}.`,
            "choose a dedicated output directory outside agentPlugin.root.",
          ),
        );
        continue;
      }
      const output = { key, kind, target, outputDir };
      outputs.push(output);
      comparisonPaths.set(output, identities);
    }
  }

  for (let left = 0; left < outputs.length; left += 1) {
    for (let right = left + 1; right < outputs.length; right += 1) {
      const a = outputs[left]!;
      const b = outputs[right]!;
      const aPaths = comparisonPaths.get(a)!;
      const bPaths = comparisonPaths.get(b)!;
      const overlaps = aPaths.some((aPath) =>
        bPaths.some(
          (bPath) => containsPath(aPath, bPath) || containsPath(bPath, aPath),
        ),
      );
      if (!overlaps) {
        continue;
      }
      const message = `managed outputs "${a.key}" and "${b.key}" overlap (${a.outputDir} and ${b.outputDir}).`;
      for (const target of new Set([a.target, b.target])) {
        diagnostics.push(
          layoutError(
            target,
            message,
            "assign disjoint final output directories to every selected target and Agent Plugin extension.",
          ),
        );
      }
    }
  }

  return { outputs, diagnostics };
}
