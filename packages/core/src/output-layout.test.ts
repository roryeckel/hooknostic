import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HooknosticConfig } from "@hooknostic/sdk";
import { validateOutputLayout } from "./output-layout.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(): Promise<{ dir: string; configPath: string; entryPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-layout-"));
  cleanup.push(dir);
  const configPath = join(dir, "hooknostic.config.ts");
  const entryPath = join(dir, "src/hooks.ts");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(configPath, "export default {};", "utf8");
  await writeFile(entryPath, "export default {};", "utf8");
  return { dir, configPath, entryPath };
}

function config(output: string, extra?: Partial<HooknosticConfig>): HooknosticConfig {
  return {
    entry: "./src/hooks.ts",
    targets: { alpha: { version: "1", mode: "local", output } },
    ...extra,
  };
}

describe("validateOutputLayout", () => {
  it.each([".", "../outside", "./src", "./hooknostic-build.json"])(
    "rejects unsafe target output %s",
    async (output) => {
      const fixture = await project();
      const result = await validateOutputLayout({
        configPath: fixture.configPath,
        entryPath: fixture.entryPath,
        config: config(output),
        selectedTargets: ["alpha"],
      });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "HN501", severity: "error", target: "alpha" }),
      ]);
    },
  );

  it("accepts an absolute spelling that resolves safely inside the project", async () => {
    const fixture = await project();
    const output = join(fixture.dir, "dist/alpha");
    const result = await validateOutputLayout({
      configPath: fixture.configPath,
      entryPath: fixture.entryPath,
      config: config(output),
      selectedTargets: ["alpha"],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.outputs[0]?.outputDir).toBe(output);
  });

  it("rejects an output whose existing symlink ancestor escapes the project", async () => {
    const fixture = await project();
    const external = await mkdtemp(join(tmpdir(), "hooknostic-external-"));
    cleanup.push(external);
    await symlink(external, join(fixture.dir, "linked"), "dir");
    const result = await validateOutputLayout({
      configPath: fixture.configPath,
      entryPath: fixture.entryPath,
      config: config("./linked/alpha"),
      selectedTargets: ["alpha"],
    });
    expect(result.diagnostics[0]).toMatchObject({ code: "HN501", target: "alpha" });
  });

  it("anchors relative outputs to the caller-visible directory of a symlinked config", async () => {
    const fixture = await project();
    const linkedProject = join(fixture.dir, "linked-project");
    await mkdir(linkedProject, { recursive: true });
    const linkedConfig = join(linkedProject, "hooknostic.config.ts");
    const linkedEntry = join(linkedProject, "hooks.ts");
    await symlink(fixture.configPath, linkedConfig, "file");
    await writeFile(linkedEntry, "export default {};", "utf8");
    const result = await validateOutputLayout({
      configPath: linkedConfig,
      entryPath: linkedEntry,
      config: {
        entry: "./hooks.ts",
        targets: {
          alpha: { version: "1", mode: "local", output: "./dist" },
        },
      },
      selectedTargets: ["alpha"],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.outputs[0]?.outputDir).toBe(join(linkedProject, "dist"));
  });

  it("rejects an entry symlink located inside a managed output", async () => {
    const fixture = await project();
    const external = await mkdtemp(join(tmpdir(), "hooknostic-entry-target-"));
    cleanup.push(external);
    const externalEntry = join(external, "hooks.ts");
    const outputDir = join(fixture.dir, "dist");
    const linkedEntry = join(outputDir, "hooks.ts");
    await writeFile(externalEntry, "export default {};", "utf8");
    await mkdir(outputDir, { recursive: true });
    await symlink(externalEntry, linkedEntry, "file");
    const result = await validateOutputLayout({
      configPath: fixture.configPath,
      entryPath: linkedEntry,
      config: {
        entry: "./dist/hooks.ts",
        targets: { alpha: { version: "1", mode: "local", output: "./dist" } },
      },
      selectedTargets: ["alpha"],
    });
    expect(result.diagnostics[0]).toMatchObject({ code: "HN501", target: "alpha" });
  });

  it("rejects equal, nested, and Agent Plugin extension collisions", async () => {
    const fixture = await project();
    const result = await validateOutputLayout({
      configPath: fixture.configPath,
      entryPath: fixture.entryPath,
      config: {
        entry: "./src/hooks.ts",
        agentPlugin: { root: "." },
        targets: {
          claude: {
            version: "1",
            mode: "plugin",
            output: "./com.anthropic.claude-code",
          },
          beta: { version: "1", mode: "local", output: "./dist" },
          gamma: { version: "1", mode: "local", output: "./dist/gamma" },
        },
      },
      selectedTargets: ["claude", "beta", "gamma"],
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.target)).toEqual(
      expect.arrayContaining(["claude", "beta", "gamma"]),
    );
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === "HN501")).toBe(true);
  });
});
