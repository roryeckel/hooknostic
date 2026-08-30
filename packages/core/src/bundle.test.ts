import { describe, expect, it } from "vitest";
import { bundleHasMainModuleGuard } from "./bundle.js";

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
