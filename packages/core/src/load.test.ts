import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { claudeHarness } from "../../adapter-claude/src/harness.js";
import { buildPluginIR } from "./ir.js";
import { loadConfig, loadPluginSource } from "./load.js";
import { effectiveCompatibility, effectiveRuntime } from "./policy.js";

const SDK_PATH = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../sdk/src/index.ts");
const OPTIONS = { alias: { "@hooknostic/sdk": SDK_PATH } };

const tempDirs: string[] = [];
async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-fixture-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("evaluates CommonJS dependencies requiring Node builtins at module initialization", async () => {
    const dir = await fixtureDir();
    await writeFile(
      join(dir, "helper.cjs"),
      'const path = require("node:path"); module.exports = path.basename("/project/hooks.ts");',
    );
    const file = join(dir, "config.ts");
    await writeFile(
      file,
      'import entry from "./helper.cjs"; export default { entry, targets: { fake: { version: "1", delivery: "project", output: "dist" } } };',
    );
    const result = await loadConfig(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.config?.entry).toBe("hooks.ts");
    // Vitest can supply a require shim; only a native subprocess pins ESM evaluation.
    await writeFile(join(dir, "hooks.ts"), 'export default { name: "cjs", hooks: [] };');
    await writeFile(
      file,
      `import entry from "./helper.cjs"; export default { entry, targets: { claude: { version: ${JSON.stringify(claudeHarness.recommendedRange)}, delivery: "package", output: "dist" } } };`,
    );
    const child = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../../cli/bin/hooknostic.mjs"), "check", "--config", file, "--json"],
      { encoding: "utf8" },
    );
    expect(child.status, child.stdout + child.stderr).toBe(0);
  });
  it("evaluates and validates a TypeScript config module", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "hooknostic.config.ts");
    await writeFile(
      file,
      `
      import { defineConfig } from "@hooknostic/sdk";
      export default defineConfig({
        entry: "./src/hooks.ts",
        compatibility: { minimum: "emulated", onBelowMinimum: "error" },
        targets: {
          claude: { version: ">=2.1 <3", delivery: "package", output: "./dist/claude" },
          opencode: {
            version: ">=1.18 <2",
            delivery: "project",
            output: "./dist/opencode",
            compatibility: { minimum: "approximate", onBelowMinimum: "warn" },
          },
        },
      });
      `,
      "utf8",
    );

    const result = await loadConfig(file, OPTIONS);
    expect(result.diagnostics).toEqual([]);
    expect(result.config?.entry).toBe("./src/hooks.ts");
    expect(Object.keys(result.config?.targets ?? {})).toEqual(["claude", "opencode"]);

    const config = result.config!;
    expect(effectiveCompatibility(config, "claude")).toEqual({
      minimum: "emulated",
      onBelowMinimum: "error",
      optionalUnavailable: "info",
    });
    expect(effectiveCompatibility(config, "opencode")).toEqual({
      minimum: "approximate",
      onBelowMinimum: "warn",
      optionalUnavailable: "info",
    });
    expect(effectiveRuntime(config)).toEqual({
      onHookError: "continue",
      timeoutMs: 5_000,
      contextCharLimit: 16_000,
      notifyCharLimit: 2_000,
    });
  });

  it("reports invalid configuration as HN501", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "hooknostic.config.ts");
    await writeFile(
      file,
      `export default { entry: "./src/hooks.ts", targets: { claude: { version: ">=2.1 <3", mode: "daemon", output: "./x" } } };`,
      "utf8",
    );
    const result = await loadConfig(file, OPTIONS);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toMatchObject({ code: "HN501", severity: "error" });
  });

  it("reports an empty target set as HN501", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "hooknostic.config.ts");
    await writeFile(file, `export default { entry: "./src/hooks.ts", targets: {} };`, "utf8");
    const result = await loadConfig(file, OPTIONS);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain("no targets");
  });

  it("allows an empty target set only for project-aware config loading", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "hooknostic.config.ts");
    await writeFile(file, `export default { project: { root: "." }, entry: "./hooks.ts", targets: {} };`, "utf8");

    const ordinary = await loadConfig(file, OPTIONS);
    expect(ordinary.config).toBeUndefined();
    expect(ordinary.diagnostics[0]?.message).toContain("no targets");

    const project = await loadConfig(file, OPTIONS, { allowEmptyProjectTargets: true });
    expect(project.diagnostics).toEqual([]);
    expect(project.config?.targets).toEqual({});

    await writeFile(file, `export default { entry: "./hooks.ts", targets: {} };`, "utf8");
    const nonProject = await loadConfig(file, OPTIONS, { allowEmptyProjectTargets: true });
    expect(nonProject.config).toBeUndefined();
    expect(nonProject.diagnostics[0]?.message).toContain("no targets");
  });

  it("reports unloadable modules as HN501 instead of throwing", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "hooknostic.config.ts");
    await writeFile(file, `this is not typescript {{{`, "utf8");
    const result = await loadConfig(file, OPTIONS);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "HN501", severity: "error" });
  });

  it("loads configs under a tilde directory (8.3 short-name regression, vitest#7084)", async () => {
    // GitHub's Windows runners expose TEMP as C:\Users\RUNNER~1\...; the "~"
    // percent-encodes to %7E and the vitest runner could not import() that
    // URL. evaluateModule must resolve the long path before importing.
    const tilded = join(await realpath(tmpdir()), "hooknostic-tilde~probe");
    await mkdir(tilded, { recursive: true });
    tempDirs.push(tilded);
    const file = join(tilded, "hooknostic.config.ts");
    await writeFile(
      file,
      `export default { entry: "./src/hooks.ts", targets: { claude: { version: ">=2.1 <3", delivery: "package", output: "./x" } } };`,
      "utf8",
    );
    const result = await loadConfig(file, OPTIONS);
    expect(result.diagnostics).toEqual([]);
    expect(result.config?.entry).toBe("./src/hooks.ts");
  });
});

