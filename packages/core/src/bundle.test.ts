import { describe, expect, it } from "vitest";
import { bundleHasMainModuleGuard, bundleRuntime } from "./bundle.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

it("executes bundled CommonJS builtins without the source dependency tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-cjs-"));
  try {
    await writeFile(join(root, "helper.cjs"), 'module.exports = () => require("node:path").basename("/tmp/blocked");');
    const result = await bundleRuntime({ source: 'import helper from "./helper.cjs"; console.log(helper());', resolveDir: root });
    await rm(join(root, "helper.cjs"));
    const artifact = join(root, "hook.mjs");
    await writeFile(artifact, result.code);
    expect(execFileSync(process.execPath, [artifact], { encoding: "utf8" }).trim()).toBe("blocked");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("carries dependency license and notice text plus source legal comments through rebundling", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-notices-"));
  try {
    const dependency = join(root, "node_modules/notice-fixture");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "notice-fixture", version: "1.0.0", license: "MIT", main: "index.js" }));
    await writeFile(join(dependency, "index.js"), 'module.exports = require("node:path").basename("/fixture/42");');
    await writeFile(join(dependency, "LICENSE"), "Copyright Example Author\nPermission is hereby granted, free of charge.\n");
    await writeFile(join(dependency, "NOTICE"), "Example attribution notice.\n");
    const first = await bundleRuntime({ source: '/*! Keep this source attribution. */\nimport value from "notice-fixture"; console.log(value);', resolveDir: root });
    for (const text of ["notice-fixture@1.0.0", "Copyright Example Author", "Permission is hereby granted, free of charge.", "Example attribution notice.", "Keep this source attribution."]) expect(first.code).toContain(text);
    await writeFile(join(root, "prebundled.mjs"), first.code);
    await rm(join(root, "node_modules"), { recursive: true });
    const second = await bundleRuntime({ source: 'import "./prebundled.mjs";', resolveDir: root });
    expect(second.code).toContain("Copyright Example Author");
    expect(second.code).toContain("Example attribution notice.");
    expect(second.code).toContain("Keep this source attribution.");
    const artifact = join(root, "rebundled.mjs");
    await writeFile(artifact, second.code);
    await rm(join(root, "prebundled.mjs"));
    expect(execFileSync(process.execPath, [artifact], { encoding: "utf8" }).trim()).toBe("42");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("includes the SDK's own license in standalone runtimes as well as third-party licenses", async () => {
  const result = await bundleRuntime({
    source: 'import { block } from "@hooknostic/sdk"; console.log(block("review"));',
    resolveDir: import.meta.dirname,
    alias: { "@hooknostic/sdk": resolve(import.meta.dirname, "../../sdk/src/index.ts") },
  });
  expect(result.code).toContain((await readFile(resolve(import.meta.dirname, "../../sdk/LICENSE"), "utf8")).replaceAll("\r\n", "\n").trim());
  const sdkRequire = createRequire(resolve(import.meta.dirname, "../../sdk/package.json"));
  const zodLicense = resolve(sdkRequire.resolve("zod/package.json"), "../LICENSE");
  expect(result.code).toContain((await readFile(zodLicense, "utf8")).replaceAll("\r\n", "\n").trim());
});

describe("bundleHasMainModuleGuard", () => {
  it("detects the guard in both operand orderings", () => {
    for (const source of [
      `if (import.meta.url === pathToFileURL(process.argv[1]).href) main();`,
      `if (process.argv[1] === fileURLToPath(import.meta.url)) main();`,
      `if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();`,
      `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n  main();\n}`,
      `const isMain = import.meta.url == pathToFileURL(process.argv[1]).href;`,
      `if (import.meta.url !== pathToFileURL(process.argv[1]).href) return;`,
      // Minified dependency output keeps the comparison intact.
      `var a=import.meta.url===o(process.argv[1]).href;`,
    ]) {
      expect(bundleHasMainModuleGuard(source), source).toBe(true);
    }
  });

  it("ignores code that merely reads both values", () => {
    for (const source of [
      // Proximity is not a comparison — this was the original false positive.
      `console.log(import.meta.url);\nconst entry = process.argv[1];`,
      `const meta = { url: import.meta.url, entry: process.argv[1] };`,
      `log(import.meta.url, process.argv[1]);`,
      `const dir = dirname(fileURLToPath(import.meta.url));\nconst target = resolve(process.argv[1] ?? ".");`,
      // A comparison, but of a different operand joined by a logical operator.
      `if (process.argv[1] !== undefined && import.meta.url.startsWith("file:")) run();`,
      `if (import.meta.url !== "" || process.argv[1] === "--help") usage();`,
      // Each value compared against something else entirely.
      `if (import.meta.url === base) a();\nif (process.argv[1] === "x") b();`,
    ]) {
      expect(bundleHasMainModuleGuard(source), source).toBe(false);
    }
  });

  it("does not match across a statement boundary", () => {
    expect(
      bundleHasMainModuleGuard(`const url = import.meta.url;\nif (x === process.argv[1]) run();`),
    ).toBe(false);
  });
});
