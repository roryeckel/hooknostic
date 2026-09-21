import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { definePackageMaterializer, type PackageMaterializer, type PackageMaterializerFile } from "@hooknostic/sdk";

import {
  effectiveRuntimePackage,
  materializePackages,
  normalizeMaterializationDestination,
  validateMaterializationDeclarations,
} from "./materialize.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function copyingProvider(options: { id?: string; validate?: PackageMaterializer["validate"] } = {}) {
  return definePackageMaterializer({
    id: options.id ?? "fixture-copy",
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    plan({ inputs, outputDir }) {
      return {
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'copied.dat'), require('node:fs').readFileSync(process.argv[2]))",
          outputDir,
          inputs["source"]!.absolutePath,
        ],
      };
    },
  });
}

describe("effectiveRuntimePackage", () => {
  it("retains only the existing harness-owned npm contract", () => {
    const runtimePackage = { manifest: "runtime/package.json", lockfile: "runtime/package-lock.json" };
    expect(effectiveRuntimePackage({ runtimePackage })).toBe(runtimePackage);
    expect(effectiveRuntimePackage({})).toBeUndefined();
  });
});

describe("normalizeMaterializationDestination", () => {
  it.each(["generated/assets", "./generated/assets", "generated/assets/", "./generated/assets/"])(
    "canonicalizes %s",
    (into) => expect(normalizeMaterializationDestination(into)).toEqual({ ok: true, path: "generated/assets" }),
  );

  it.each([
    "",
    ".",
    "./",
    "../generated",
    "/generated",
    "C:/generated",
    "generated\\assets",
    "generated//assets",
    "generated/assets//",
    "generated/./assets",
    "generated/../assets",
    "gen:erated",
    "generated/\0assets",
    "generated/\nassets",
    "generated/\u007fassets",
  ])("rejects %s", (into) => expect(normalizeMaterializationDestination(into).ok).toBe(false));
});

describe("validateMaterializationDeclarations", () => {
  it("reports an unreadable package root for a zero-input provider instead of rejecting", async () => {
    const parent = await scratch("hooknostic-materialize-missing-root-");
    const missing = join(parent, "missing");
    const provider = definePackageMaterializer({
      id: "zero-input",
      plan: () => ({ command: process.execPath, args: [] }),
    });

    await expect(
      validateMaterializationDeclarations(missing, [{ provider, inputs: {}, into: "generated" }]),
    ).resolves.toEqual([expect.stringContaining('materializer "zero-input"')]);
  });

  it("canonicalizes destinations before duplicate detection", async () => {
    const root = await scratch("hooknostic-materialize-collision-");
    await writeFile(join(root, "input"), "data");
    const provider = copyingProvider();
    const problems = await validateMaterializationDeclarations(root, [
      { provider, inputs: { source: "input" }, into: "generated" },
      { provider, inputs: { source: "input" }, into: "./generated/" },
    ]);

    expect(problems).toContain('two materializers both write into "generated"');
  });

  it.each(["./input", "../input", "/input", "C:/input", "nested\\input", "nested//input"])(
    "rejects non-portable input path %s",
    async (input) => {
      const root = await scratch("hooknostic-materialize-input-");
      const problems = await validateMaterializationDeclarations(root, [
        { provider: copyingProvider(), inputs: { source: input }, into: "generated" },
      ]);
      expect(problems).toEqual([expect.stringContaining("package-relative POSIX path")]);
    },
  );

  it("rejects an input symlink that escapes the package root", async () => {
    const root = await scratch("hooknostic-materialize-link-root-");
    const outside = await scratch("hooknostic-materialize-link-outside-");
    await writeFile(join(outside, "input"), "data");
    await symlink(join(outside, "input"), join(root, "input"), "file");

    const problems = await validateMaterializationDeclarations(root, [
      { provider: copyingProvider(), inputs: { source: "input" }, into: "generated" },
    ]);
    expect(problems).toEqual([expect.stringContaining("resolves outside")]);
  });
});

