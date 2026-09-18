import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { definePackageMaterializer, type PackageMaterializer } from "@hooknostic/sdk";

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
      postprocess(files: readonly { path: string; contents: Uint8Array }[]) {
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
        files: [expect.objectContaining({ path: "normalized/copied.dat" })],
      }),
    ]);
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

  it("rejects provider-returned escaping and duplicate paths", async () => {
    const root = await scratch("hooknostic-materialize-paths-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      ...copyingProvider(),
      postprocess: () => ({
        files: [
          { path: "../escape", contents: new Uint8Array() },
          { path: "same", contents: new Uint8Array() },
          { path: "same", contents: new Uint8Array() },
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

  it("rejects actual native executable output", async () => {
    const root = await scratch("hooknostic-materialize-native-");
    const staging = await scratch("hooknostic-materialize-staging-");
    await writeFile(join(root, "input"), "data");
    const provider = definePackageMaterializer({
      ...copyingProvider(),
      postprocess: () => ({
        files: [{ path: "native", contents: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) }],
        problems: [],
      }),
    });
    const result = await materializePackages({
      root,
      staging,
      declarations: [{ provider, inputs: { source: "input" }, into: "generated" }],
    });
    expect(result.problems).toEqual([expect.stringContaining("platform-specific output")]);
  });
});
