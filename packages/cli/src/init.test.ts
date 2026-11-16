import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

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
    expect(JSON.parse(output[1]!)).toMatchObject({
      ok: true,
      created: [],
      unchanged: [config, join(root, "hooks.ts")],
    });
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
      unchanged: [],
      errors: [expect.stringMatching(new RegExp(`^init failed: cannot create ${literal(config)}: ${code}: `))],
    });
    expect((await readdir(root)).sort()).toEqual(["afile"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const NEXT_STEP = "Install Hooknostic and its SDK with your package manager, then run hooknostic sync.";

async function project(): Promise<{ root: string; proj: string }> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-init-"));
  const proj = join(root, "proj");
  await mkdir(proj);
  return { root, proj };
}

// Every file and directory under root with its contents, so a test can see
// a write anywhere, including beside proj.
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${path}${sep}`] = "dir";
        await visit(path);
      } else out[path] = await readFile(path, "utf8");
    }
  };
  await visit(root);
  return out;
}

async function init(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
  const code = await runCli(["init", "--local", ...args], { io });
  return { code, out, err };
}

describe("files that already exist (#217)", () => {
  it("lists both as unchanged and writes nothing when both exist", async () => {
    const { root, proj } = await project();
    try {
      const config = join(proj, "hooknostic.config.ts");
      const hooks = join(proj, "hooks.ts");
      await writeFile(config, "author config");
      await writeFile(hooks, "author hooks");
      const before = await snapshot(root);

      const text = await init(["--config", config]);
      expect(text.code).toBe(0);
      expect(text.err).toEqual([]);
      expect(text.out).toEqual([
        ["Created no files.", "Left 2 existing files unchanged:", `  ${config}`, `  ${hooks}`, NEXT_STEP].join("\n"),
      ]);

      const json = await init(["--config", config, "--json"]);
      expect(json.code).toBe(0);
      expect(json.err).toEqual([]);
      expect(json.out).toHaveLength(1);
      expect(JSON.parse(json.out[0]!)).toStrictEqual({
        schemaVersion: 1,
        command: "init",
        ok: true,
        created: [],
        unchanged: [config, hooks],
      });
      expect(await snapshot(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["the config", "hooknostic.config.ts"],
    ["hooks.ts", "hooks.ts"],
  ])("creates the other file when only %s exists", async (_, existing) => {
    const { root, proj } = await project();
    try {
      const config = join(proj, "hooknostic.config.ts");
      const hooks = join(proj, "hooks.ts");
      const kept = join(proj, existing);
      const made = kept === config ? hooks : config;

      await writeFile(kept, "author file");
      const text = await init(["--config", config]);
      expect(text.code).toBe(0);
      expect(text.err).toEqual([]);
      expect(text.out).toEqual([
        ["Created 1 file:", `  ${made}`, "Left 1 existing file unchanged:", `  ${kept}`, NEXT_STEP].join("\n"),
      ]);
      expect(await readFile(kept, "utf8")).toBe("author file");
      expect((await readdir(proj)).sort()).toEqual(["hooknostic.config.ts", "hooks.ts"]);

      await rm(made);
      const json = await init(["--config", config, "--json"]);
      expect(json.code).toBe(0);
      expect(json.err).toEqual([]);
      expect(json.out).toHaveLength(1);
      expect(JSON.parse(json.out[0]!)).toStrictEqual({
        schemaVersion: 1,
        command: "init",
        ok: true,
        created: [made],
        unchanged: [kept],
      });
      expect(await readFile(kept, "utf8")).toBe("author file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an existing file named by --config unchanged, without reading it", async () => {
    const { root, proj } = await project();
    try {
      const readme = join(proj, "README.md");
      const hooks = join(proj, "hooks.ts");
      await writeFile(readme, "readme");

      const json = await init(["--config", readme, "--json"]);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out[0]!)).toStrictEqual({
        schemaVersion: 1,
        command: "init",
        ok: true,
        created: [hooks],
        unchanged: [readme],
      });
      expect(await readFile(readme, "utf8")).toBe("readme");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["hooknostic.config.ts", "my.config.ts"])(
    "creates both files on a fresh path with --config %s",
    async (name) => {
      const { root, proj } = await project();
      try {
        const config = join(proj, name);
        const hooks = join(proj, "hooks.ts");

        const text = await init(["--config", config]);
        expect(text.code).toBe(0);
        expect(text.err).toEqual([]);
        expect(text.out).toEqual([["Created 2 files:", `  ${config}`, `  ${hooks}`, NEXT_STEP].join("\n")]);

        await rm(config);
        await rm(hooks);
        const json = await init(["--config", config, "--json"]);
        expect(json.code).toBe(0);
        expect(json.out).toHaveLength(1);
        expect(JSON.parse(json.out[0]!)).toStrictEqual({
          schemaVersion: 1,
          command: "init",
          ok: true,
          created: [config, hooks],
          unchanged: [],
        });
        expect((await readdir(proj)).sort()).toEqual(["hooks.ts", name].sort());
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

// Runs init in text and JSON mode from cwd, expecting exit 2 with message
// and nothing written anywhere under root.
async function expectRefused(root: string, cwd: string, args: string[], message: string) {
  const before = await snapshot(root);
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const text = await init(args);
    expect(text.code).toBe(2);
    expect(text.out).toEqual([]);
    expect(text.err).toEqual([message]);

    const json = await init([...args, "--json"]);
    expect(json.code).toBe(2);
    expect(json.err).toEqual([]);
    expect(json.out).toHaveLength(1);
    expect(JSON.parse(json.out[0]!)).toStrictEqual({
      schemaVersion: 1,
      command: "init",
      ok: false,
      created: [],
      unchanged: [],
      errors: [message],
    });
  } finally {
    process.chdir(previous);
  }
  expect(await snapshot(root)).toEqual(before);
}

describe("--config naming hooks.ts (#217)", () => {
  const message = (config: string) =>
    `init failed: --config ${config} is where init writes hooks.ts; name the configuration file something else`;

  it.each([
    ["on a fresh path", undefined],
    ["when the file already exists", "author hooks"],
  ])("fails with 2 and writes nothing %s", async (_, existing) => {
    const { root, proj } = await project();
    try {
      const hooks = join(proj, "hooks.ts");
      if (existing !== undefined) await writeFile(hooks, existing);
      await expectRefused(root, proj, ["--config", "hooks.ts"], message(hooks));
      await expectRefused(root, proj, ["--config", hooks], message(hooks));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // These file systems ignore case by default, so HOOKS.TS is hooks.ts.
  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "fails with 2 and writes nothing when the name differs only in case",
    async () => {
      const { root, proj } = await project();
      try {
        const config = join(proj, "HOOKS.TS");
        await expectRefused(root, proj, ["--config", config], message(config));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("a target that is a directory (#217)", () => {
  const hint = (dir: string) =>
    `init failed: cannot create ${dir}: it is a directory; --config names the configuration file, such as ${join(dir, "hooknostic.config.ts")}`;
  const noNesting = (dir: string) =>
    `init failed: cannot create ${dir}: it is a directory; --config names the configuration file, not a directory`;

  // Each case: the directory to make under proj ("" for proj itself), the
  // init arguments, and the expected message. init runs with proj as cwd.
  it.each<[string, string, (dir: string) => string[], (dir: string) => string]>([
    ["--config names a directory", "cfgdir", (dir) => ["--config", dir], hint],
    ["--config names a directory with a trailing separator", "cfgdir", (dir) => ["--config", dir + sep], hint],
    ["--config is .", "", () => ["--config", "."], hint],
    ['--config is ""', "", () => ["--config", ""], hint],
    [
      "--config names a directory called hooknostic.config.ts",
      "hooknostic.config.ts",
      (dir) => ["--config", dir],
      noNesting,
    ],
    ["--config names a directory called my.config.ts", "my.config.ts", (dir) => ["--config", dir], noNesting],
    [
      "the default config path is a directory and --config was not given",
      "hooknostic.config.ts",
      () => [],
      (dir) => `init failed: cannot create ${dir}: it is a directory`,
    ],
  ])("fails with 2 and writes nothing when %s", async (_, name, args, message) => {
    const { root, proj } = await project();
    try {
      const dir = join(proj, name);
      if (name) await mkdir(dir);
      await expectRefused(root, proj, args(dir), message(dir));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails with 2 and writes no config when hooks.ts is a directory", async () => {
    const { root, proj } = await project();
    try {
      const config = join(proj, "hooknostic.config.ts");
      const hooks = join(proj, "hooks.ts");
      await mkdir(hooks);
      const before = await snapshot(root);
      const message = `init failed: cannot create ${hooks}: it is a directory`;

      const text = await init(["--config", config]);
      expect(text.code).toBe(2);
      expect(text.out).toEqual([]);
      expect(text.err).toEqual([message]);

      const json = await init(["--config", config, "--json"]);
      expect(json.code).toBe(2);
      expect(JSON.parse(json.out[0]!)).toStrictEqual({
        schemaVersion: 1,
        command: "init",
        ok: false,
        created: [],
        unchanged: [],
        errors: [message],
      });
      expect(await snapshot(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
