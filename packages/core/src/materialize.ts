import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";

import spawn from "cross-spawn";

import type {
  AgentPluginRuntimePackageConfig,
  PackageMaterializationConfig,
  PackageMaterializerContext,
  PackageMaterializerFile,
} from "@hooknostic/sdk";

export interface MaterializedPackageTree {
  provider: string;
  into: string;
  files: PackageMaterializerFile[];
}

type ResolvedInput = { ok: true; input: PackageMaterializerContext["inputs"][string] } | { ok: false; error: string };

/** The legacy npm shorthand remains a harness-owned install input (ADR-0012). */
export function effectiveRuntimePackage(components: {
  runtimePackage?: AgentPluginRuntimePackageConfig;
}): AgentPluginRuntimePackageConfig | undefined {
  return components.runtimePackage;
}

export type MaterializationDestination = { ok: true; path: string } | { ok: false; error: string };

/** Canonicalize a plugin-root-relative POSIX destination without admitting cross-platform escapes. */
export function normalizeMaterializationDestination(value: string): MaterializationDestination {
  if (
    value === "" ||
    value.includes("\\") ||
    value.includes(":") ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    return { ok: false, error: "must be a relative POSIX path without colons, backslashes, or control characters" };
  }
  const path = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (path === "" || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { ok: false, error: "must not contain empty, . or .. segments" };
  }
  return { ok: true, path };
}