describe("materializePackages", () => {
  it("rejects an invalid destination before invoking any provider method", async () => {
    const root = await scratch("hooknostic-materialize-invalid-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    let calls = 0;
    const provider = definePackageMaterializer({
      id: "never-called",
      validate() {
        calls += 1;
        return [];
      },
      plan() {
        calls += 1;
        return { command: process.execPath, args: [] };
      },
    });

    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "../outside" }],
    });
    expect(result.trees).toEqual([]);
    expect(result.problems).toEqual([expect.stringContaining('"into" "../outside"')]);
    expect(calls).toBe(0);
  });

  it("executes a trusted provider, postprocesses its tree, and emits the canonical destination", async () => {
    const root = await scratch("hooknostic-materialize-success-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "portable data");
    let plans = 0;
    const base = copyingProvider();
    const provider = definePackageMaterializer({
      ...base,
      plan(context: Parameters<typeof base.plan>[0]) {
        plans += 1;
        return base.plan(context);
      },
      postprocess(files: readonly PackageMaterializerFile[]) {
        return { files: files.map((file) => ({ ...file, path: `normalized/${file.path}` })), problems: [] };
      },
    });

    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "./generated/" }],
    });
    expect(result.problems).toEqual([]);
    expect(plans).toBe(1);
    expect(result.trees).toEqual([
      expect.objectContaining({
        provider: "fixture-copy",
        into: "generated",
        files: [expect.objectContaining({ path: "normalized/copied.dat", mode: 0o644 })],
      }),
    ]);
  });

  it("uses canonical modes and lets postprocess mark an executable explicitly", async () => {
    const root = await scratch("hooknostic-materialize-mode-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "portable data");
    const provider = definePackageMaterializer({
      ...copyingProvider(),
      postprocess: (files: readonly PackageMaterializerFile[]) => ({
        files: files.map((file) => ({ ...file, mode: 0o755 as const })),
        problems: [],
      }),
    });

    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });

    expect(result.problems).toEqual([]);
    expect(result.trees[0]?.files).toEqual([expect.objectContaining({ path: "copied.dat", mode: 0o755 })]);
  });

  it("reports provider validation without planning a command", async () => {
    const root = await scratch("hooknostic-materialize-validation-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    let planned = false;
    const provider = definePackageMaterializer({
      ...copyingProvider({ validate: () => ["input is not locked"] }),
      plan() {
        planned = true;
        return { command: process.execPath, args: [] };
      },
    });

    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });
    expect(result.problems).toEqual([expect.stringContaining("input is not locked")]);
    expect(planned).toBe(false);
  });

  it("reports a missing provider command", async () => {
    const root = await scratch("hooknostic-materialize-missing-tool-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      id: "missing-tool",
      plan: () => ({ command: "hooknostic-definitely-missing-materializer", args: [] }),
    });
    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });
    expect(result.problems).toEqual([expect.stringContaining("hooknostic-definitely-missing-materializer")]);
  });

  it.each(["stdout", "stderr"] as const)(
    "drains provider %s larger than the synchronous buffer limit",
    async (stream) => {
      const root = await scratch(`hooknostic-materialize-large-${stream}-`);
      const staging = await scratch("hooknostic-materialize-staging-");
      await writeFile(join(root, "input"), "data");
      const provider = definePackageMaterializer({
        id: `large-${stream}`,
        plan: ({ outputDir }) => ({
          command: process.execPath,
          args: [
            "-e",
            `process.${stream}.write("x".repeat(1024 * 1024 + 1024)); require("node:fs").writeFileSync(require("node:path").join(process.argv[1], "complete"), "yes")`,
            outputDir,
          ],
        }),
      });

      const result = await materializePackages({
        root,
        staging,
        declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
      });

      expect(result.problems).toEqual([]);
      expect(result.trees[0]?.files).toEqual([
        expect.objectContaining({ path: "complete", contents: Buffer.from("yes") }),
      ]);
    },
  );

  it("keeps the final stderr lines when a verbose provider exits nonzero", async () => {
    const root = await scratch("hooknostic-materialize-command-failure-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      id: "verbose-failure",
      plan: () => ({
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("x".repeat(1024 * 1024 + 1024)); process.stderr.write("\\nfirst\\nsecond\\nfinal marker\\n"); process.exit(7)',
        ],
      }),
    });

    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });

    expect(result.problems).toEqual([
      expect.stringMatching(/command exited with code 7: .*first second final marker$/),
    ]);
  });

  it.skipIf(process.platform === "win32")("reports provider signal termination explicitly", async () => {
    const root = await scratch("hooknostic-materialize-command-signal-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      id: "signal",
      plan: () => ({
        command: process.execPath,
        args: ["-e", 'process.kill(process.pid, "SIGTERM")'],
      }),
    });

    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });

    expect(result.problems).toEqual([expect.stringContaining("command terminated by signal")]);
  });

  it("reports provider spawn errors other than a missing command", async () => {
    const root = await scratch("hooknostic-materialize-command-error-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      id: "spawn-error",
      plan: () => ({ command: "\0", args: [] }),
    });

    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });

    expect(result.problems).toEqual([expect.stringContaining("could not start")]);
  });

  it("rejects provider-returned escaping and duplicate paths", async () => {
    const root = await scratch("hooknostic-materialize-paths-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      ...copyingProvider(),
      postprocess: () => ({
        files: [
          { path: "../escape", contents: new Uint8Array(), mode: 0o644 },
          { path: "same", contents: new Uint8Array(), mode: 0o644 },
          { path: "same", contents: new Uint8Array(), mode: 0o644 },
        ],
        problems: [],
      }),
    });
    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });
    expect(result.problems).toEqual([
      expect.stringContaining("invalid output path"),
      expect.stringContaining("duplicate output path"),
    ]);
  });

  it("rejects provider-returned modes outside the canonical pair", async () => {
    const root = await scratch("hooknostic-materialize-invalid-mode-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      ...copyingProvider(),
      postprocess: () => ({
        files: [
          {
            path: "private",
            contents: new Uint8Array(),
            mode: 0o600,
          } as unknown as PackageMaterializerFile,
        ],
        problems: [],
      }),
    });

    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });

    expect(result.trees).toEqual([]);
    expect(result.problems).toEqual([expect.stringContaining("canonical mode 0644 or 0755")]);
  });

  it("treats produced bytes as opaque after structural validation", async () => {
    const root = await scratch("hooknostic-materialize-opaque-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      ...copyingProvider(),
      postprocess: () => ({
        files: [{ path: "opaque", contents: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), mode: 0o644 }],
        problems: [],
      }),
    });
    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });
    expect(result.problems).toEqual([]);
    expect(result.trees[0]?.files).toEqual([
      expect.objectContaining({ path: "opaque", contents: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) }),
    ]);
  });

  it("reports provider-owned portability failures from postprocess", async () => {
    const root = await scratch("hooknostic-materialize-provider-portability-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      ...copyingProvider(),
      postprocess: (files: readonly PackageMaterializerFile[]) => ({
        files,
        problems: ["locked dependency resolves to a host-specific native binary"],
      }),
    });
    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });

    expect(result.problems).toEqual([expect.stringContaining("host-specific native binary")]);
    expect(result.trees).toEqual([]);
  });
});