describe("loadPluginSource → buildPluginIR", () => {
  it("deterministically turns example source into normalized IR", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "hooks.ts");
    await writeFile(
      file,
      `
      import { definePlugin, hook, block, replaceInput, addContext } from "@hooknostic/sdk";

      export default definePlugin({
        name: "portable-repo-hooks",
        hooks: [
          hook("tool.before", {
            id: "protect-and-normalize-shell",
            match: { kind: "shell" },
            capabilities: {
              "tool.before.block": "required",
              "tool.before.input.replace": "optional",
            },
            async run(event, ctx) {
              const input = event.tool.input as { command?: string };
              const command = input.command ?? "";
              if (command.includes("rm -rf /")) return block("Refusing destructive root deletion");
              if (ctx.capabilities.has("tool.before.input.replace") && command.startsWith("npm ")) {
                return replaceInput({ ...input, command: command.replace(/^npm /, "pnpm ") });
              }
            },
          }),
          hook("session.start", {
            id: "repo-context",
            capabilities: { "session.start.context.add": "optional" },
            async run(event, ctx) {
              if (!ctx.capabilities.has("session.start.context.add")) return;
              return addContext("Working directory: " + event.session.cwd);
            },
          }),
        ],
      });
      `,
      "utf8",
    );

    const first = await loadPluginSource(file, OPTIONS);
    const second = await loadPluginSource(file, OPTIONS);
    expect(first.diagnostics).toEqual([]);
    expect(first.plugin?.name).toBe("portable-repo-hooks");

    const irA = buildPluginIR(first.plugin);
    const irB = buildPluginIR(second.plugin);
    expect(irA.diagnostics).toEqual([]);
    expect(JSON.stringify(irA.ir)).toBe(JSON.stringify(irB.ir));
    expect(irA.ir?.hooks.map((h) => [h.index, h.id, h.event])).toEqual([
      [0, "protect-and-normalize-shell", "tool.before"],
      [1, "repo-context", "session.start"],
    ]);
    expect(typeof first.plugin?.hooks[0]?.run).toBe("function");
  });

  it("reports a missing default export as HN501", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "hooks.ts");
    await writeFile(file, `export const nothing = 1;`, "utf8");
    const result = await loadPluginSource(file, OPTIONS);
    expect(result.plugin).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "HN501" });
  });
});
