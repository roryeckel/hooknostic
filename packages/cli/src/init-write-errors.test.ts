import type * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";

const initFs = vi.hoisted(() => ({
  failOpen: undefined as string | undefined,
  failWrite: undefined as string | undefined,
  hideFromStat: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    async stat(...args: Parameters<typeof actual.stat>) {
      // As if the file appeared between init's check and its open.
      if (initFs.hideFromStat !== undefined && basename(String(args[0])) === initFs.hideFromStat) {
        throw Object.assign(new Error("synthetic stat miss"), { code: "ENOENT" });
      }
      return await actual.stat(...args);
    },
    async open(...args: Parameters<typeof actual.open>) {
      const path = String(args[0]);
      if (initFs.failOpen !== undefined && basename(path) === initFs.failOpen) {
        throw Object.assign(new Error("synthetic open failure"), { code: "EACCES" });
      }
      const handle = await actual.open(...args);
      if (initFs.failWrite !== undefined && basename(path) === initFs.failWrite) {
        // Write part of the file first, as a real failure might.
        handle.writeFile = async (data: Parameters<typeof handle.writeFile>[0]) => {
          await actual.writeFile(path, String(data).slice(0, 10));
          throw Object.assign(new Error("synthetic write failure"), { code: "ENOSPC" });
        };
      }
      return handle;
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  initFs.failOpen = undefined;
  initFs.failWrite = undefined;
  initFs.hideFromStat = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-init-write-errors-"));
  roots.push(root);
  const proj = join(root, "proj");
  await mkdir(proj);
  return proj;
}

async function init(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
  const code = await runCli(["init", "--local", ...args], { io });
  return { code, out, err };
}

// The config's contents do not depend on where it is written.
async function freshConfig(): Promise<string> {
  const proj = await project();
  expect((await init(["--config", join(proj, "hooknostic.config.ts")])).code).toBe(0);
  return await readFile(join(proj, "hooknostic.config.ts"), "utf8");
}

describe("a write that fails part-way (#217)", () => {
  it("keeps a file created earlier in the run and lists it when a later open fails", async () => {
    const expected = await freshConfig();
    initFs.failOpen = "hooks.ts";

    for (const json of [false, true]) {
      const proj = await project();
      const config = join(proj, "hooknostic.config.ts");
      const message = `init failed: cannot create ${join(proj, "hooks.ts")}: synthetic open failure`;

      const result = await init(["--config", config, ...(json ? ["--json"] : [])]);
      expect(result.code).toBe(2);
      if (json) {
        expect(result.err).toEqual([]);
        expect(JSON.parse(result.out[0]!)).toStrictEqual({
          schemaVersion: 1,
          command: "init",
          ok: false,
          created: [config],
          unchanged: [],
          errors: [message],
        });
      } else {
        expect(result.out).toEqual([]);
        expect(result.err).toEqual([[message, "Created before the failure, left in place:", `  ${config}`].join("\n")]);
      }
      expect(await readdir(proj)).toEqual(["hooknostic.config.ts"]);
      expect(await readFile(config, "utf8")).toBe(expected);
    }
  });

  it("removes the file whose write failed, since it may be truncated", async () => {
    initFs.failWrite = "hooknostic.config.ts";

    for (const json of [false, true]) {
      const proj = await project();
      const config = join(proj, "hooknostic.config.ts");
      const message = `init failed: cannot create ${config}: synthetic write failure`;

      const result = await init(["--config", config, ...(json ? ["--json"] : [])]);
      expect(result.code).toBe(2);
      if (json) {
        expect(result.err).toEqual([]);
        expect(JSON.parse(result.out[0]!)).toStrictEqual({
          schemaVersion: 1,
          command: "init",
          ok: false,
          created: [],
          unchanged: [],
          errors: [message],
        });
      } else {
        expect(result.out).toEqual([]);
        expect(result.err).toEqual([message]);
      }
      expect(await readdir(proj)).toEqual([]);
    }
  });

  it("lists a target that already existed as unchanged, though the loop never reached it", async () => {
    initFs.failWrite = "hooknostic.config.ts";

    for (const json of [false, true]) {
      const proj = await project();
      const config = join(proj, "hooknostic.config.ts");
      const hooks = join(proj, "hooks.ts");
      await writeFile(hooks, "author hooks");
      const message = `init failed: cannot create ${config}: synthetic write failure`;

      const result = await init(["--config", config, ...(json ? ["--json"] : [])]);
      expect(result.code).toBe(2);
      if (json) {
        expect(result.err).toEqual([]);
        expect(JSON.parse(result.out[0]!)).toStrictEqual({
          schemaVersion: 1,
          command: "init",
          ok: false,
          created: [],
          unchanged: [hooks],
          errors: [message],
        });
      } else {
        expect(result.out).toEqual([]);
        expect(result.err).toEqual([message]);
      }
      expect(await readdir(proj)).toEqual(["hooks.ts"]);
      expect(await readFile(hooks, "utf8")).toBe("author hooks");
    }
  });
});

describe("a file that appears after the check (#217)", () => {
  it("keeps the config first in unchanged when the config is the one that appeared", async () => {
    initFs.hideFromStat = "hooknostic.config.ts";

    for (const json of [false, true]) {
      const proj = await project();
      const config = join(proj, "hooknostic.config.ts");
      const hooks = join(proj, "hooks.ts");
      await writeFile(config, "author config");
      await writeFile(hooks, "author hooks");

      const result = await init(["--config", config, ...(json ? ["--json"] : [])]);
      expect(result.code).toBe(0);
      expect(result.err).toEqual([]);
      if (json) {
        expect(JSON.parse(result.out[0]!)).toStrictEqual({
          schemaVersion: 1,
          command: "init",
          ok: true,
          created: [],
          unchanged: [config, hooks],
        });
      } else {
        expect(result.out).toEqual([
          [
            "Created no files.",
            "Left 2 existing files unchanged:",
            `  ${config}`,
            `  ${hooks}`,
            "Install Hooknostic and its SDK with your package manager, then run hooknostic sync.",
          ].join("\n"),
        ]);
      }
      expect(await readFile(config, "utf8")).toBe("author config");
    }
  });

  it("is left unchanged, not overwritten", async () => {
    initFs.hideFromStat = "hooks.ts";

    for (const json of [false, true]) {
      const proj = await project();
      const config = join(proj, "hooknostic.config.ts");
      const hooks = join(proj, "hooks.ts");
      await writeFile(hooks, "author hooks");

      const result = await init(["--config", config, ...(json ? ["--json"] : [])]);
      expect(result.code).toBe(0);
      expect(result.err).toEqual([]);
      if (json) {
        expect(JSON.parse(result.out[0]!)).toStrictEqual({
          schemaVersion: 1,
          command: "init",
          ok: true,
          created: [config],
          unchanged: [hooks],
        });
      } else {
        expect(result.out).toEqual([
          [
            "Created 1 file:",
            `  ${config}`,
            "Left 1 existing file unchanged:",
            `  ${hooks}`,
            "Install Hooknostic and its SDK with your package manager, then run hooknostic sync.",
          ].join("\n"),
        ]);
      }
      expect(await readFile(hooks, "utf8")).toBe("author hooks");
    }
  });
});
