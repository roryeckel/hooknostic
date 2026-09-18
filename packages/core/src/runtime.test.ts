import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  effectiveRuntimePackage,
  materializeRuntimes,
  runtimeSpellingProblem,
  validateRuntimeDeclarations,
} from "./runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** `uv` is the only tool a provider currently shells out to. */
function uvAvailable(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const UV = uvAvailable();

describe("effectiveRuntimePackage", () => {
  it("reads the npm runtime from either spelling", () => {
    const shorthand = effectiveRuntimePackage({
      runtimePackage: { manifest: "runtime/package.json", lockfile: "runtime/package-lock.json" },
    });
    const general = effectiveRuntimePackage({
      runtime: [
        {
          ecosystem: "npm",
          delivery: "harness-installed",
          manifest: "runtime/package.json",
          lockfile: "runtime/package-lock.json",
        },
      ],
    });

    expect(general).toEqual(shorthand);
  });

  it("carries allowInstallScripts through the general spelling", () => {
    expect(
      effectiveRuntimePackage({
        runtime: [
          {
            ecosystem: "npm",
            delivery: "harness-installed",
            manifest: "m",
            lockfile: "l",
            allowInstallScripts: ["esbuild"],
          },
        ],
      })?.allowInstallScripts,
    ).toEqual(["esbuild"]);
  });

  it("ignores a runtime that is not npm, and finds none when there is none", () => {
    expect(
      effectiveRuntimePackage({
        runtime: [{ ecosystem: "pypi", delivery: "build-materialized", lockfile: "r.txt", into: "runtime/pypi" }],
      }),
    ).toBeUndefined();
    expect(effectiveRuntimePackage({})).toBeUndefined();
  });

  it("refuses both spellings of the npm runtime at once", () => {
    expect(
      runtimeSpellingProblem({
        runtimePackage: { manifest: "m", lockfile: "l" },
        runtime: [{ ecosystem: "npm", delivery: "harness-installed", manifest: "m", lockfile: "l" }],
      }),
    ).toContain("keep one");
    expect(runtimeSpellingProblem({ runtimePackage: { manifest: "m", lockfile: "l" } })).toBeUndefined();
  });
});

describe("validateRuntimeDeclarations", () => {
  it("reports an unreadable lockfile once, not twice", async () => {
    const root = await scratch("hooknostic-runtime-missing-");

    const problems = await validateRuntimeDeclarations(root, [
      { ecosystem: "pypi", delivery: "build-materialized", lockfile: "runtime/requirements.txt", into: "runtime/pypi" },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("could not be read");
  });

  it("passes a valid declaration through to the ecosystem's own contract", async () => {
    const root = await scratch("hooknostic-runtime-valid-");
    await writeFile(join(root, "requirements.txt"), "idna==3.19 --hash=sha256:abc\n");

    expect(
      await validateRuntimeDeclarations(root, [
        { ecosystem: "pypi", delivery: "build-materialized", lockfile: "requirements.txt", into: "runtime/pypi" },
      ]),
    ).toEqual([]);

    await writeFile(join(root, "requirements.txt"), "idna\n");
    const problems = await validateRuntimeDeclarations(root, [
      { ecosystem: "pypi", delivery: "build-materialized", lockfile: "requirements.txt", into: "runtime/pypi" },
    ]);
    expect(problems[0]).toContain("not pinned");
  });

  it("refuses two runtimes materializing into one directory", async () => {
    const root = await scratch("hooknostic-runtime-collide-");
    await writeFile(join(root, "a.txt"), "idna==3.19 --hash=sha256:abc\n");

    const problems = await validateRuntimeDeclarations(root, [
      { ecosystem: "pypi", delivery: "build-materialized", lockfile: "a.txt", into: "runtime" },
      { ecosystem: "pypi", delivery: "build-materialized", lockfile: "a.txt", into: "runtime" },
    ]);

    expect(problems.some((problem) => problem.includes("both materialize into"))).toBe(true);
  });

  it("refuses more than one declaration for an ecosystem", async () => {
    const root = await scratch("hooknostic-runtime-duplicate-ecosystem-");

    const problems = await validateRuntimeDeclarations(root, [
      { ecosystem: "npm", delivery: "author-supplied" },
      { ecosystem: "npm", delivery: "author-supplied" },
    ]);

    expect(problems).toEqual(['runtime ecosystem "npm" is declared more than once; keep one entry per ecosystem']);
  });

  it("accepts author-supplied content without installer inputs", async () => {
    const root = await scratch("hooknostic-runtime-vendored-");

    expect(
      await validateRuntimeDeclarations(root, [
        { ecosystem: "pypi", delivery: "author-supplied" },
        { ecosystem: "npm", delivery: "author-supplied" },
      ]),
    ).toEqual([]);
  });

  it("rejects installer inputs on an author-supplied runtime", async () => {
    const root = await scratch("hooknostic-runtime-vendored-input-");

    const problems = await validateRuntimeDeclarations(root, [
      { ecosystem: "pypi", delivery: "author-supplied", lockfile: "requirements.txt" },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("author-supplied dependencies are already package content");
  });

  it.each([
    "./requirements.txt",
    "../requirements.txt",
    "/outside/requirements.txt",
    "C:/outside/requirements.txt",
    "runtime\\requirements.txt",
  ])("rejects runtime input path %s outside the portable package namespace", async (lockfile) => {
    const root = await scratch("hooknostic-runtime-path-");

    const problems = await validateRuntimeDeclarations(root, [
      { ecosystem: "pypi", delivery: "build-materialized", lockfile, into: "runtime/pypi" },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("package-relative POSIX path");
  });

  it("rejects a package-relative runtime input that escapes through a symlink", async () => {
    const root = await scratch("hooknostic-runtime-link-root-");
    const outside = await scratch("hooknostic-runtime-link-outside-");
    await writeFile(join(outside, "requirements.txt"), "idna==3.19 --hash=sha256:abc\n");
    await symlink(join(outside, "requirements.txt"), join(root, "requirements.txt"), "file");

    const problems = await validateRuntimeDeclarations(root, [
      { ecosystem: "pypi", delivery: "build-materialized", lockfile: "requirements.txt", into: "runtime/pypi" },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("resolves outside the Agent Plugin root");
  });
});

describe("materializeRuntimes", () => {
  it("says what to install when the ecosystem's tool is absent", async () => {
    const root = await scratch("hooknostic-runtime-notool-");
    const staging = await scratch("hooknostic-runtime-staging-");
    await writeFile(join(root, "requirements.txt"), "idna==3.19 --hash=sha256:abc\n");

    // Emptying PATH is the only way to make a present `uv` absent, and the
    // message this produces is the one an author on a machine without it sees.
    const path = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const { runtimes, problems } = await materializeRuntimes({
        root,
        staging,
        declarations: [
          { ecosystem: "pypi", delivery: "build-materialized", lockfile: "requirements.txt", into: "runtime/pypi" },
        ],
      });

      expect(runtimes).toEqual([]);
      expect(problems[0]).toContain("uv");
      expect(problems[0]).toContain("author-supplied");
    } finally {
      process.env["PATH"] = path;
    }
  });

  it("does nothing for a delivery that is not materialized", async () => {
    const root = await scratch("hooknostic-runtime-noop-");
    const staging = await scratch("hooknostic-runtime-staging-");

    expect(
      await materializeRuntimes({
        root,
        staging,
        declarations: [{ ecosystem: "npm", delivery: "harness-installed", manifest: "m", lockfile: "l" }],
      }),
    ).toEqual({ runtimes: [], problems: [] });
  });

  it.runIf(UV)(
    "installs a pure distribution and admits the result",
    async () => {
      const root = await scratch("hooknostic-runtime-pure-");
      const staging = await scratch("hooknostic-runtime-staging-");
      await writeFile(join(root, "requirements.in"), "idna\n");
      execFileSync("uv", ["pip", "compile", "--generate-hashes", "requirements.in", "-o", "requirements.txt"], {
        cwd: root,
        stdio: "ignore",
      });

      const { runtimes, problems } = await materializeRuntimes({
        root,
        staging,
        declarations: [
          { ecosystem: "pypi", delivery: "build-materialized", lockfile: "requirements.txt", into: "runtime/pypi" },
        ],
      });

      expect(problems).toEqual([]);
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.into).toBe("runtime/pypi");
      expect(runtimes[0]?.files.some((file) => file.path === "idna/core.py")).toBe(true);
      // The installer's own console-script launcher is platform-native and would
      // otherwise make a wholly pure tree unshippable.
      expect(runtimes[0]?.files.some((file) => file.path.startsWith("bin/"))).toBe(false);
    },
    120_000,
  );

  it.runIf(UV)(
    "refuses a distribution carrying a compiled extension",
    async () => {
      const root = await scratch("hooknostic-runtime-native-");
      const staging = await scratch("hooknostic-runtime-staging-");
      await writeFile(join(root, "requirements.in"), "pydantic-core\n");
      execFileSync("uv", ["pip", "compile", "--generate-hashes", "requirements.in", "-o", "requirements.txt"], {
        cwd: root,
        stdio: "ignore",
      });

      const { runtimes, problems } = await materializeRuntimes({
        root,
        staging,
        declarations: [
          { ecosystem: "pypi", delivery: "build-materialized", lockfile: "requirements.txt", into: "runtime/pypi" },
        ],
      });

      expect(runtimes).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("built for one");
      expect(problems[0]).toContain("ADR-0006");
    },
    120_000,
  );
});
