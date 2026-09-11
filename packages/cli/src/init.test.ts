import { expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  } finally { await rm(root, { recursive: true, force: true }); }
});
