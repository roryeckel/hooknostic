import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface StagedOutput {
  key: string;
  target: string;
  stagingDir: string;
  outputDir: string;
}

export interface CommitFailure {
  message: string;
  failedKey: string;
  failedTarget: string;
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
}

const FILES: FileOperations = { cp, lstat, mkdir, mkdtemp, rename, rm };

async function exists(path: string, files: FileOperations): Promise<boolean> {
  try {
    await files.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
      const parent = dirname(entry.outputDir);
      await files.mkdir(parent, { recursive: true });
      const transactionDir = await files.mkdtemp(
        join(parent, `.hooknostic-${basename(entry.outputDir)}-`),
      );
      const payloadDir = join(transactionDir, "payload");
      prepared.push({
        ...entry,
        transactionDir,
        payloadDir,
        backupDir: join(transactionDir, "backup"),
        installed: false,
        backedUp: false,
      });
      await files.cp(entry.stagingDir, payloadDir, { recursive: true });
      preparing = undefined;
    }
  } catch (error) {
    await Promise.allSettled(
      prepared.map((entry) => files.rm(entry.transactionDir, { recursive: true, force: true })),
    );
    const entry = preparing ?? entries.at(-1);
    return {
      ok: false,
      failure: {
        message: `could not prepare output transaction: ${error instanceof Error ? error.message : String(error)}`,
        failedKey: entry?.key ?? "unknown",
        failedTarget: entry?.target ?? "unknown",
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
        await files.rename(entry.outputDir, entry.backupDir);
        entry.backedUp = true;
      }
      await files.rename(entry.payloadDir, entry.outputDir);
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
          await files.rm(entry.outputDir, { recursive: true, force: true });
          entry.installed = false;
        }
        if (entry.backedUp) {
          await files.rename(entry.backupDir, entry.outputDir);
          entry.backedUp = false;
        }
      } catch (error) {
        rollbackErrors.push(
          `${entry.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const recoveryPaths = prepared
      .filter((entry) => entry.backedUp)
      .map((entry) => entry.backupDir);
    await Promise.allSettled(
      prepared
        .filter((entry) => !entry.backedUp)
        .map((entry) => files.rm(entry.transactionDir, { recursive: true, force: true })),
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
        failedTarget: failed?.target ?? "unknown",
        recoveryPaths,
      },
    };
  }

  await Promise.allSettled(
    prepared.map((entry) => files.rm(entry.transactionDir, { recursive: true, force: true })),
  );
  return { ok: true };
}
