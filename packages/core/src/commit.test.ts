import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitStagedOutputs } from "./commit.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

async function fixture(existingFirst = true) {
  const root = await fs.mkdtemp(join(tmpdir(), "hooknostic-commit-"));
  cleanup.push(root);
  const firstStage = join(root, "stage-first");
  const secondStage = join(root, "stage-second");
  const firstOutput = join(root, "out/first");
  const secondOutput = join(root, "out/second");
  await fs.mkdir(firstStage, { recursive: true });
  await fs.mkdir(secondStage, { recursive: true });
  await fs.writeFile(join(firstStage, "value"), "new-first", "utf8");
  await fs.writeFile(join(secondStage, "value"), "new-second", "utf8");
  if (existingFirst) {
    await fs.mkdir(firstOutput, { recursive: true });
    await fs.writeFile(join(firstOutput, "value"), "old-first", "utf8");
  }
  await fs.mkdir(secondOutput, { recursive: true });
  await fs.writeFile(join(secondOutput, "value"), "old-second", "utf8");
  return {
    root,
    firstOutput,
    secondOutput,
    entries: [
      { key: "first", target: "first", stagingDir: firstStage, outputDir: firstOutput },
      { key: "second", target: "second", stagingDir: secondStage, outputDir: secondOutput },
    ],
  };
}

async function fixtureWithReport(existingReport = true) {
  const base = await fixture();
  const reportStage = join(base.root, "stage-report.json");
  const reportOutput = join(base.root, "hooknostic-build.json");
  await fs.writeFile(reportStage, "new-report", "utf8");
  if (existingReport) await fs.writeFile(reportOutput, "old-report", "utf8");
  return {
    ...base,
    reportOutput,
    entries: [
      ...base.entries,
      {
        key: "build-report",
        kind: "file" as const,
        stagingDir: reportStage,
        outputDir: reportOutput,
      },
    ],
  };
}

