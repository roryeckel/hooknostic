import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { HookSourceExitError } from "@hooknostic/runtime";

import { claudeHarness } from "../../adapter-claude/src/harness.js";
import { buildPluginIR } from "./ir.js";
import { EvaluationStalledError, loadConfig, loadPluginSource, setEvaluationGuard } from "./load.js";
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
  it("reports a symbol-keyed target as an HN501 diagnostic instead of throwing", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "config.ts");
    await writeFile(
      file,
      `export default { entry: "hooks.ts", targets: {
        [Symbol("target")]: { version: "1", delivery: "package", output: "out" }
      } };`,
    );
    const result = await loadConfig(file);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "HN501", message: expect.stringContaining("targets.Symbol(target)") }),
    ]);
  });

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
      accept: [],
    });
    expect(effectiveCompatibility(config, "opencode")).toEqual({
      minimum: "approximate",
      onBelowMinimum: "warn",
      optionalUnavailable: "info",
      accept: [],
    });
    expect(effectiveRuntime(config)).toEqual({
      onHookError: "continue",
      timeoutMs: 5_000,
      processAllowanceMs: 5_000,
      contextCharLimit: 16_000,
      notifyCharLimit: 2_000,
    });
  });

  it("explains why an empty target name is invalid", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "config.ts");
    await writeFile(
      file,
      `export default { entry: "hooks.ts", targets: { "": { version: "1", delivery: "package", output: "out" } } };`,
    );
    const result = await loadConfig(file);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic).toMatchObject({ code: "HN501" });
    expect(diagnostic!.message).toContain("targets.: ");
    expect(diagnostic!.message).toContain(">=1 characters");
    expect(diagnostic!.message).not.toContain("Invalid key in record");
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

  describe("reports a default export that throws while it is validated as HN501 (#199)", () => {
    const REVOKED = `const revocable = Proxy.revocable({}, {}); revocable.revoke();`;
    const throwing = (value: string) => `export default { entry: "./hooks.ts", get targets() { throw ${value}; } };`;
    it.each([
      ["a throwing getter", throwing(`new Error("targets getter")`), "targets getter"],
      // A top-level revoked Proxy fails in evaluation, where `then` is read; a nested one reaches validation.
      [
        "a nested revoked Proxy",
        `${REVOKED} export default { entry: "./hooks.ts", targets: revocable.proxy };`,
        /^Cannot perform '\w+' on a proxy that has been revoked$/,
      ],
      [
        "a Proxy whose ownKeys trap throws",
        `export default new Proxy({ entry: "./hooks.ts", targets: {} }, { ownKeys() { throw new Error("ownKeys trap"); } });`,
        "ownKeys trap",
      ],
      [
        "a Proxy whose getPrototypeOf trap throws",
        `export default new Proxy({ entry: "./hooks.ts", targets: {} }, { getPrototypeOf() { throw new Error("getPrototypeOf trap"); } });`,
        "getPrototypeOf trap",
      ],
      [
        "a materializer provider whose id getter throws",
        `export default { components: { root: ".", materialize: [{ provider: { get id() { throw new Error("provider id getter"); }, plan() {} }, inputs: {}, into: "x" }] }, targets: {} };`,
        "provider id getter",
      ],
      ["a thrown string", throwing(`"thrown string"`), "thrown string"],
      ["a thrown null", throwing("null"), "null"],
      ["a thrown null-prototype object", throwing("Object.create(null)"), "uninspectable thrown value"],
      ["a thrown revoked Proxy", `${REVOKED} ${throwing("revocable.proxy")}`, "uninspectable thrown value"],
    ])("%s", async (_, source, detail) => {
      const dir = await fixtureDir();
      const file = join(dir, "hooknostic.config.ts");
      await writeFile(file, source, "utf8");
      const result = await loadConfig(file, OPTIONS);
      expect(result.config).toBeUndefined();
      expect(result.diagnostics).toEqual([
        {
          code: "HN501",
          severity: "error",
          message: expect.any(String),
          location: { file },
          remediation: "the config must be a TypeScript module whose default export is defineConfig({...}).",
        },
      ]);
      const prefix = `failed to load config ${file}: reading its default export threw: `;
      const message = result.diagnostics[0]!.message;
      expect(message.slice(0, prefix.length)).toBe(prefix);
      const rendered = message.slice(prefix.length);
      if (typeof detail === "string") expect(rendered).toBe(detail);
      else expect(rendered).toMatch(detail);
    });
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

describe("a root import of a schema that moved to @hooknostic/sdk/schemas (#247)", () => {
  const GUIDE = "https://github.com/roryeckel/hooknostic/blob/master/docs/upgrading/sdk-schemas-subpath.md";
  const hint = (names: string) =>
    "the SDK's schemas moved from @hooknostic/sdk to @hooknostic/sdk/schemas in 0.13.0: " +
    `import { ${names} } from "@hooknostic/sdk/schemas" instead. See ${GUIDE}.`;
  const GENERIC = "the config must be a TypeScript module whose default export is defineConfig({...}).";
  const CONFIG_BODY = `export default defineConfig({ entry: "./hooks.ts", targets: { claude: { version: ">=2.1 <3", delivery: "package", output: "./x" } } });`;

  async function config(imports: string) {
    const dir = await fixtureDir();
    const file = join(dir, "hooknostic.config.ts");
    await writeFile(file, `${imports}\nconsole.log(targetConfigSchema);\n${CONFIG_BODY}`);
    const result = await loadConfig(file, OPTIONS);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    return result.diagnostics[0]!;
  }

  it("names the subpath and the guide for a config, through a multi-line import", async () => {
    const diagnostic = await config(`import {\n  defineConfig,\n  targetConfigSchema,\n} from "@hooknostic/sdk";`);
    expect(diagnostic.code).toBe("HN501");
    expect(diagnostic.message).toContain('No matching export in "');
    expect(diagnostic.message).toContain('for import "targetConfigSchema"');
    expect(diagnostic.remediation).toBe(hint("targetConfigSchema"));
  });

  it("names every moved schema a hook source imports, once each", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "hooks.ts");
    await writeFile(
      file,
      `import { definePlugin, effectSchema, hookResultSchema, effectSchema as again } from "@hooknostic/sdk";
      console.log(effectSchema, hookResultSchema, again);
      export default definePlugin({ name: "p", hooks: [] });`,
    );
    const result = await loadPluginSource(file, OPTIONS);
    expect(result.plugin).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        code: "HN501",
        severity: "error",
        message: expect.any(String),
        location: { file },
        remediation: hint("effectSchema, hookResultSchema"),
      },
    ]);
    const prefix = `failed to load entry ${file}: `;
    expect(result.diagnostics[0]!.message.slice(0, prefix.length)).toBe(prefix);
  });

  it("keeps the config's own remediation after the hint when the build has other errors", async () => {
    const diagnostic = await config(
      `import { defineConfig, targetConfigSchema, missingHelper } from "@hooknostic/sdk";\nconsole.log(missingHelper);`,
    );
    expect(diagnostic.message).toContain('for import "missingHelper"');
    expect(diagnostic.remediation).toBe(`${hint("targetConfigSchema")} Beyond that, ${GENERIC}`);
  });

  it("gives no hint for a name the schemas subpath does not export", async () => {
    const missing = await config(
      `import { defineConfig, missingSchema as targetConfigSchema } from "@hooknostic/sdk";`,
    );
    expect(missing.message).toContain('for import "missingSchema"');
    expect(missing.remediation).toBe(GENERIC);

    const dir = await fixtureDir();
    const file = join(dir, "hooks.ts");
    await writeFile(
      file,
      `import { definePlugin, missingSchema } from "@hooknostic/sdk";\nconsole.log(missingSchema);\nexport default definePlugin({ name: "p", hooks: [] });`,
    );
    const entry = await loadPluginSource(file, OPTIONS);
    expect(entry.diagnostics).toHaveLength(1);
    expect(entry.diagnostics[0]!.message).toContain('for import "missingSchema"');
    expect(entry.diagnostics[0]).not.toHaveProperty("remediation");
  });

  it("gives no hint for a schema name missing from a module outside the SDK", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, "local.ts"), "export const other = 1;\n");
    const file = join(dir, "hooknostic.config.ts");
    await writeFile(
      file,
      `import { defineConfig } from "@hooknostic/sdk";\nimport { targetConfigSchema } from "./local.ts";\nconsole.log(targetConfigSchema);\n${CONFIG_BODY}`,
    );
    const result = await loadConfig(file, OPTIONS);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).toContain(
      'No matching export in "local.ts" for import "targetConfigSchema"',
    );
    expect(result.diagnostics[0]!.remediation).toBe(GENERIC);
  });

  it("names the subpath for an SDK installed in node_modules", async () => {
    const dir = await fixtureDir();
    const sdk = join(dir, "node_modules/@hooknostic/sdk");
    await mkdir(join(sdk, "dist"), { recursive: true });
    await writeFile(
      join(sdk, "package.json"),
      JSON.stringify({ name: "@hooknostic/sdk", type: "module", exports: { ".": "./dist/index.js" } }),
    );
    await writeFile(join(sdk, "dist/index.js"), "export const defineConfig = (config) => config;\n");
    const file = join(dir, "hooknostic.config.ts");
    await writeFile(
      file,
      `import { defineConfig, targetConfigSchema } from "@hooknostic/sdk";\nconsole.log(targetConfigSchema);\n${CONFIG_BODY}`,
    );
    // No alias: esbuild resolves the installed package, as in a user's project.
    const result = await loadConfig(file);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).toContain(
      'No matching export in "node_modules/@hooknostic/sdk/dist/index.js" for import "targetConfigSchema"',
    );
    expect(result.diagnostics[0]!.remediation).toBe(hint("targetConfigSchema"));
  });

  it("gives no hint when the SDK's own schemas subpath lacks the name, as an SDK older than the CLI's does", async () => {
    const dir = await fixtureDir();
    const sdk = join(dir, "node_modules/@hooknostic/sdk");
    await mkdir(join(sdk, "dist"), { recursive: true });
    await writeFile(
      join(sdk, "package.json"),
      JSON.stringify({
        name: "@hooknostic/sdk",
        type: "module",
        exports: { ".": "./dist/index.js", "./schemas": "./dist/schemas.js" },
      }),
    );
    await writeFile(
      join(sdk, "dist/index.js"),
      "export const defineConfig = (config) => config;\nexport const definePlugin = (plugin) => plugin;\n",
    );
    // This Hooknostic's own schemas subpath exports hookResultSchema; this SDK's does not.
    await writeFile(join(sdk, "dist/schemas.js"), "export const effectSchema = {};\n");
    const imports = `import { hookResultSchema } from "@hooknostic/sdk/schemas";\nconsole.log(hookResultSchema);\n`;
    const message =
      'No matching export in "node_modules/@hooknostic/sdk/dist/schemas.js" for import "hookResultSchema"';

    const file = join(dir, "hooknostic.config.ts");
    await writeFile(file, `import { defineConfig } from "@hooknostic/sdk";\n${imports}${CONFIG_BODY}`);
    // No alias: esbuild resolves the installed package, as in a user's project.
    const config = await loadConfig(file);
    expect(config.diagnostics).toHaveLength(1);
    expect(config.diagnostics[0]!.message).toContain(message);
    expect(config.diagnostics[0]!.remediation).toBe(GENERIC);

    const entryFile = join(dir, "hooks.ts");
    await writeFile(
      entryFile,
      `import { definePlugin } from "@hooknostic/sdk";\n${imports}export default definePlugin({ name: "p", hooks: [] });`,
    );
    const entry = await loadPluginSource(entryFile);
    expect(entry.diagnostics).toHaveLength(1);
    expect(entry.diagnostics[0]!.message).toContain(message);
    expect(entry.diagnostics[0]).not.toHaveProperty("remediation");
  });
});

