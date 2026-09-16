import { spawnSync } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  type RuntimeDeclaration,
  runtimeDeclarationProblem,
  runtimeProvider,
  verifyPortableTree,
} from "@hooknostic/agent-plugin";
import type { AgentPluginRuntimeConfig, AgentPluginRuntimePackageConfig } from "@hooknostic/sdk";

/** A materialized runtime, ready for a projector to place in its output. */
export interface MaterializedRuntime {
  ecosystem: string;
  /** Destination relative to the target output, as declared by `into`. */
  into: string;
  files: { path: string; contents: Buffer }[];
}

/**
 * The npm runtime package, from either spelling.
 *
 * `components.runtimePackage` predates `components.runtime` and remains the
 * shorthand for its `npm` + `harness-installed` case. Both converge here rather
 * than in the projectors, so no adapter has to know there are two spellings.
 */
export function effectiveRuntimePackage(components: {
  runtimePackage?: AgentPluginRuntimePackageConfig;
  runtime?: AgentPluginRuntimeConfig[];
}): AgentPluginRuntimePackageConfig | undefined {
  if (components.runtimePackage !== undefined) return components.runtimePackage;
  const npm = components.runtime?.find((entry) => entry.ecosystem === "npm" && entry.delivery === "harness-installed");
  if (npm?.manifest === undefined || npm.lockfile === undefined) return undefined;
  return {
    manifest: npm.manifest,
    lockfile: npm.lockfile,
    ...(npm.allowInstallScripts === undefined ? {} : { allowInstallScripts: npm.allowInstallScripts }),
  };
}

/** Both spellings at once is ambiguous, and silently preferring one is worse. */
export function runtimeSpellingProblem(components: {
  runtimePackage?: AgentPluginRuntimePackageConfig;
  runtime?: AgentPluginRuntimeConfig[];
}): string | undefined {
  if (components.runtimePackage === undefined) return undefined;
  const npm = components.runtime?.some((entry) => entry.ecosystem === "npm");
  return npm === true
    ? "components.runtimePackage and a components.runtime npm entry both declare the npm runtime; keep one"
    : undefined;
}

/**
 * Everything wrong with the declared runtimes, as messages.
 *
 * Shape first (`runtimeDeclarationProblem`), then the ecosystem's own contract
 * over the declared files -- the same order the npm runtime package has always
 * been checked in, so an author sees "you cannot do that" before "your lockfile
 * is wrong about it".
 */
export async function validateRuntimeDeclarations(
  root: string,
  declarations: readonly RuntimeDeclaration[],
): Promise<string[]> {
  const problems: string[] = [];
  const destinations = new Set<string>();
  for (const declaration of declarations) {
    const shape = runtimeDeclarationProblem(declaration);
    if (shape !== undefined) {
      problems.push(shape);
      continue;
    }
    if (declaration.into !== undefined) {
      if (destinations.has(declaration.into)) {
        problems.push(`two runtimes both materialize into ${JSON.stringify(declaration.into)}`);
        continue;
      }
      destinations.add(declaration.into);
    }
    const provider = runtimeProvider(declaration.ecosystem)!;
    const files: { manifest?: Uint8Array; lockfile?: Uint8Array } = {};
    let unreadable = false;
    for (const key of ["manifest", "lockfile"] as const) {
      const declared = declaration[key];
      if (declared === undefined) continue;
      try {
        files[key] = await readFile(resolve(root, declared));
      } catch {
        problems.push(`${declaration.ecosystem} runtime ${key} ${JSON.stringify(declared)} could not be read`);
        unreadable = true;
      }
    }
    // Without the file, the ecosystem check can only repeat "it is missing" in
    // its own words, which reads as two mistakes where the author made one.
    if (unreadable) continue;
    const result = provider.validate(files, {
      ...(declaration.allowInstallScripts === undefined
        ? {}
        : { allowInstallScripts: declaration.allowInstallScripts }),
    });
    if (!result.ok) problems.push(`${declaration.ecosystem} runtime is invalid: ${result.error}`);
  }
  return problems;
}

async function readTree(root: string, dir = root, out: { path: string; contents: Buffer }[] = []) {
  for (const entry of (await readdir(dir)).sort()) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) await readTree(root, full, out);
    else out.push({ path: relative(root, full).replaceAll("\\", "/"), contents: await readFile(full) });
  }
  return out;
}

/**
 * Perform every `build-materialized` install and verify what comes out.
 *
 * Hooknostic invokes a package manager here, and only here. That is deliberate
 * and narrow: it happens solely for a declaration that asked for it, the
 * install is locked and offline and refuses to execute package code, and the
 * result is checked to be platform-independent before it may be committed. The
 * install is NOT trusted to have been portable merely because the ecosystem
 * says its packages are -- the bytes are read.
 *
 * `staging` is a caller-owned scratch directory; it is emptied per runtime so a
 * previous build's output cannot be mistaken for this one's.
 */
export async function materializeRuntimes(options: {
  root: string;
  staging: string;
  declarations: readonly RuntimeDeclaration[];
}): Promise<{ runtimes: MaterializedRuntime[]; problems: string[] }> {
  const runtimes: MaterializedRuntime[] = [];
  const problems: string[] = [];

  for (const declaration of options.declarations) {
    if (declaration.delivery !== "build-materialized") continue;
    const provider = runtimeProvider(declaration.ecosystem);
    if (provider?.materializeCommand === undefined || declaration.lockfile === undefined) continue;

    const into = join(options.staging, declaration.ecosystem);
    await rm(into, { recursive: true, force: true });
    const { command, args } = provider.materializeCommand({
      lockfile: resolve(options.root, declaration.lockfile),
      into,
    });

    // Spawned without a shell, so a provider's `tool` must be a real
    // executable rather than a `.cmd`/`.ps1` shim. `uv` is; if an ecosystem
    // ever needs a shim here, that is the point to route through cross-spawn
    // the way the generated MCP launcher already does.
    const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
    if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      problems.push(
        `${declaration.ecosystem} runtime needs ${JSON.stringify(provider.tool ?? command)} on PATH to materialize, ` +
          `and it was not found. Install it, or declare the runtime as author-supplied.`,
      );
      continue;
    }
    if (result.status !== 0) {
      const detail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" ").trim();
      problems.push(`${declaration.ecosystem} runtime install failed${detail === "" ? "" : `: ${detail}`}`);
      continue;
    }

    const installed = await readTree(into);
    const kept = installed.filter((file) => provider.excludedFromTree?.(file.path) !== true);
    const impure = verifyPortableTree(kept);
    if (impure.length > 0) {
      const shown = impure.slice(0, 3).map((problem) => `${problem.path} (${problem.reason})`);
      problems.push(
        `${declaration.ecosystem} runtime cannot be committed: ${impure.length} file(s) are built for one ` +
          `platform -- ${shown.join(", ")}${impure.length > shown.length ? ", ..." : ""}. A Hooknostic artifact ` +
          `is built once and installed anywhere (ADR-0006), so this tree would be wrong on every other machine. ` +
          `Use a pure distribution, or supply the dependency in the package yourself.`,
      );
      continue;
    }
    runtimes.push({ ecosystem: declaration.ecosystem, into: declaration.into!, files: kept });
  }

  return { runtimes, problems };
}
