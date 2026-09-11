import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { CapabilityProfile, HarnessAdapter } from "@hooknostic/core";
import { buildProject } from "@hooknostic/core";
import type { FakeAdapterOptions } from "@hooknostic/testkit";
import { makeFakeAdapter } from "@hooknostic/testkit";
import { runBuild } from "./build.js";
import { runCli } from "./cli.js";

// Synthetic profiles need a syntactically valid source; provenance is
// meaningless for a fake harness, so one shared stub keeps the noise down.
const SRC: CapabilityProfile["source"] = {
  date: "2026-01-01",
  validatedOn: [
    { version: "1.0.0", date: "2026-01-01", method: "doc-derived", what: "synthetic" },
  ],
};

const SDK_PATH = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../sdk/src/index.ts");
const EVALUATE = { alias: { "@hooknostic/sdk": SDK_PATH } };

const PROFILE: CapabilityProfile = {
  range: ">=1.0 <2",
  source: SRC,
  matrix: { "session.start.observe": { level: "exact" } },
};

/** A fake that reaches emission: an empty shim is enough to bundle and stage. */
function fake(overrides: Partial<FakeAdapterOptions> = {}): HarnessAdapter {
  return makeFakeAdapter({ id: "fake", profiles: [PROFILE], shimEntry: "export {};", ...overrides });
}

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