function portableInputPath(value: string): boolean {
  return (
    value !== "" &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !posix.isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

async function resolveInput(root: string, declared: string): Promise<ResolvedInput> {
  if (!portableInputPath(declared)) {
    return { ok: false, error: "must be a package-relative POSIX path without empty, . or .. segments" };
  }
  try {
    const [canonicalRoot, canonicalInput] = await Promise.all([realpath(root), realpath(resolve(root, declared))]);
    const rel = relative(canonicalRoot, canonicalInput);
    if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
      return { ok: false, error: "resolves outside the Agent Plugin root" };
    }
    if (!(await lstat(canonicalInput)).isFile()) return { ok: false, error: "must name a regular file" };
    return {
      ok: true,
      input: { path: declared, absolutePath: canonicalInput, contents: await readFile(canonicalInput) },
    };
  } catch {
    return { ok: false, error: "could not be read" };
  }
}

async function contextFor(
  root: string,
  declaration: PackageMaterializationConfig,
): Promise<{ context?: PackageMaterializerContext; problems: string[] }> {
  const problems: string[] = [];
  const inputs: Record<string, PackageMaterializerContext["inputs"][string]> = {};
  for (const [name, declared] of Object.entries(declaration.inputs)) {
    const resolved = await resolveInput(root, declared);
    if (!resolved.ok) {
      problems.push(
        `materializer ${JSON.stringify(declaration.provider.id)} input ${JSON.stringify(name)} ` +
          `${JSON.stringify(declared)} ${resolved.error}`,
      );
    } else inputs[name] = resolved.input;
  }
  if (problems.length > 0) return { problems };
  return { context: { root: await realpath(root), inputs }, problems };
}

/** Validate generic declaration and input invariants without invoking a provider or tool. */
export async function validateMaterializationDeclarations(
  root: string,
  declarations: readonly PackageMaterializationConfig[],
): Promise<string[]> {
  const problems: string[] = [];
  const destinations = new Set<string>();
  for (const declaration of declarations) {
    const destination = normalizeMaterializationDestination(declaration.into);
    if (!destination.ok) {
      problems.push(
        `materializer ${JSON.stringify(declaration.provider.id)} "into" ${JSON.stringify(declaration.into)} ${destination.error}`,
      );
      continue;
    }
    if (destinations.has(destination.path)) {
      problems.push(`two materializers both write into ${JSON.stringify(destination.path)}`);
      continue;
    }
    destinations.add(destination.path);
    problems.push(...(await contextFor(root, declaration)).problems);
  }
  return problems;
}

async function readTree(
  root: string,
  dir = root,
  out: PackageMaterializerFile[] = [],
  problems: string[] = [],
): Promise<{ files: PackageMaterializerFile[]; problems: string[] }> {
  for (const entry of (await readdir(dir)).sort()) {
    const full = join(dir, entry);
    const info = await lstat(full);
    const path = relative(root, full).replaceAll("\\", "/");
    if (info.isSymbolicLink()) {
      problems.push(`${path} is a symbolic link; materialized output must be self-contained regular files`);
    } else if (info.isDirectory()) {
      await readTree(root, full, out, problems);
    } else if (info.isFile()) {
      // ADR-0013: host permission bits are not portable. Providers may make a
      // file explicitly executable in postprocess after applying their own
      // ecosystem-specific rules.
      out.push({ path, contents: await readFile(full), mode: 0o644 });
    } else {
      problems.push(`${path} is not a regular file`);
    }
  }
  return { files: out, problems };
}

function treeProblems(files: readonly PackageMaterializerFile[]): string[] {
  const problems: string[] = [];
  const paths = new Set<string>();
  for (const file of files) {
    if (!portableInputPath(file.path)) {
      problems.push(`provider returned invalid output path ${JSON.stringify(file.path)}`);
      continue;
    }
    if (paths.has(file.path)) problems.push(`provider returned duplicate output path ${JSON.stringify(file.path)}`);
    paths.add(file.path);
    if (file.mode !== 0o644 && file.mode !== 0o755) {
      problems.push(
        `provider returned invalid output mode ${String(file.mode)} for ${JSON.stringify(file.path)}; ` +
          `materialized files must use canonical mode 0644 or 0755`,
      );
    }
  }
  return problems;
}

const STDERR_TAIL_BYTES = 64 * 1024;

interface MaterializerCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

function appendTail(current: Buffer, chunk: unknown): Buffer {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (next.length >= STDERR_TAIL_BYTES) return Buffer.from(next.subarray(next.length - STDERR_TAIL_BYTES));
  const combined = Buffer.concat([current, next]);
  return combined.length <= STDERR_TAIL_BYTES
    ? combined
    : Buffer.from(combined.subarray(combined.length - STDERR_TAIL_BYTES));
}

/** Run a provider without buffering unbounded output; its result is the staged tree, not stdout. */
async function runMaterializerCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<MaterializerCommandResult> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    return {
      status: null,
      signal: null,
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stderr?.on("data", (chunk: unknown) => {
    stderrTail = appendTail(stderrTail, chunk);
  });

  return await new Promise<MaterializerCommandResult>((resolveResult) => {
    let spawnError: NodeJS.ErrnoException | undefined;
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.once("close", (status: number | null, signal: NodeJS.Signals | null) => {
      resolveResult({
        status,
        signal,
        stderr: stderrTail.toString("utf8"),
        ...(spawnError === undefined ? {} : { error: spawnError }),
      });
    });
  });
}

function stderrDetail(stderr: string): string {
  return stderr.trim().split(/\r?\n/).slice(-3).join(" ").trim();
}

/** Execute trusted providers once and return opaque package trees reusable by every package projector. */
export async function materializePackages(options: {
  root: string;
  staging: string;
  declarations: readonly PackageMaterializationConfig[];
}): Promise<{ trees: MaterializedPackageTree[]; problems: string[] }> {
  const trees: MaterializedPackageTree[] = [];
  const declarationProblems = await validateMaterializationDeclarations(options.root, options.declarations);
  if (declarationProblems.length > 0) return { trees, problems: declarationProblems };

  const problems: string[] = [];
  for (const [index, declaration] of options.declarations.entries()) {
    const destination = normalizeMaterializationDestination(declaration.into);
    if (!destination.ok) continue;
    const prepared = await contextFor(options.root, declaration);
    if (prepared.context === undefined) {
      problems.push(...prepared.problems);
      continue;
    }
    const context = prepared.context;
    try {
      const validation = (await declaration.provider.validate?.(context)) ?? [];
      if (validation.length > 0) {
        problems.push(
          ...validation.map((problem) => `materializer ${JSON.stringify(declaration.provider.id)}: ${problem}`),
        );
        continue;
      }

      const outputDir = join(options.staging, `${index}-${declaration.provider.id.replace(/[^A-Za-z0-9._-]/g, "_")}`);
      await rm(outputDir, { recursive: true, force: true });
      await mkdir(outputDir, { recursive: true });
      const plan = await declaration.provider.plan({ ...context, outputDir });
      if (plan.command === "" || plan.args.some((argument) => typeof argument !== "string")) {
        problems.push(`materializer ${JSON.stringify(declaration.provider.id)} returned an invalid command plan`);
        continue;
      }
      const result = await runMaterializerCommand(plan.command, plan.args, context.root);
      if (result.error != null && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
        problems.push(
          `materializer ${JSON.stringify(declaration.provider.id)} needs ${JSON.stringify(plan.command)} on PATH, and it was not found`,
        );
        continue;
      }
      if (result.error != null) {
        problems.push(
          `materializer ${JSON.stringify(declaration.provider.id)} could not start command ${JSON.stringify(plan.command)}: ${result.error.message}`,
        );
        continue;
      }
      if (result.status !== 0) {
        const detail = stderrDetail(result.stderr);
        const outcome =
          result.status === null
            ? `terminated by signal ${result.signal ?? "unknown"}`
            : `exited with code ${result.status}`;
        problems.push(
          `materializer ${JSON.stringify(declaration.provider.id)} command ${outcome}${detail === "" ? "" : `: ${detail}`}`,
        );
        continue;
      }

      const produced = await readTree(outputDir);
      if (produced.problems.length > 0) {
        problems.push(
          ...produced.problems.map((problem) => `materializer ${JSON.stringify(declaration.provider.id)}: ${problem}`),
        );
        continue;
      }
      const processed = declaration.provider.postprocess
        ? await declaration.provider.postprocess(produced.files, context)
        : { files: produced.files, problems: [] };
      if (processed.problems.length > 0) {
        problems.push(
          ...processed.problems.map((problem) => `materializer ${JSON.stringify(declaration.provider.id)}: ${problem}`),
        );
        continue;
      }
      const structural = treeProblems(processed.files);
      if (structural.length > 0) {
        problems.push(
          ...structural.map((problem) => `materializer ${JSON.stringify(declaration.provider.id)}: ${problem}`),
        );
        continue;
      }
      trees.push({ provider: declaration.provider.id, into: destination.path, files: [...processed.files] });
    } catch (error) {
      problems.push(
        `materializer ${JSON.stringify(declaration.provider.id)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { trees, problems };
}
