import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentPluginMetadata } from "./agent-plugin.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-agent-plugin-"));
  cleanup.push(dir);
  return dir;
}

describe("readAgentPluginMetadata", () => {
  it("treats only a missing plugin.json as standalone mode", async () => {
    const dir = await root();
    await expect(readAgentPluginMetadata(dir)).resolves.toEqual({
      present: false,
      diagnostics: [],
    });
  });

  it("reports a non-file plugin.json as HN501", async () => {
    const dir = await root();
    await mkdir(join(dir, "plugin.json"));
    const result = await readAgentPluginMetadata(dir);
    expect(result.present).toBe(true);
    expect(result.metadata).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "HN501",
        severity: "error",
        location: { file: join(dir, "plugin.json") },
      }),
    ]);
  });

  it("still reads valid manifest metadata", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "agent-plugin", version: "1.2.3", description: "test" }),
      "utf8",
    );
    const result = await readAgentPluginMetadata(dir);
    expect(result).toMatchObject({
      present: true,
      metadata: { name: "agent-plugin", version: "1.2.3", description: "test" },
      diagnostics: [],
    });
  });
});
