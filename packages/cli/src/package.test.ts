import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

describe("public package outputs", () => {
  it("ships the SDK as runnable ESM with declarations", async () => {
    const packageRoot = resolve(REPO, "packages/sdk");
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    expect(manifest.files).toEqual(["dist"]);
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(await readFile(resolve(packageRoot, "dist/index.d.ts"), "utf8")).toContain(
      "export",
    );
    const sdk = await import(pathToFileURL(resolve(packageRoot, "dist/index.js")).href);
    expect(sdk.definePlugin).toBeTypeOf("function");
  });

  it("ships a runnable programmatic CLI entry alongside the binary", async () => {
    const packageRoot = resolve(REPO, "packages/cli");
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    expect(manifest.files).toEqual(["bin", "dist"]);
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(await readFile(resolve(packageRoot, "dist/index.d.ts"), "utf8")).toContain(
      "runCli",
    );
    const cli = await import(pathToFileURL(resolve(packageRoot, "dist/index.js")).href);
    expect(cli.runCli).toBeTypeOf("function");
    expect(cli.runBuild).toBeTypeOf("function");
  });
});
