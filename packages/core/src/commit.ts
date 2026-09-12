import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface StagedOutput {
  key: string;
  target?: string;
  /** Files and directories share the same backup/install transaction. */
  kind?: "directory" | "file";
  stagingDir: string;
  outputDir: string;
}

export interface CommitFailure {
  message: string;
  failedKey: string;
  failedTarget?: string;
  recoveryPaths: string[];
}

export interface CommitResult {
  ok: boolean;
  failure?: CommitFailure;
}

interface FileOperations {
  cp: typeof cp;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  rename: typeof rename;
  rm: typeof rm;
  /** Injected by tests so retry backoff costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}

const FILES: FileOperations = { cp, lstat, mkdir, mkdtemp, rename, rm };

/**
 * Directory renames and removals are not reliably atomic on Windows: while
 * any other process still holds a handle on a file inside the tree — a search
 * indexer or virus scanner that noticed the freshly written artifacts, or an
 * editor watching the output directory — the operation fails with EPERM,
 * EACCES, EBUSY or ENOTEMPTY even though nothing is actually wrong. Those
 * handles are released within milliseconds, so the operation is retried
 * rather than failing the commit.
 *
 * Every other error, and exhaustion of the retries, still fails the
 * transaction with the rollback guarantees intact.
 */
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400];

function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_CODES.has(code);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function retryTransient<T>(files: FileOperations, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransient(error)) throw error;
      await (files.sleep ?? defaultSleep)(delay);
    }
  }
}

async function exists(path: string, files: FileOperations): Promise<boolean> {
  try {
    await files.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Why whatever already exists at `outputDir` cannot be replaced by a `kind`
 * output — a regular file where a directory goes, or vice versa — or
 * `undefined` when nothing is there or it is the right kind. Read-only, so a
 * dry run can report the same refusal the commit would make.
 */
export async function existingKindProblem(
  outputDir: string,
  kind: "directory" | "file",
  files: Pick<FileOperations, "lstat"> = FILES,
): Promise<string | undefined> {
  let stats;
  try {
    stats = await files.lstat(outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const matches = kind === "file" ? stats.isFile() : stats.isDirectory();
  return matches ? undefined : `existing output ${outputDir} is not a regular ${kind}`;
}

async function validateExistingKind(entry: StagedOutput, files: FileOperations): Promise<void> {
  const problem = await existingKindProblem(entry.outputDir, entry.kind ?? "directory", files);
  if (problem !== undefined) throw new Error(problem);
}

interface PreparedOutput extends StagedOutput {
  transactionDir: string;
  payloadDir: string;
  backupDir: string;
  installed: boolean;
  backedUp: boolean;
}

/** Internal filesystem injection exists only to make rollback failures testable. */
export async function commitStagedOutputs(
  entries: readonly StagedOutput[],
  files: FileOperations = FILES,
): Promise<CommitResult> {
  const prepared: PreparedOutput[] = [];
  let preparing: StagedOutput | undefined;
  try {
    for (const entry of entries) {
      preparing = entry;
      await validateExistingKind(entry, files);
      const parent = dirname(entry.outputDir);
      await files.mkdir(parent, { recursive: true });
      const transactionDir = await files.mkdtemp(join(parent, `.hooknostic-${basename(entry.outputDir)}-`));
      const payloadDir = join(transactionDir, "payload");
      prepared.push({
        ...entry,
        transactionDir,
        payloadDir,
        backupDir: join(transactionDir, "backup"),
        installed: false,
        backedUp: false,
      });
      await files.cp(entry.stagingDir, payloadDir, {
        recursive: (entry.kind ?? "directory") === "directory",
      });
      preparing = undefined;
    }
  } catch (error) {
    await Promise.allSettled(
      prepared.map((entry) =>
        retryTransient(files, () => files.rm(entry.transactionDir, { recursive: true, force: true })),
      ),
    );
    const entry = preparing ?? entries.at(-1);
    return {
      ok: false,
      failure: {
        message: `could not prepare output transaction: ${error instanceof Error ? error.message : String(error)}`,
        failedKey: entry?.key ?? "unknown",
        ...(entry?.target !== undefined ? { failedTarget: entry.target } : {}),
        recoveryPaths: [],
      },
    };
  }

  let failed: PreparedOutput | undefined;
  let primaryError: unknown;
  try {
    for (const entry of prepared) {
      failed = entry;
      if (await exists(entry.outputDir, files)) {
        await retryTransient(files, () => files.rename(entry.outputDir, entry.backupDir));
        entry.backedUp = true;
      }
      await retryTransient(files, () => files.rename(entry.payloadDir, entry.outputDir));
      entry.installed = true;
      failed = undefined;
    }
  } catch (error) {
    primaryError = error;
  }

  if (primaryError !== undefined) {
    const rollbackErrors: string[] = [];
    for (const entry of [...prepared].reverse()) {
      try {
        if (entry.installed) {
          await retryTransient(files, () => files.rm(entry.outputDir, { recursive: true, force: true }));
          entry.installed = false;
        }
        if (entry.backedUp) {
          await retryTransient(files, () => files.rename(entry.backupDir, entry.outputDir));
          entry.backedUp = false;
        }
      } catch (error) {
        rollbackErrors.push(`${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const recoveryPaths = prepared.filter((entry) => entry.backedUp).map((entry) => entry.backupDir);
    await Promise.allSettled(
      prepared
        .filter((entry) => !entry.backedUp)
        .map((entry) => retryTransient(files, () => files.rm(entry.transactionDir, { recursive: true, force: true }))),
    );
    return {
      ok: false,
      failure: {
        message: [
          `output commit failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`,
          ...(rollbackErrors.length > 0
            ? [`rollback was incomplete (${rollbackErrors.join("; ")})`]
            : ["previous outputs were restored"]),
        ].join("; "),
        failedKey: failed?.key ?? "unknown",
        ...(failed?.target !== undefined ? { failedTarget: failed.target } : {}),
        recoveryPaths,
      },
    };
  }

  await Promise.allSettled(prepared.map((entry) => files.rm(entry.transactionDir, { recursive: true, force: true })));
  return { ok: true };
}
