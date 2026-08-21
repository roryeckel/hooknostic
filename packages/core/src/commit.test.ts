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

describe("commitStagedOutputs", () => {
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
});
