import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { applyProject, type ProjectIntegration, reconcileProject } from "./project-files.js";

let root: string;
const owner = "hooknostic.config.ts";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hooknostic-conflicts-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const integration = (paths: string[]): ProjectIntegration => ({
  files: paths.map((path) => ({ path, contents: "generated\n" })),
  entries: [{ path: "settings.json", key: ["enabled"], kind: "property", value: true }],
  guidance: [],
});

it("reports every identical unowned file once, in path order, without writing", async () => {
  const desired = integration(["z.txt", "a.txt", "z.txt"]);
  for (const path of ["z.txt", "a.txt"]) await writeFile(join(root, path), "generated\n");

  const error = await reconcileProject(root, owner, desired).catch((error: unknown) => error);
  expect(error).toMatchObject({ name: "GeneratedFileConflictError", paths: ["a.txt", "z.txt"] });
  expect((error as Error).message).toContain("unowned or modified generated file: a.txt");
  expect((error as Error).message).toContain("unowned or modified generated file: z.txt");
  for (const path of ["z.txt", "a.txt"]) expect(await readFile(join(root, path), "utf8")).toBe("generated\n");
  for (const path of ["settings.json", ".hooknostic/integration.json"])
    await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports modified retained and obsolete files together before structural reconciliation", async () => {
  await applyProject(root, owner, await reconcileProject(root, owner, integration(["z.txt", "a.txt", "keep.txt"])));
  const manifest = await readFile(join(root, ".hooknostic/integration.json"));
  for (const path of ["z.txt", "a.txt"]) await writeFile(join(root, path), "authored\n");
  // An earlier-sorting structural conflict must not hide generated-file conflicts.
  await writeFile(join(root, "settings.json"), '{"enabled":false}\n');

  await expect(reconcileProject(root, owner, integration(["z.txt", "keep.txt", "new.txt"]))).rejects.toMatchObject({
    name: "GeneratedFileConflictError",
    paths: ["a.txt", "z.txt"],
  });
  for (const path of ["z.txt", "a.txt"]) expect(await readFile(join(root, path), "utf8")).toBe("authored\n");
  expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("generated\n");
  expect(await readFile(join(root, "settings.json"), "utf8")).toBe('{"enabled":false}\n');
  expect(await readFile(join(root, ".hooknostic/integration.json"))).toEqual(manifest);
  await expect(readFile(join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")("aggregates owned mode conflicts alongside content conflicts", async () => {
  const desired = integration(["z-mode.txt", "a-mode.txt", "content.txt"]);
  await applyProject(root, owner, await reconcileProject(root, owner, desired));
  for (const path of ["z-mode.txt", "a-mode.txt"]) await chmod(join(root, path), 0o755);
  await writeFile(join(root, "content.txt"), "authored\n");
  const manifest = await readFile(join(root, ".hooknostic/integration.json"));

  await expect(reconcileProject(root, owner, integration(["z-mode.txt", "content.txt"]))).rejects.toMatchObject({
    name: "GeneratedFileConflictError",
    paths: ["a-mode.txt", "content.txt", "z-mode.txt"],
  });
  for (const path of ["z-mode.txt", "a-mode.txt"]) expect((await stat(join(root, path))).mode & 0o777).toBe(0o755);
  expect(await readFile(join(root, "content.txt"), "utf8")).toBe("authored\n");
  expect(await readFile(join(root, ".hooknostic/integration.json"))).toEqual(manifest);
});
