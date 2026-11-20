import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { opencodeV2Harness } from "@hooknostic/adapter-opencode";

const ROOT_VERSION = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
/** The repository's TypeScript compiler, run against a consumer's own tsconfig. */
const TSC = join(
  dirname(createRequire(join(REPO, "package.json")).resolve("@typescript/native/package.json")),
  "bin/tsc",
);
const SHIPPED_ADAPTERS = ["claude", "codex", "opencode", "pi"];

interface Manifest {
  name: string;
  files: string[];
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function manifestOf(packageDir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Manifest;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])),
  );
  return nested.flat();
}

/** Directory of a third-party package as resolved from `consumerDir`. */
function packageRoot(name: string, consumerDir: string): string {
  const require = createRequire(join(consumerDir, "package.json"));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // exports map without ./package.json: walk up from the entry module.
  }
  let dir = dirname(require.resolve(name));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as Manifest).name === name) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot locate the package root of ${name}`);
    dir = parent;
  }
}

describe("public package outputs", () => {
  it("ships the Agent Plugins loader, declarations, and bundled schemas", async () => {
    const root = resolve(REPO, "packages/agent-plugin");
    const manifest = await manifestOf(root);
    expect(manifest.files).toEqual(["dist", "schemas", "LICENSE"]);
    expect(await readFile(resolve(root, "schemas/1.0.0/plugin.schema.json"), "utf8")).toContain(
      "agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    );
    const api = await import(pathToFileURL(resolve(root, "dist/index.js")).href);
    expect(api.loadAgentPlugin).toBeTypeOf("function");
  });
  it("ships the SDK as runnable ESM with declarations", async () => {
    const packageRoot = resolve(REPO, "packages/sdk");
    const manifest = await manifestOf(packageRoot);
    expect(manifest.files).toEqual(["dist", "LICENSE"]);
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(manifest.exports["./schemas"]).toEqual({
      types: "./dist/schemas.d.ts",
      default: "./dist/schemas.js",
    });
    // `main` names the root entry for a resolver that reads no `exports`:
    // pnpm 12's nodeLinker: pnp hook resolves `@hooknostic/sdk` to the
    // package's directory, and Node resolves a directory by `main` alone, so
    // without it HN110 and doctor found no SDK under pnpm exec (#259,
    // .capture/pnpm-pnp). Requiring the directory is that resolution.
    expect(manifest.main).toBe(manifest.exports["."].default);
    expect(createRequire(import.meta.url).resolve(packageRoot)).toBe(resolve(packageRoot, "dist/index.js"));
    // Only the schemas subpath needs Zod (ADR-0040), but the peer stays
    // required: an optional one sends npm's arborist into a loop when a
    // project replaces its Zod (#240).
    expect(manifest.peerDependencies).toEqual({ zod: expect.any(String) });
    expect(manifest.peerDependenciesMeta).toBeUndefined();
    expect(await readFile(resolve(packageRoot, "dist/index.d.ts"), "utf8")).toContain("export");
    const sdk = await import(pathToFileURL(resolve(packageRoot, "dist/index.js")).href);
    expect(sdk.definePlugin).toBeTypeOf("function");
    const schemas = await import(pathToFileURL(resolve(packageRoot, "dist/schemas.js")).href);
    expect(schemas.effectSchema.parse(sdk.block("no"))).toEqual({ kind: "block", reason: "no" });
  });

  it("imports the SDK root without resolving zod", () => {
    const dist = resolve(REPO, "packages/sdk/dist");
    // A resolve hook that refuses zod: the root must load without ever asking
    // for it. Spawned so Node, not vitest's module runner, does the resolving.
    const importWithoutZod = (entry: string) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--no-warnings",
          "-e",
          `import { registerHooks } from "node:module";
           registerHooks({
             resolve(specifier, context, next) {
               if (/^zod(?:\\/|$)/.test(specifier)) throw new Error("zod requested: " + specifier);
               return next(specifier, context);
             },
           });
           const sdk = await import(${JSON.stringify(pathToFileURL(join(dist, entry)).href)});
           console.log(Object.keys(sdk).length);`,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
    const root = importWithoutZod("index.js");
    expect(root.status, root.stderr).toBe(0);
    expect(Number(root.stdout.trim())).toBeGreaterThan(0);
    // The hook is live: the subpath that does need Zod is refused under it.
    const schemas = importWithoutZod("schemas.js");
    expect(schemas.status).not.toBe(0);
    expect(schemas.stderr).toContain("zod requested: zod/v4");
  });

  it("emits SDK root declarations whose module graph never references zod", async () => {
    const dist = resolve(REPO, "packages/sdk/dist");
    /** Every specifier a declaration file imports, re-exports, or references. */
    const specifiersOf = (code: string) =>
      [
        ...code.matchAll(/\bfrom\s+["']([^"']+)["']/g),
        ...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
        ...code.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
        ...code.matchAll(/\/\/\/\s*<reference\s+(?:types|path)=["']([^"']+)["']/g),
      ].map((match) => match[1]!);
    const graphOf = async (entry: string) => {
      const files = new Map<string, string[]>();
      const pending = [join(dist, entry)];
      while (pending.length > 0) {
        const file = pending.pop()!;
        if (files.has(file)) continue;
        const specifiers = specifiersOf(await readFile(file, "utf8"));
        files.set(file, specifiers);
        for (const specifier of specifiers.filter((s) => s.startsWith("."))) {
          pending.push(resolve(dirname(file), specifier.replace(/\.js$/, ".d.ts")));
        }
      }
      return files;
    };
    const bareOf = (graph: Map<string, string[]>) =>
      [...graph.values()].flat().filter((specifier) => !specifier.startsWith("."));

    const root = await graphOf("index.d.ts");
    // The walk reached the modules behind the root's re-exports.
    expect([...root.keys()].map((file) => file.slice(dist.length + 1).replaceAll("\\", "/"))).toEqual(
      expect.arrayContaining(["index.d.ts", "config.d.ts", "hook.d.ts", "plugin.d.ts", "result.d.ts"]),
    );
    expect(bareOf(root).filter((specifier) => /^zod(?:\/|$)/.test(specifier))).toEqual([]);
    // The same walk does find Zod behind the subpath that needs it.
    expect(bareOf(await graphOf("schemas.d.ts"))).toContain("zod/v4");
  });

  it("ships a runnable programmatic CLI entry alongside the binary", async () => {
    const packageRoot = resolve(REPO, "packages/cli");
    const manifest = await manifestOf(packageRoot);
    expect(manifest.files).toEqual(["bin", "dist", "LICENSE"]);
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(await readFile(resolve(packageRoot, "dist/index.d.ts"), "utf8")).toContain("export");
    const cli = await import(pathToFileURL(resolve(packageRoot, "dist/index.js")).href);
    expect(cli.runCli).toBeTypeOf("function");
    expect(cli.runBuild).toBeTypeOf("function");
    // The binary reuses the programmatic bundle instead of duplicating it: it
    // imports the command's own entry, which shares the bundle's chunks, and
    // which the package does not export (only the command owns its process).
    expect(await readFile(resolve(packageRoot, "dist/hooknostic.mjs"), "utf8")).toContain('from "./main.js"');
    const chunksOf = async (entry: string) =>
      [...(await readFile(resolve(packageRoot, "dist", entry), "utf8")).matchAll(/from "\.\/(chunk-[^"]+)"/g)].map(
        (match) => match[1],
      );
    const shared = await chunksOf("index.js");
    expect(shared.length).toBeGreaterThan(0);
    const own = await chunksOf("main.js");
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((chunk) => shared.includes(chunk))).toBe(true);
    expect(cli).not.toHaveProperty("main");
  });

  it.each(["--version", "-v"])("prints the CLI manifest's version from the bundled binary (%s)", async (flag) => {
    const { version } = JSON.parse(await readFile(resolve(REPO, "packages/cli/package.json"), "utf8")) as {
      version: string;
    };
    const result = spawnSync(process.execPath, [resolve(REPO, "packages/cli/bin/hooknostic.mjs"), flag], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
    expect(result.stderr).toBe("");
  });

  it("ships prebundled adapter shims whose only external import is the SDK", async () => {
    for (const id of SHIPPED_ADAPTERS) {
      const code = await readFile(resolve(REPO, `packages/cli/dist/shims/${id}.mjs`), "utf8");
      const specifiers = [...code.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(specifiers, id).toContain("@hooknostic/sdk");
      // The runtime validates effects with the SDK's schemas subpath.
      expect(specifiers, id).toContain("@hooknostic/sdk/schemas");
      expect(
        specifiers.filter((s) => !s.startsWith("node:") && s !== "@hooknostic/sdk" && s !== "@hooknostic/sdk/schemas"),
        id,
      ).toEqual([]);
      // A shim that reaches into the compiler drags esbuild in with it, and
      // esbuild's CommonJS interop shim throws on import under plain Node.
      expect(code, id).not.toContain('Dynamic require of "');
    }
  });

  it("emits declarations that need no unpublished workspace package", async () => {
    const files = (await walk(resolve(REPO, "packages/cli/dist/types"))).filter((f) => f.endsWith(".d.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(await readFile(file, "utf8"), file).not.toMatch(/["']@hooknostic\/(agent-plugin|core|runtime|adapter-)/);
    }
  });
});

describe("simulated registry install", () => {
  const temp: string[] = [];
  afterAll(async () => {
    await Promise.all(temp.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** Copy exactly what `npm publish` ships: package.json plus the `files` entries. */
  async function publish(packageDir: string, root: string): Promise<Manifest> {
    const manifest = await manifestOf(packageDir);
    const dest = join(root, "node_modules", ...manifest.name.split("/"));
    await mkdir(dest, { recursive: true });
    await cp(join(packageDir, "package.json"), join(dest, "package.json"));
    for (const entry of manifest.files) {
      await cp(join(packageDir, entry), join(dest, entry), { recursive: true });
    }
    return manifest;
  }

  /** Satisfy a third-party dependency from the repo store, as a registry install would. */
  async function linkThirdParty(name: string, consumerDir: string, root: string): Promise<void> {
    const link = join(root, "node_modules", ...name.split("/"));
    if (existsSync(link)) return;
    await mkdir(dirname(link), { recursive: true });
    await symlink(await realpath(packageRoot(name, consumerDir)), link, "junction");
  }

  it(
    "builds a consumer project from only the published packages and their registry dependencies",
    { timeout: 180_000 },
    async () => {
      // Resolve the long path: GitHub's Windows runners expose TEMP as
      // C:\Users\RUNNER~1\..., and "~" percent-encodes to %7E in a file URL
      // (see the same guard in core's evaluateModule, vitest#7084).
      const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-install-"));
      temp.push(root);
      // Two install roots, as with a global CLI and a project that depends only
      // on the SDK: the CLI must not need the project's tree, and the built
      // artifact must still carry a single SDK copy (the project's).
      const cliRoot = join(root, "cli");
      const project = join(root, "project");
      const sdkDir = resolve(REPO, "packages/sdk");
      const agentPluginDir = resolve(REPO, "packages/agent-plugin");
      const cliDir = resolve(REPO, "packages/cli");
      const installs: [Manifest, string, string][] = [
        [await publish(cliDir, cliRoot), cliDir, cliRoot],
        [await publish(agentPluginDir, cliRoot), agentPluginDir, cliRoot],
        [await publish(sdkDir, cliRoot), sdkDir, cliRoot],
        [await publish(sdkDir, project), sdkDir, project],
      ];
      const published = new Set(installs.map(([manifest]) => manifest.name));
      // Install only declared dependencies: Yarn 1, and pnpm without
      // auto-install-peers, never add a missing peer. The project declares
      // only the SDK: authoring hooks needs no Zod (ADR-0040).
      const declared = new Map<string, Set<string>>([
        [cliRoot, new Set()],
        [project, new Set()],
      ]);
      for (const [manifest, consumerDir, installRoot] of installs) {
        for (const dependency of Object.keys(manifest.dependencies ?? {})) {
          declared.get(installRoot)!.add(dependency);
          if (published.has(dependency)) continue;
          // Everything else must exist on the registry: no unpublished workspace packages.
          expect(dependency, `${manifest.name} depends on ${dependency}`).not.toMatch(/^@hooknostic\//);
          await linkThirdParty(dependency, consumerDir, installRoot);
        }
      }
      // A required peer must come from a package that shares its install root,
      // or the published package resolves it only where a client auto-installs
      // peers.
      for (const [manifest, , installRoot] of installs) {
        for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
          // The one exception: the SDK's `zod` peer is required (#240), but only
          // `@hooknostic/sdk/schemas` needs it (ADR-0040). This project leaves
          // it out on purpose, as a client that never installs peers would.
          if (installRoot === project && manifest.name === "@hooknostic/sdk" && peer === "zod") continue;
          expect(declared.get(installRoot)!.has(peer), `${manifest.name}'s peer ${peer} in ${installRoot}`).toBe(true);
        }
      }
      // So the project's SDK finds no Zod: the strict case, which the failed
      // schemas import below confirms. `pnpm exec` puts the workspace's hoisted
      // store on NODE_PATH; keep it from the children, so no CommonJS lookup
      // can rescue a missing package either.
      const env = { ...process.env };
      delete env["NODE_PATH"];
      const installedAgentPlugin = await import(
        pathToFileURL(join(cliRoot, "node_modules/@hooknostic/agent-plugin/dist/index.js")).href
      );
      expect(installedAgentPlugin.loadAgentPlugin).toBeTypeOf("function");

      await mkdir(join(project, "src"), { recursive: true });
      const configSource = await readFile(join(REPO, "examples/basic/hooknostic.config.ts"), "utf8");
      await writeFile(
        join(project, "hooknostic.config.ts"),
        configSource.replace(
          "targets: {",
          `targets: {
        modern: { adapter: "opencode", version: ${JSON.stringify(opencodeV2Harness.recommendedRange)}, delivery: "project", output: "./dist/modern", compatibility: { minimum: "approximate", onBelowMinimum: "warn" } },`,
        ),
      );
      const hookSource = (await readFile(join(REPO, "examples/basic/src/hooks.ts"), "utf8"))
        .replace('id: "observe-session-end",', 'id: "observe-session-end", targets: { exclude: ["modern"] },')
        // The authoring surface a Zod-free project uses: definePlugin, hook, block, updateShell.
        .replace(
          'import { block, definePlugin, hook } from "@hooknostic/sdk";',
          'import { block, definePlugin, hook, updateShell } from "@hooknostic/sdk";',
        )
        .replace(
          "hooks: [",
          `hooks: [
    hook("tool.before", {
      id: "prefer-pnpm",
      match: { kind: "shell" },
      capabilities: { "input.replace": "optional" },
      run({ tool }, ctx) {
        const command = tool.shell?.command;
        if (command?.startsWith("npm ") && ctx.capabilities.has("input.replace")) {
          return updateShell({ command: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),`,
        );
      expect(hookSource).toContain("updateShell }");
      expect(hookSource).toContain('id: "prefer-pnpm"');
      await writeFile(join(project, "src/hooks.ts"), hookSource);
      await writeFile(
        join(project, "package.json"),
        JSON.stringify(
          {
            name: "consumer",
            private: true,
            type: "module",
            // Track the workspace version so a release bump cannot strand this.
            dependencies: { "@hooknostic/sdk": ROOT_VERSION },
          },
          null,
          2,
        ),
      );

      // The authored files type-check against the installed SDK's declarations
      // with library checking on, so a root declaration that needs Zod fails.
      await writeFile(
        join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            noEmit: true,
            skipLibCheck: false,
            types: [],
          },
          include: ["src/hooks.ts", "hooknostic.config.ts"],
        }),
      );
      const typecheck = spawnSync(process.execPath, [TSC, "-p", join(project, "tsconfig.json")], {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(typecheck.status, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);

      // Plain Node loads the root from the project; only the schemas subpath needs Zod.
      const importFromProject = (specifier: string) =>
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const sdk = await import(${JSON.stringify(specifier)}); console.log(Object.keys(sdk).length);`,
          ],
          { cwd: project, env, encoding: "utf8", timeout: 30_000 },
        );
      const rootImport = importFromProject("@hooknostic/sdk");
      expect(rootImport.status, rootImport.stderr).toBe(0);
      const schemasWithoutZod = importFromProject("@hooknostic/sdk/schemas");
      expect(schemasWithoutZod.status).not.toBe(0);
      expect(schemasWithoutZod.stderr).toMatch(/Cannot find package 'zod'/);

      const check = spawnSync(
        process.execPath,
        [
          join(cliRoot, "node_modules/hooknostic/bin/hooknostic.mjs"),
          "check",
          "--config",
          join(project, "hooknostic.config.ts"),
        ],
        { cwd: project, env, encoding: "utf8", stdio: "pipe", timeout: 150_000 },
      );
      expect(check.status, `stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).toBe(0);

      const run = spawnSync(
        process.execPath,
        [
          join(cliRoot, "node_modules/hooknostic/bin/hooknostic.mjs"),
          "build",
          "--json",
          "--config",
          join(project, "hooknostic.config.ts"),
        ],
        { cwd: project, env, encoding: "utf8", stdio: "pipe", timeout: 150_000 },
      );
      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      // Piped stdout arrived complete: the binary lets the loop drain instead of forcing exit.
      const report = JSON.parse(run.stdout) as {
        targets: Record<string, { status: string; requestedVersion: string }>;
      };
      expect(Object.keys(report.targets).sort()).toEqual(["claude", "codex", "modern", "opencode", "pi"]);
      for (const target of Object.values(report.targets)) expect(target.status).toBe("success");

      for (const artifact of [
        "dist/claude/runtime/hooknostic.mjs",
        "dist/codex/.codex/hooknostic/hooknostic.mjs",
        "dist/opencode/.opencode/plugins/hooknostic.js",
        "dist/modern/.opencode/plugins/hooknostic.js",
        "dist/pi/.pi/extensions/hooknostic.js",
      ]) {
        const code = await readFile(join(project, artifact), "utf8");
        // Self-contained: no bare workspace specifier survives bundling…
        expect(code, artifact).not.toMatch(/(from\s+|import\(|require\()["']@hooknostic\//);
        // …and the shim shared the project's SDK, whose schemas took Zod from the
        // CLI's install because the project has none, without a second copy.
        expect((code.match(/^\/\/ .*\/zod\/v4\/core\/errors\.js$/gm) ?? []).length, artifact).toBe(1);
        // …and nothing dragged a CommonJS build-time dependency in with it.
        expect(code, artifact).not.toContain('Dynamic require of "');
      }

      // OpenCode loads its plugin as a module, so plain Node must be able to
      // import the artifact — a bundled CommonJS dependency throws on import.
      // Spawned rather than imported in-process: vitest routes import()
      // through vite-node, which resolves and transforms differently than
      // Node, so an in-process import would not test the stated contract.
      const artifact = pathToFileURL(join(project, "dist/opencode/.opencode/plugins/hooknostic.js")).href;
      const load = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(artifact)});
           if (typeof m.HooknosticPlugin !== "function") {
             throw new Error("artifact does not export HooknosticPlugin");
           }`,
        ],
        { cwd: project, env, encoding: "utf8", stdio: "pipe", timeout: 60_000 },
      );
      expect(load.status, `stdout:\n${load.stdout}\nstderr:\n${load.stderr}`).toBe(0);

      const modernArtifact = pathToFileURL(join(project, "dist/modern/.opencode/plugins/hooknostic.js")).href;
      const modernLoad = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        const { default: plugin } = await import(${JSON.stringify(modernArtifact)});
        if (typeof plugin.setup !== "function" || typeof plugin.id !== "string") throw new Error("missing v2 definition");
      `,
        ],
        { cwd: project, env, encoding: "utf8", timeout: 60000 },
      );
      expect(modernLoad.status, modernLoad.stderr).toBe(0);

      // The installed compiler must resolve its own launcher dependencies;
      // the projected launcher must then run with no node_modules beside it.
      await mkdir(join(project, "portable"));
      await writeFile(
        join(project, "portable/plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "portable-probe",
        }),
      );
      await writeFile(
        join(project, "portable/mcp.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { probe: { type: "stdio", command: "node" } },
        }),
      );
      const config = join(project, "projection.config.ts");
      await writeFile(
        config,
        `export default ${JSON.stringify({
          components: { root: "portable", targets: ["claude"] },
          targets: {
            claude: { version: report.targets["claude"]!.requestedVersion, delivery: "package", output: "projected" },
          },
        })};`,
      );
      const projection = spawnSync(
        process.execPath,
        [join(cliRoot, "node_modules/hooknostic/bin/hooknostic.mjs"), "build", "--config", config],
        { cwd: project, env, encoding: "utf8", timeout: 60_000 },
      );
      expect(projection.status, `${projection.stdout}\n${projection.stderr}`).toBe(0);
      const launcher = spawnSync(
        process.execPath,
        [
          join(project, "projected/runtime/mcp-launcher.mjs"),
          project,
          process.execPath,
          "-e",
          'console.log("standalone launcher")',
        ],
        { cwd: project, env, encoding: "utf8", timeout: 10_000 },
      );
      expect(launcher.status, launcher.stderr).toBe(0);
      expect(launcher.stdout.trim()).toBe("standalone launcher");

      // Installing the SDK's Zod peer is all the schemas subpath needs.
      await linkThirdParty("zod", sdkDir, project);
      const schemasWithZod = importFromProject("@hooknostic/sdk/schemas");
      expect(schemasWithZod.status, schemasWithZod.stderr).toBe(0);
    },
  );
});
