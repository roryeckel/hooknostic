import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { applyProject, fileHash, reconcileProject, recoverProject } from "./project-files.js";

// A project on a filesystem that keeps no permission bits, such as WSL's DrvFs
// mount of a Windows drive without `metadata` (#248): every file reads 0777
// whatever was written. file-modes.test.ts covers how such a mount is found.
vi.mock("./file-modes.js", () => ({ recordsFileModes: vi.fn(async () => false) }));

let root: string;
const owner = "config.ts";
const desired = (a = "same") => ({
  files: [
    { path: "a.txt", contents: a, mode: 0o644 },
    { path: "b.sh", contents: "same", mode: 0o755 },
  ],
  entries: [],
  guidance: [],
});
async function syncThenReadEverythingAs0777(): Promise<void> {
  await applyProject(root, owner, await reconcileProject(root, owner, desired()));
  for (const path of ["a.txt", "b.sh", ".hooknostic/integration.json"]) await chmod(join(root, path), 0o777);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hooknostic-file-modes-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("plans nothing after a sync where modes are not kept", async () => {
  await syncThenReadEverythingAs0777();

  const plan = await reconcileProject(root, owner, desired());

  expect(plan.changes.map((change) => change.path)).toEqual([]);
});

it("still detects a content change where modes are not kept", async () => {
  await syncThenReadEverythingAs0777();
  await writeFile(join(root, "a.txt"), "samf");

  await expect(reconcileProject(root, owner, desired())).rejects.toThrow(
    /^unowned or modified generated file: a\.txt$/,
  );
});

it("recovers an interrupted sync where modes are not kept", async () => {
  await mkdir(join(root, ".hooknostic"));
  await writeFile(join(root, "a.txt"), "after");
  await chmod(join(root, "a.txt"), 0o777);
  await writeFile(
    join(root, ".hooknostic/transaction.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: owner,
      entries: [
        {
          path: "a.txt",
          before: Buffer.from("before").toString("base64"),
          afterHash: fileHash("after"),
          mode: 0o644,
          beforeMode: 0o644,
        },
      ],
    }),
  );

  await recoverProject(root, owner);

  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
  await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
