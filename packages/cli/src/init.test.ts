import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runCli } from "./cli.js";
import { runInit } from "./init.js";
import { defaultAdapterRegistry } from "./registry.js";
it("initializes only missing source scaffolding without overwriting or activating", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-init-"));
  const output: string[] = [];
  const io = { stdout: (text: string) => output.push(text), stderr: (text: string) => output.push(text) };
  try {
    const config = join(root, "hooknostic.config.ts");
    expect(await runInit(config, defaultAdapterRegistry(), io, true)).toBe(0);
    expect(JSON.parse(output[0]!).created).toHaveLength(2);
    expect((await readdir(root)).sort()).toEqual(["hooknostic.config.ts", "hooks.ts"]);
    await writeFile(config, "author config");
    await writeFile(join(root, "hooks.ts"), "author hooks");
    expect(await runInit(config, defaultAdapterRegistry(), io, true)).toBe(0);
    expect(JSON.parse(output[1]!).created).toEqual([]);
    expect(await readFile(config, "utf8")).toBe("author config");
    expect(await readFile(join(root, "hooks.ts"), "utf8")).toBe("author hooks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A path init cannot create is the user's mistake: a plain message and exit
// 2, not the catch-all's "unexpected error" with a stack (#208).
it.each([
  // mkdir under a file.
  ["a directory under a file", ["afile", "sub"], "ENOTDIR"],
  // mkdir of the file itself: its EEXIST is not "already there".
  ["a directory that is a file", ["afile"], "EEXIST"],
])("reports a config path whose parent is %s", async (_, parent, code) => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-init-"));
  try {
    await writeFile(join(root, "afile"), "x");
    const config = join(root, ...parent, "hooknostic.config.ts");

    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
    expect(await runCli(["init", "--local", "--config", config], { io })).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(new RegExp(`^init failed: cannot create ${literal(config)}: ${code}: `));
    expect(err[0]).not.toContain("unexpected error");
    expect(err[0]).not.toMatch(/^\s+at /m);

    const json: string[] = [];
    const jsonIO = { stdout: (text: string) => json.push(text), stderr: (text: string) => json.push(text) };
    expect(await runCli(["init", "--local", "--config", config, "--json"], { io: jsonIO })).toBe(2);
    expect(json).toHaveLength(1);
    const report = JSON.parse(json[0]!);
    expect(report).toStrictEqual({
      schemaVersion: 1,
      command: "init",
      ok: false,
      created: [],
      errors: [expect.stringMatching(new RegExp(`^init failed: cannot create ${literal(config)}: ${code}: `))],
    });
    expect((await readdir(root)).sort()).toEqual(["afile"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