describe("commitStagedOutputs", () => {
  it("installs directory outputs and the build report together", async () => {
    const f = await fixtureWithReport();
    const result = await commitStagedOutputs(f.entries);
    expect(result).toEqual({ ok: true });
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("new-first");
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("new-second");
    expect(await fs.readFile(f.reportOutput, "utf8")).toBe("new-report");
  });

  it("retries an install rename that fails with a transient Windows error", async () => {
    const f = await fixture();
    let attempts = 0;
    const delays: number[] = [];
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async rename(from, to) {
        if (String(from).endsWith("payload") && attempts < 3) {
          attempts += 1;
          throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
            code: "EPERM",
          });
        }
        await fs.rename(from, to);
      },
      sleep: async (ms: number) => void delays.push(ms),
    });
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 25, 50]);
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("new-first");
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("new-second");
  });

  it("rolls back when a transient rename never recovers", async () => {
    const f = await fixture();
    let attempts = 0;
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async rename(from, to) {
        if (String(from).endsWith("payload")) {
          attempts += 1;
          throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
            code: "EPERM",
          });
        }
        await fs.rename(from, to);
      },
      sleep: async () => undefined,
    });
    // One initial attempt plus the full backoff schedule, then the commit fails.
    expect(attempts).toBe(7);
    expect(result).toMatchObject({ ok: false, failure: { failedKey: "first" } });
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("old-first");
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("old-second");
  });

  it("does not retry a rename that fails for a non-transient reason", async () => {
    const f = await fixture();
    let attempts = 0;
    let sleeps = 0;
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async rename(from, to) {
        if (String(from).endsWith("payload")) {
          attempts += 1;
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        await fs.rename(from, to);
      },
      sleep: async () => void (sleeps += 1),
    });
    expect(attempts).toBe(1);
    expect(sleeps).toBe(0);
    expect(result).toMatchObject({ ok: false, failure: { failedKey: "first" } });
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("old-first");
  });

  it("restores directories and the previous report when report installation fails", async () => {
    const f = await fixtureWithReport();
    let renameCount = 0;
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async rename(from, to) {
        renameCount += 1;
        if (renameCount === 6) throw new Error("simulated report install failure");
        await fs.rename(from, to);
      },
    });
    expect(result).toMatchObject({ ok: false, failure: { failedKey: "build-report" } });
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("old-first");
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("old-second");
    expect(await fs.readFile(f.reportOutput, "utf8")).toBe("old-report");
  });

  it("removes a newly-created report when rollback follows a later failure", async () => {
    const f = await fixtureWithReport(false);
    const trailingStage = join(f.root, "stage-trailing");
    const trailingOutput = join(f.root, "out/trailing");
    await fs.mkdir(trailingStage, { recursive: true });
    await fs.writeFile(join(trailingStage, "value"), "new-trailing", "utf8");
    f.entries.push({
      key: "trailing",
      target: "trailing",
      stagingDir: trailingStage,
      outputDir: trailingOutput,
    });
    let renameCount = 0;
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async rename(from, to) {
        renameCount += 1;
        if (renameCount === 6) throw new Error("simulated trailing install failure");
        await fs.rename(from, to);
      },
    });
    expect(result.ok).toBe(false);
    await expect(fs.lstat(f.reportOutput)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("old-first");
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("old-second");
  });

  it("restores every previous output when a later install rename fails", async () => {
    const f = await fixture();
    let renameCount = 0;
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async rename(from, to) {
        renameCount += 1;
        if (renameCount === 4) throw new Error("simulated install failure");
        await fs.rename(from, to);
      },
    });
    expect(result).toMatchObject({ ok: false, failure: { failedKey: "second" } });
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("old-first");
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("old-second");
    expect(result.failure?.recoveryPaths).toEqual([]);
  });

  it("removes an earlier newly-created output during rollback", async () => {
    const f = await fixture(false);
    let renameCount = 0;
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async rename(from, to) {
        renameCount += 1;
        if (renameCount === 3) throw new Error("simulated install failure");
        await fs.rename(from, to);
      },
    });
    expect(result.ok).toBe(false);
    await expect(fs.lstat(f.firstOutput)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("old-second");
  });

  it("preserves backup paths when restoration itself fails", async () => {
    const f = await fixture();
    let renameCount = 0;
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async rename(from, to) {
        renameCount += 1;
        if (renameCount === 4 || String(from).endsWith("backup")) {
          throw new Error("simulated rename failure");
        }
        await fs.rename(from, to);
      },
    });
    expect(result.failure?.message).toContain("rollback was incomplete");
    expect(result.failure?.recoveryPaths.length).toBeGreaterThan(0);
    for (const path of result.failure?.recoveryPaths ?? []) {
      expect((await fs.lstat(path)).isDirectory()).toBe(true);
    }
  });

  it("removes the current transaction directory when payload copying fails", async () => {
    const f = await fixture();
    const result = await commitStagedOutputs(f.entries, {
      ...fs,
      async cp(_source, destination) {
        const destinationPath = String(destination);
        await fs.mkdir(destinationPath, { recursive: true });
        await fs.writeFile(join(destinationPath, "partial"), "partial", "utf8");
        throw new Error("simulated copy failure");
      },
    });
    expect(result).toMatchObject({ ok: false, failure: { failedKey: "first" } });
    const siblings = await fs.readdir(join(f.root, "out"));
    expect(siblings.filter((name) => name.startsWith(".hooknostic-"))).toEqual([]);
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("old-first");
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("old-second");
  });

  it("rejects a non-file report destination before replacing any output", async () => {
    const f = await fixtureWithReport(false);
    await fs.mkdir(f.reportOutput);
    const result = await commitStagedOutputs(f.entries);
    expect(result).toMatchObject({
      ok: false,
      failure: { failedKey: "build-report", recoveryPaths: [] },
    });
    expect(await fs.readFile(join(f.firstOutput, "value"), "utf8")).toBe("old-first");
    expect(await fs.readFile(join(f.secondOutput, "value"), "utf8")).toBe("old-second");
    expect((await fs.lstat(f.reportOutput)).isDirectory()).toBe(true);
  });
});
