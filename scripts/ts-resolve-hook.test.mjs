import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolve } from "./ts-resolve-hook.mjs";

// The drift driver (scripts/drive-capture-session.mjs) is the only plain-Node
// consumer of packages/cli/test/harness-playback.ts; vitest and esbuild resolve
// its dependency tree through bundler rules, the driver does not. The
// end-to-end probe runs in a native subprocess for the same reason load.test.ts
// spawns one: an in-process import would go through vitest's own resolver and
// pin nothing. The resolve() fallback branches are unit-tested in-process with
// a fake nextResolve, which needs no files and can exercise parent URLs the
// subprocess lane would need node_modules fixtures to reach.
const hookPath = fileURLToPath(new URL("./ts-resolve-hook.mjs", import.meta.url));
const playbackPath = fileURLToPath(new URL("../packages/cli/test/harness-playback.ts", import.meta.url));

/** nextResolve that fails for every specifier except the given ones. */
function fakeNextResolve(known, calls = []) {
  return async (specifier, context) => {
    calls.push([specifier, context.parentURL]);
    const url = known[specifier];
    if (url === undefined) throw new Error("ERR_MODULE_NOT_FOUND");
    return { url, shortCircuit: false, format: "module" };
  };
}

describe("ts-resolve-hook (drift-driver loader)", () => {
  it("imports harness-playback.ts under plain Node through the hook", () => {
    // Pins the jsonc-parser lib/esm regression: packages/core/src/project-files.ts
    // deep-imports the ESM build, whose extensionless internal imports only a
    // bundler resolves. Vitest and the esbuild CLI bundle load it natively; a
    // plain Node process needs the hook to retry with ".js".
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
        import { register } from "node:module";
        import { pathToFileURL } from "node:url";
        register(pathToFileURL(process.argv[1]));
        const mod = await import(pathToFileURL(process.argv[2]).href);
        console.log(typeof mod.startModelPlayback === "function" ? "ok" : "missing exports");
        `,
        "--",
        hookPath,
        playbackPath,
      ],
      { encoding: "utf8" },
    );
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stdout).toContain("ok");
  });

  it("retries an extensionless relative import from a node_modules parent with .js", async () => {
    const calls = [];
    const nextResolve = fakeNextResolve({ "./impl/format.js": "file:///resolved/format.js" }, calls);
    // jsonc-parser's lib/esm/main.js imports "./impl/format" extensionless.
    const result = await resolve(
      "./impl/format",
      { parentURL: "file:///repo/node_modules/jsonc-parser/lib/esm/main.js" },
      nextResolve,
    );
    expect(result.url).toBe("file:///resolved/format.js");
    // The ".js" retry fires after the original resolution failed.
    expect(calls).toEqual([
      ["./impl/format", "file:///repo/node_modules/jsonc-parser/lib/esm/main.js"],
      ["./impl/format.js", "file:///repo/node_modules/jsonc-parser/lib/esm/main.js"],
    ]);
  });

  it("keeps a genuinely missing extensionless import an ERR_MODULE_NOT_FOUND", async () => {
    const calls = [];
    const nextResolve = fakeNextResolve({}, calls);
    await expect(
      resolve("./impl/format", { parentURL: "file:///repo/node_modules/jsonc-parser/lib/esm/main.js" }, nextResolve),
    ).rejects.toThrow("ERR_MODULE_NOT_FOUND");
    // Both the bare and ".js" forms were tried before surfacing the original error.
    expect(calls).toEqual([
      ["./impl/format", "file:///repo/node_modules/jsonc-parser/lib/esm/main.js"],
      ["./impl/format.js", "file:///repo/node_modules/jsonc-parser/lib/esm/main.js"],
    ]);
  });

  it("does not retry extensionless imports outside node_modules", async () => {
    const calls = [];
    const nextResolve = fakeNextResolve({ "./sibling.js": "file:///resolved/sibling.js" }, calls);
    await expect(
      resolve("./sibling", { parentURL: "file:///repo/packages/core/src/project-files.ts" }, nextResolve),
    ).rejects.toThrow("ERR_MODULE_NOT_FOUND");
    expect(calls).toEqual([["./sibling", "file:///repo/packages/core/src/project-files.ts"]]);
  });

  it("does not retry a failed extensioned import from a node_modules parent", async () => {
    // "./data.json" failing must surface its own error; retrying it as
    // "./data.json.js" could bind to an unrelated sibling file.
    const calls = [];
    const nextResolve = fakeNextResolve({ "./data.json.js": "file:///resolved/data.json.js" }, calls);
    await expect(
      resolve("./data.json", { parentURL: "file:///repo/node_modules/some-pkg/lib/esm/main.js" }, nextResolve),
    ).rejects.toThrow("ERR_MODULE_NOT_FOUND");
    expect(calls).toEqual([["./data.json", "file:///repo/node_modules/some-pkg/lib/esm/main.js"]]);
  });
});