const temp: string[] = [];
afterAll(async () => {
  await Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-pipeline-"));
  temp.push(dir);
  await writeFile(
    join(dir, "hooknostic.config.ts"),
    `export default {
      entry: "./hooks.ts",
      targets: { fake: { version: ">=1.0 <2", delivery: "package", output: "./dist/fake" } },
    };`,
    "utf8",
  );
  await writeFile(
    join(dir, "hooks.ts"),
    `import { definePlugin, hook } from "@hooknostic/sdk";
     export default definePlugin({ name: "p", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    "utf8",
  );
  return dir;
}

function build(dir: string, adapter: HarnessAdapter) {
  return buildProject({
    configPath: join(dir, "hooknostic.config.ts"),
    registry: { fake: adapter },
    evaluate: EVALUATE,
  });
}

async function stagingLeftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((entry) => entry.startsWith(".hooknostic-staging-"));
}

/** A shim that actually imports the entry, as every real adapter's does. */
const importsEntry = (options: { entryImportPath: string }) =>
  `import plugin from ${JSON.stringify(options.entryImportPath)};\nexport default plugin;`;

/**
 * Hook source whose CLI main-module guard is dormant where it was written but
 * unconditionally true once bundled, because both sides then name the
 * generated artifact.
 */
const mainGuardSource = `import { pathToFileURL } from "node:url";
   import { definePlugin, hook } from "@hooknostic/sdk";
   if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
     console.log("cli main");
   }
   export default definePlugin({ name: "p", hooks: [hook("session.start", { id: "s", async run() {} })] });`;

describe("build pipeline hardening", () => {
  it("rejects artifact paths that escape the output directory without writing anything", async () => {
    const dir = await project();
    const result = await build(
      dir,
      fake({
        compile: () => [
          { path: "../../escape.txt", contents: "outside" },
          { path: "ok.txt", contents: "inside" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.report.targets["fake"]?.status).toBe("failed");
    expect(result.report.diagnostics).toEqual([
      expect.objectContaining({
        code: "HN301",
        target: "fake",
        message: expect.stringContaining('"../../escape.txt"'),
      }),
    ]);
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(existsSync(join(dir, "hooknostic-build.json"))).toBe(false);
    expect(await stagingLeftovers(dir)).toEqual([]);
  });

  it("reports validator exceptions as HN301 in the JSON report instead of rejecting", async () => {
    const dir = await project();
    const { io, out } = captureIO();
    const code = await runBuild({
      config: join(dir, "hooknostic.config.ts"),
      json: true,
      registry: {
        fake: fake({
          validateArtifacts: () => {
            throw new Error("validator exploded");
          },
        }),
      },
      io,
      evaluate: EVALUATE,
    });
    expect(code).toBe(2);
    const report = JSON.parse(out());
    expect(report.targets.fake.status).toBe("failed");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "HN301",
        target: "fake",
        message: "artifact validation failed: validator exploded",
      }),
    ]);
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(await stagingLeftovers(dir)).toEqual([]);
  });

  it("reports staging write failures as HN301 instead of rejecting", async () => {
    const dir = await project();
    const result = await build(
      dir,
      fake({
        // Structural validation rejects everything it can see (path
        // conflicts, contents type, mode), so the write itself must be what
        // fails: a single path segment beyond the filesystem's name limit is
        // ENAMETOOLONG on every platform and is not a structural rule.
        compile: () => [{ path: `${"n".repeat(300)}.json`, contents: "file" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.report.diagnostics).toEqual([
      expect.objectContaining({
        code: "HN301",
        target: "fake",
        message: expect.stringContaining("artifact staging failed:"),
      }),
    ]);
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(await stagingLeftovers(dir)).toEqual([]);
  });

  it("rejects under a dry run what staging would reject, without writing", async () => {
    const dir = await project();
    const adapter = fake({
      compile: () => [
        { path: "hooks.json", contents: { hooks: [] } as unknown as string },
        { path: "a", contents: "file" },
        { path: "a/b", contents: "nested" },
      ],
    });
    const result = await buildProject({
      configPath: join(dir, "hooknostic.config.ts"),
      registry: { fake: adapter },
      evaluate: EVALUATE,
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    expect(result.report.targets["fake"]?.status).toBe("failed");
    expect(result.report.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('"hooks.json" with non-string, non-binary contents'),
      expect.stringContaining('"a" that is also a directory'),
    ]);
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(await stagingLeftovers(dir)).toEqual([]);
  });

  it("rejects under a dry run an existing output of the wrong kind, as the commit would", async () => {
    const dir = await project();
    // A regular file where the target directory goes, and a directory where
    // the build report goes: the commit refuses both, so check must too.
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist/fake"), "not a directory");
    await mkdir(join(dir, "hooknostic-build.json"), { recursive: true });
    const result = await buildProject({
      configPath: join(dir, "hooknostic.config.ts"),
      registry: { fake: fake() },
      evaluate: EVALUATE,
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    expect(result.report.targets["fake"]?.status).toBe("failed");
    expect(result.report.diagnostics.map((d) => [d.code, d.target, d.message])).toEqual([
      ["HN302", "fake", expect.stringContaining(`existing output ${join(dir, "dist/fake")} is not a regular directory`)],
      ["HN302", undefined, expect.stringContaining("hooknostic-build.json is not a regular file")],
    ]);
    expect(await readFile(join(dir, "dist/fake"), "utf8")).toBe("not a directory");
    expect(await stagingLeftovers(dir)).toEqual([]);
  });

  it("marks staged targets skipped when another target fails validation", async () => {
    const dir = await project();
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        targets: {
          fake: { version: ">=1.0 <2", delivery: "package", output: "./dist/fake" },
          other: { version: ">=1.0 <2", delivery: "package", output: "./dist/other" },
        },
      };`,
      "utf8",
    );
    const result = await buildProject({
      configPath: join(dir, "hooknostic.config.ts"),
      registry: {
        fake: fake({ compile: () => [{ path: "../escape", contents: "outside" }] }),
        other: fake({ id: "other" }),
      },
      evaluate: EVALUATE,
    });
    expect(result.ok).toBe(false);
    expect(result.report.targets.fake?.status).toBe("failed");
    expect(result.report.targets.other?.status).toBe("skipped");
    expect(existsSync(join(dir, "dist/other/fake-plugin.json"))).toBe(false);
    expect(existsSync(join(dir, "hooknostic-build.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "honors the executable flag on staged and committed artifacts",
    async () => {
      const dir = await project();
      const result = await build(
        dir,
        fake({
          compile: () => [
            { path: "bin/run.sh", contents: "#!/bin/sh\nexit 0\n", executable: true },
            { path: "data.txt", contents: "plain" },
          ],
        }),
      );
      expect(result.ok, JSON.stringify(result.report.diagnostics)).toBe(true);
      const executable = await stat(join(dir, "dist/fake/bin/run.sh"));
      const plain = await stat(join(dir, "dist/fake/data.txt"));
      expect(executable.mode & 0o111).not.toBe(0);
      expect(plain.mode & 0o111).toBe(0);
    },
  );

  it("commits artifacts and the report when the adapter behaves", async () => {
    const dir = await project();
    const result = await build(dir, fake());
    expect(result.ok, JSON.stringify(result.report.diagnostics)).toBe(true);
    expect(existsSync(join(dir, "dist/fake/fake-plugin.json"))).toBe(true);
    expect(existsSync(join(dir, "hooknostic-build.json"))).toBe(true);
    expect(await stagingLeftovers(dir)).toEqual([]);
    expect(result.report.diagnostics.filter((d) => d.code === "HN502")).toEqual([]);
  });

  it("warns once when the bundled hook source carries a CLI main-module guard", async () => {
    const dir = await project();
    // Two targets, to prove the sharp edge is reported once for the shared
    // import graph rather than once per bundle.
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        targets: {
          fake: { version: ">=1.0 <2", delivery: "package", output: "./dist/fake" },
          other: { version: ">=1.0 <2", delivery: "package", output: "./dist/other" },
        },
      };`,
      "utf8",
    );
    await writeFile(join(dir, "hooks.ts"), mainGuardSource, "utf8");
    const result = await buildProject({
      configPath: join(dir, "hooknostic.config.ts"),
      registry: {
        fake: fake({ shimEntry: importsEntry, shimExecution: "command" }),
        other: fake({ id: "other", shimEntry: importsEntry, shimExecution: "command" }),
      },
      evaluate: EVALUATE,
    });
    expect(result.ok, JSON.stringify(result.report.diagnostics)).toBe(true);
    const warnings = result.report.diagnostics.filter((d) => d.code === "HN502");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe("warn");
    expect(warnings[0]?.message).toContain("process.argv[1]");
    // Named so the reader knows which artifacts actually execute the guard.
    expect(warnings[0]?.message).toContain("fake, other");
  });

  it("stays silent when the harness imports the artifact instead of running it", async () => {
    const dir = await project();
    await writeFile(join(dir, "hooks.ts"), mainGuardSource, "utf8");
    // An in-process plugin keeps process.argv[1] pointed at the harness's own
    // entry, so the guard never becomes true and there is nothing to warn about.
    const result = await buildProject({
      configPath: join(dir, "hooknostic.config.ts"),
      registry: { fake: fake({ shimEntry: importsEntry, shimExecution: "module" }) },
      evaluate: EVALUATE,
    });
    expect(result.ok, JSON.stringify(result.report.diagnostics)).toBe(true);
    expect(result.report.diagnostics.filter((d) => d.code === "HN502")).toEqual([]);
  });
});

describe("CLI last-resort error handling", () => {
  it("reports unexpected adapter exceptions on stderr with exit 2 instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-crash-"));
    temp.push(dir);
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        targets: { fake: { version: ">=1.0 <2", delivery: "package", output: "./dist/fake" } },
      };`,
      "utf8",
    );
    // A plain plugin object: no SDK import, so no module resolution is needed.
    await writeFile(
      join(dir, "hooks.ts"),
      `export default { name: "p", hooks: [{ event: "session.start", id: "s", capabilities: {}, async run() {} }] };`,
      "utf8",
    );
    const exploding: HarnessAdapter = {
      ...fake(),
      capabilities() {
        throw new Error("capabilities exploded");
      },
    };
    const { io, err } = captureIO();
    const code = await runCli(["check", "--config", join(dir, "hooknostic.config.ts")], {
      registry: { fake: exploding },
      io,
    });
    expect(code).toBe(2);
    expect(err()).toContain("hooknostic: unexpected error");
    expect(err()).toContain("capabilities exploded");
  });
});
