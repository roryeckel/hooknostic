import type * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { applyProject, fileHash, reconcileProject, recoverProject } from "./project-files.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let root: string;
const owner = "config.ts";
const input = (value: string) => ({
  files: [
    { path: "a.txt", contents: value },
    { path: "z.txt", contents: value },
  ],
  entries: [],
  guidance: [],
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hooknostic-recovery-"));
});
afterEach(async () => {
  vi.mocked(rename).mockReset();
  vi.mocked(rename).mockImplementation((await vi.importActual<typeof fs>("node:fs/promises")).rename);
  await rm(root, { recursive: true, force: true });
});
it("rolls back an ordinary replacement failure", async () => {
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith("z.txt")) throw new Error("injected replacement failure");
    return actual(from, to);
  });
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("new")))).rejects.toThrow(
    "injected",
  );
  await expect(readFile(join(root, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, ".hooknostic/integration.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains a recoverable journal when rollback itself fails", async () => {
  await applyProject(root, owner, await reconcileProject(root, owner, input("before")));
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  let failed = false;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith("z.txt")) {
      failed = true;
      throw new Error("injected commit failure");
    }
    if (failed && String(to).endsWith("a.txt")) throw new Error("injected rollback failure");
    return actual(from, to);
  });
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("after")))).rejects.toThrow(
    "rollback",
  );
  expect(await readFile(join(root, ".hooknostic/transaction.json"), "utf8")).toContain('"before"');
  vi.mocked(rename).mockImplementation(actual);
  await recoverProject(root, owner);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
});
it("rechecks external edits immediately before a replacement", async () => {
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    await actual(from, to);
    if (String(to).endsWith("a.txt")) await writeFile(join(root, "z.txt"), "external");
  });
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("new")))).rejects.toThrow(
    "recovery conflict",
  );
  expect(await readFile(join(root, "z.txt"), "utf8")).toBe("external");
  expect(await readFile(join(root, ".hooknostic/transaction.json"), "utf8")).toContain('"schemaVersion":1');
});
it.skipIf(process.platform === "win32")("applies the requested mode despite a restrictive umask", async () => {
  const previousUmask = process.umask(0o077);
  try {
    await applyProject(
      root,
      owner,
      await reconcileProject(root, owner, {
        files: [{ path: "a.txt", contents: "generated", mode: 0o644 }],
        entries: [],
        guidance: [],
      }),
    );
  } finally {
    process.umask(previousUmask);
  }

  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
  await expect(
    reconcileProject(root, owner, {
      files: [{ path: "a.txt", contents: "generated", mode: 0o644 }],
      entries: [],
      guidance: [],
    }),
  ).resolves.toMatchObject({ changes: [] });
});
it.skipIf(process.platform === "win32")("accepts a checkout whose permission bits follow its umask", async () => {
  // Git checks committed 0644 and 0755 files out as 0666 and 0777 less the
  // umask: 0666 under umask 000, 0700 under umask 077.
  const desired = {
    files: [
      { path: "a.txt", contents: "same", mode: 0o644 },
      { path: "b.sh", contents: "same", mode: 0o755 },
    ],
    entries: [],
    guidance: [],
  };
  await applyProject(root, owner, await reconcileProject(root, owner, desired));
  await chmod(join(root, "a.txt"), 0o666);
  await chmod(join(root, "b.sh"), 0o700);
  await chmod(join(root, ".hooknostic/integration.json"), 0o664);

  await expect(reconcileProject(root, owner, desired)).resolves.toMatchObject({ changes: [] });
});
it.skipIf(process.platform === "win32").each([
  { mode: 0o644, observed: 0o744, name: "0644 as 0744" },
  { mode: 0o644, observed: 0o645, name: "0644 as 0645" },
  { mode: 0o755, observed: 0o655, name: "0755 as 0655" },
])("rejects an execute change a checkout cannot produce ($name)", async ({ mode, observed }) => {
  const desired = { files: [{ path: "a.txt", contents: "same", mode }], entries: [], guidance: [] };
  await applyProject(root, owner, await reconcileProject(root, owner, desired));
  await chmod(join(root, "a.txt"), observed);

  await expect(reconcileProject(root, owner, desired)).rejects.toThrow("unowned or modified generated file: a.txt");
});
it.skipIf(process.platform === "win32")("applies a newly requested non-execute mode exactly", async () => {
  const desired = (mode: number) => ({ files: [{ path: "a.txt", contents: "same", mode }], entries: [], guidance: [] });
  await applyProject(root, owner, await reconcileProject(root, owner, desired(0o644)));
  await chmod(join(root, "a.txt"), 0o666);

  await applyProject(root, owner, await reconcileProject(root, owner, desired(0o600)));

  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o600);
  await expect(reconcileProject(root, owner, desired(0o600))).resolves.toMatchObject({ changes: [] });

  await applyProject(root, owner, await reconcileProject(root, owner, desired(0o644)));
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
});
it.skipIf(process.platform === "win32")("rejects a checkout that loosened a restrictive mode", async () => {
  // Git cannot record 0600, so a fresh checkout under umask 022 yields 0644.
  const desired = { files: [{ path: "a.txt", contents: "same", mode: 0o600 }], entries: [], guidance: [] };
  await applyProject(root, owner, await reconcileProject(root, owner, desired));
  await chmod(join(root, "a.txt"), 0o644);

  await expect(reconcileProject(root, owner, desired)).rejects.toThrow("unowned or modified generated file: a.txt");
});
it.skipIf(process.platform === "win32")("rolls back a mode-only replacement after a later failure", async () => {
  const modes = (mode: number) => ({
    files: [
      { path: "a.txt", contents: "same", mode },
      { path: "z.txt", contents: "same", mode },
    ],
    entries: [],
    guidance: [],
  });
  await applyProject(root, owner, await reconcileProject(root, owner, modes(0o644)));
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith("z.txt")) throw new Error("injected replacement failure");
    return actual(from, to);
  });

  await expect(applyProject(root, owner, await reconcileProject(root, owner, modes(0o755)))).rejects.toThrow(
    "injected",
  );
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
  await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.skipIf(process.platform === "win32")("recovers a mode-only committed state from its journal", async () => {
  await mkdir(join(root, ".hooknostic"));
  await writeFile(join(root, "a.txt"), "same");
  await chmod(join(root, "a.txt"), 0o755);
  await writeFile(
    join(root, ".hooknostic/transaction.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: owner,
      entries: [
        {
          path: "a.txt",
          before: Buffer.from("same").toString("base64"),
          afterHash: fileHash("same"),
          mode: 0o755,
          beforeMode: 0o644,
        },
      ],
    }),
  );

  await recoverProject(root, owner);
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
});
it.skipIf(process.platform === "win32")("rejects a concurrent chmod without overwriting it", async () => {
  const desired = (mode: number) => ({ files: [{ path: "a.txt", contents: "same", mode }], entries: [], guidance: [] });
  await applyProject(root, owner, await reconcileProject(root, owner, desired(0o644)));
  const plan = await reconcileProject(root, owner, desired(0o755));
  await chmod(join(root, "a.txt"), 0o700);

  await expect(applyProject(root, owner, plan)).rejects.toThrow("changed during planning");
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o700);
});
it.skipIf(process.platform === "win32")("records the ownership manifest preimage mode", async () => {
  await applyProject(root, owner, await reconcileProject(root, owner, input("before")));
  const manifest = join(root, ".hooknostic/integration.json");
  await chmod(manifest, 0o600);
  const plan = await reconcileProject(root, owner, input("after"));

  expect(plan.changes.find((change) => change.path === ".hooknostic/integration.json")?.beforeMode).toBe(0o600);
});
