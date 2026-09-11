import type * as fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProject, reconcileProject, recoverProject } from "./project-files.js";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let root: string;
const owner = "config.ts";
const input = (value: string) => ({ files: [{ path: "a.txt", contents: value }, { path: "z.txt", contents: value }], entries: [], guidance: [] });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hooknostic-recovery-")); });
afterEach(async () => { vi.mocked(rename).mockReset(); vi.mocked(rename).mockImplementation((await vi.importActual<typeof fs>("node:fs/promises")).rename); await rm(root, { recursive: true, force: true }); });
it("rolls back an ordinary replacement failure", async () => {
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith("z.txt")) throw new Error("injected replacement failure");
    return actual(from, to);
  });
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("new")))).rejects.toThrow("injected");
  await expect(readFile(join(root, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, ".hooknostic/integration.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains a recoverable journal when rollback itself fails", async () => {
  await applyProject(root, owner, await reconcileProject(root, owner, input("before")));
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  let failed = false;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith("z.txt")) { failed = true; throw new Error("injected commit failure"); }
    if (failed && String(to).endsWith("a.txt")) throw new Error("injected rollback failure");
    return actual(from, to);
  });
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("after")))).rejects.toThrow("rollback");
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
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("new")))).rejects.toThrow("recovery conflict");
  expect(await readFile(join(root, "z.txt"), "utf8")).toBe("external");
  expect(await readFile(join(root, ".hooknostic/transaction.json"), "utf8")).toContain('"schemaVersion":1');
});