describe("evaluating user modules", () => {
  const CONFIG = `{ entry: "./hooks.ts", targets: { claude: { version: ">=2.1 <3", delivery: "package", output: "./x" } } }`;

  afterEach(() => {
    setEvaluationGuard(undefined);
    delete (globalThis as { waiting?: unknown }).waiting;
  });

  it("renders a load failure whose thrown value cannot be inspected", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, "config.ts"), `throw Object.create(null);\nexport default ${CONFIG};`);
    await writeFile(join(dir, "hooks.ts"), `throw Object.create(null);\nexport default { name: "p", hooks: [] };`);

    const config = await loadConfig(join(dir, "config.ts"), OPTIONS);
    const entry = await loadPluginSource(join(dir, "hooks.ts"), OPTIONS);

    expect([...config.diagnostics, ...entry.diagnostics].map(({ code, message }) => ({ code, message }))).toEqual([
      { code: "HN501", message: `failed to load config ${join(dir, "config.ts")}: uninspectable thrown value` },
      { code: "HN501", message: `failed to load entry ${join(dir, "hooks.ts")}: uninspectable thrown value` },
    ]);
  });

  it("adopts a thenable default export, as an async config may rely on", async () => {
    const dir = await fixtureDir();
    const file = join(dir, "config.ts");
    await writeFile(file, `export default { then(resolve: (value: unknown) => void) { resolve(${CONFIG}); } };`);

    const result = await loadConfig(file, OPTIONS);

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.entry).toBe("./hooks.ts");
  });

  it("hands each evaluation to the CLI's guard, and names what stalled or exited", async () => {
    const dir = await fixtureDir();
    // Each module says when it waits on what never settles: the top-level
    // await before its import resolves, the thenable once it is adopted.
    await writeFile(
      join(dir, "tla.ts"),
      `globalThis.waiting?.();\nawait new Promise(() => {});\nexport default ${CONFIG};`,
    );
    await writeFile(join(dir, "thenable.ts"), `export default { then() { globalThis.waiting?.(); } };`);
    await writeFile(join(dir, "plain.ts"), `export default ${CONFIG};`);
    const signal = globalThis as { waiting?: () => void };
    const watched: string[] = [];
    // As the CLI's guard fails a load: the stall once the loop would empty,
    // here once the module waits; an exit once the load has run. Not after
    // a fixed delay, which a slow import under load outlasts (#193).
    let failure: () => unknown = () => new EvaluationStalledError();
    setEvaluationGuard({
      async watch(directory, evaluation) {
        watched.push(directory);
        evaluation.catch(() => {});
        await Promise.race([
          new Promise<void>((resolve) => {
            signal.waiting = resolve;
          }),
          evaluation.then(
            () => {},
            () => {},
          ),
        ]);
        throw failure();
      },
    });

    const tla = await loadConfig(join(dir, "tla.ts"), OPTIONS);
    const thenable = await loadPluginSource(join(dir, "thenable.ts"), OPTIONS);
    failure = () => new HookSourceExitError(3);
    const configExit = await loadConfig(join(dir, "plain.ts"), OPTIONS);
    const entryExit = await loadPluginSource(join(dir, "plain.ts"), OPTIONS);

    expect([tla, thenable, configExit, entryExit].map((result) => result.diagnostics[0]?.message)).toEqual([
      `failed to load config ${join(dir, "tla.ts")}: its top-level await never settles`,
      `failed to load entry ${join(dir, "thenable.ts")}: its default export is a thenable that never settles`,
      // A config is not the hook source.
      `failed to load config ${join(dir, "plain.ts")}: the config called process.exit(3)`,
      `failed to load entry ${join(dir, "plain.ts")}: the hook source called process.exit(3)`,
    ]);
    expect(watched).toHaveLength(4);
    expect(watched.every((directory) => /hooknostic-eval-/.test(directory))).toBe(true);
  });
});
