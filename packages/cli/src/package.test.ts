import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT_VERSION = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const SHIPPED_ADAPTERS = ["claude", "codex", "opencode"];

interface Manifest {
  name: string;
  files: string[];
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
}

async function manifestOf(packageDir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Manifest;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
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
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as Manifest).name === name
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot locate the package root of ${name}`);
    dir = parent;
  }
}

describe("public package outputs", () => {
  it("ships the SDK as runnable ESM with declarations", async () => {
    const packageRoot = resolve(REPO, "packages/sdk");
    const manifest = await manifestOf(packageRoot);
    expect(manifest.files).toEqual(["dist", "LICENSE"]);
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
    const manifest = await manifestOf(packageRoot);
    expect(manifest.files).toEqual(["bin", "dist", "LICENSE"]);
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(await readFile(resolve(packageRoot, "dist/index.d.ts"), "utf8")).toContain(
      "export",
    );
    const cli = await import(pathToFileURL(resolve(packageRoot, "dist/index.js")).href);
    expect(cli.runCli).toBeTypeOf("function");
    expect(cli.runBuild).toBeTypeOf("function");
    // The binary reuses the programmatic bundle instead of duplicating it.
    expect(await readFile(resolve(packageRoot, "dist/hooknostic.mjs"), "utf8")).toContain(
      'from "./index.js"',
    );
  });

  it("ships prebundled adapter shims whose only external import is the SDK", async () => {
    for (const id of SHIPPED_ADAPTERS) {
      const code = await readFile(resolve(REPO, `packages/cli/dist/shims/${id}.mjs`), "utf8");
      const specifiers = [...code.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(specifiers, id).toContain("@hooknostic/sdk");
      expect(
        specifiers.filter((s) => !s.startsWith("node:") && s !== "@hooknostic/sdk"),
        id,
      ).toEqual([]);
      // A shim that reaches into the compiler drags esbuild in with it, and
      // esbuild's CommonJS interop shim throws on import under plain Node.
      expect(code, id).not.toContain('Dynamic require of "');
    }
  });

  it("emits declarations that need no unpublished workspace package", async () => {
    const files = (await walk(resolve(REPO, "packages/cli/dist/types"))).filter((f) =>
      f.endsWith(".d.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(await readFile(file, "utf8"), file).not.toMatch(
        /["']@hooknostic\/(core|runtime|adapter-)/,
      );
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
      const cliDir = resolve(REPO, "packages/cli");
      const installs: [Manifest, string, string][] = [
        [await publish(cliDir, cliRoot), cliDir, cliRoot],
        [await publish(sdkDir, cliRoot), sdkDir, cliRoot],
        [await publish(sdkDir, project), sdkDir, project],
      ];
      const published = new Set(installs.map(([manifest]) => manifest.name));
      for (const [manifest, consumerDir, installRoot] of installs) {
        for (const dependency of Object.keys(manifest.dependencies ?? {})) {
          if (published.has(dependency)) continue;
          // Everything else must exist on the registry: no unpublished workspace packages.
          expect(dependency, `${manifest.name} depends on ${dependency}`).not.toMatch(
            /^@hooknostic\//,
          );
          await linkThirdParty(dependency, consumerDir, installRoot);
        }
      }

      await mkdir(join(project, "src"), { recursive: true });
      await cp(
        join(REPO, "examples/basic/hooknostic.config.ts"),
        join(project, "hooknostic.config.ts"),
      );
      await cp(join(REPO, "examples/basic/src/hooks.ts"), join(project, "src/hooks.ts"));
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

      const run = spawnSync(
        process.execPath,
        [
          join(cliRoot, "node_modules/hooknostic/bin/hooknostic.mjs"),
          "build",
          "--json",
          "--config",
          join(project, "hooknostic.config.ts"),
        ],
        { cwd: project, encoding: "utf8", stdio: "pipe", timeout: 150_000 },
      );
      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      // Piped stdout arrived complete: the binary lets the loop drain instead of forcing exit.
      const report = JSON.parse(run.stdout) as { targets: Record<string, { status: string }> };
      expect(Object.keys(report.targets).sort()).toEqual(["claude", "codex", "opencode"]);
      for (const target of Object.values(report.targets)) expect(target.status).toBe("success");

      for (const artifact of [
        "dist/claude/runtime/hooknostic.mjs",
        "dist/codex/.codex/hooknostic/hooknostic.mjs",
        "dist/opencode/.opencode/plugins/hooknostic.js",
      ]) {
        const code = await readFile(join(project, artifact), "utf8");
        // Self-contained: no bare workspace specifier survives bundling…
        expect(code, artifact).not.toMatch(/(from\s+|import\(|require\()["']@hooknostic\//);
        // …and the shim shared the project's SDK instead of bundling a second zod.
        expect((code.match(/^\/\/ .*\/zod\/v3\/ZodError\.js$/gm) ?? []).length, artifact).toBe(1);
        // …and nothing dragged a CommonJS build-time dependency in with it.
        expect(code, artifact).not.toContain('Dynamic require of "');
      }

      // OpenCode loads its plugin as a module, so plain Node must be able to
      // import the artifact — a bundled CommonJS dependency throws on import.
      // Spawned rather than imported in-process: vitest routes import()
      // through vite-node, which resolves and transforms differently than
      // Node, so an in-process import would not test the stated contract.
      const artifact = pathToFileURL(
        join(project, "dist/opencode/.opencode/plugins/hooknostic.js"),
      ).href;
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
        { cwd: project, encoding: "utf8", stdio: "pipe", timeout: 60_000 },
      );
      expect(load.status, `stdout:\n${load.stdout}\nstderr:\n${load.stderr}`).toBe(0);
    },
  );
});
