import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { runProcess } from "./harness-playback.js";

/** The Yarn release the projects pin through `packageManager`; corepack fetches it. */
const YARN = "yarn@4.18.1";

/** Each consumer's own `zod`, if any. */
const PROJECTS = {
  "no-zod": undefined,
  "zod-3.24.4": "3.24.4",
  "zod-3.25.76": "3.25.76",
  "zod-4.6.7": "4.6.7",
} as const;
type Project = keyof typeof PROJECTS;

/** How a run turned out, compared as a whole so a failure shows every cell. */
interface Outcome {
  exit: "ok" | "failed";
  hn504: number;
  hn109: number;
  /** Whose Zod the Claude runtime bundles, per zod package: the project's, or the CLI's own. */
  zod: ("project" | "cli")[];
}

const ok = (hn109: number, zod: Outcome["zod"]): Outcome => ({ exit: "ok", hn504: 0, hn109, zod });
const hn504: Outcome = { exit: "failed", hn504: 1, hn109: 0, zod: [] };

/** Under Yarn's runtime, the SDK takes the project's in-range Zod and the CLI's otherwise. */
const underYarnRuntime: Record<Project, Outcome> = {
  "no-zod": ok(0, ["cli"]),
  "zod-3.24.4": ok(1, ["cli"]),
  "zod-3.25.76": ok(1, ["cli"]),
  "zod-4.6.7": ok(0, ["project"]),
};

const EXPECTED: Record<string, Record<Project, Outcome>> = {
  "yarn hooknostic": underYarnRuntime,
  "node -r .pnp.cjs": underYarnRuntime,
  // npx, a global install, pnpm dlx: Hooknostic outside the project, without Yarn's runtime.
  "plain node": { "no-zod": hn504, "zod-3.24.4": hn504, "zod-3.25.76": hn504, "zod-4.6.7": hn504 },
  // Yarn's runtime, but the dlx install, which holds the CLI's own Zod, is not in the project's manifest.
  "yarn dlx": { "no-zod": hn504, "zod-3.24.4": hn504, "zod-3.25.76": hn504, "zod-4.6.7": ok(0, ["project"]) },
};

/** Every file under `directory`, recursively. */
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

it.skipIf(process.env["HOOKNOSTIC_YARN_PNP"] !== "1")(
  "builds Yarn Plug'n'Play consumers through Yarn's runtime, and fails with HN504 outside it",
  async () => {
    const repo = resolve(import.meta.dirname, "../../..");
    const root = await mkdtemp(join(tmpdir(), "hooknostic-yarn-pnp-"));
    // Yarn, corepack and npm keep their state here, never in the user's home.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COREPACK_HOME: join(root, "corepack"),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      COREPACK_ENABLE_AUTO_PIN: "0",
      YARN_GLOBAL_FOLDER: join(root, "yarn-global"),
      YARN_ENABLE_GLOBAL_CACHE: "false",
      YARN_ENABLE_TELEMETRY: "0",
      YARN_NPM_MINIMAL_AGE_GATE: "0",
      npm_config_cache: join(root, "npm-cache"),
    };
    delete env["NODE_OPTIONS"];
    // `pnpm exec` points NODE_PATH at the workspace, where the CLI's lookup of
    // the project's SDK would find this repository's instead of the zip.
    delete env["NODE_PATH"];
    const run = async (command: string, args: string[], cwd: string) => {
      const result = await runProcess(command, args, { cwd, env, timeoutMs: 300_000 });
      return { code: result.code, output: result.stdout + result.stderr };
    };
    const must = async (command: string, args: string[], cwd: string) => {
      const result = await run(command, args, cwd);
      expect(result.code, `${command} ${args.join(" ")}\n${result.output}`).toBe(0);
    };
    try {
      const packs = join(root, "packs");
      for (const name of ["sdk", "cli"])
        await must("pnpm", ["pack", "--pack-destination", packs], join(repo, "packages", name));
      const tarballs = await readdir(packs);
      const sdk = join(
        packs,
        tarballs.find((file) => file.startsWith("hooknostic-sdk-"))!,
      );
      const cli = join(
        packs,
        tarballs.find((file) => /^hooknostic-\d/.test(file))!,
      );

      // The CLI installed outside every project, as npx or a global install has it.
      const outside = join(root, "npm-cli");
      await mkdir(outside);
      await writeFile(
        join(outside, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: { "@hooknostic/sdk": `file:${sdk}`, hooknostic: `file:${cli}` },
          overrides: { "@hooknostic/sdk": "$@hooknostic/sdk" },
        }),
      );
      await must("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], outside);
      const outsideBin = join(outside, "node_modules", "hooknostic", "bin", "hooknostic.mjs");

      const build = ["build", "--config", "hooknostic.config.ts"];
      const modes: Record<string, (project: string) => Promise<{ code: number | null; output: string }>> = {
        "yarn hooknostic": (project) => run("corepack", ["yarn", "hooknostic", ...build], project),
        "node -r .pnp.cjs": (project) =>
          run(process.execPath, ["-r", join(project, ".pnp.cjs"), outsideBin, ...build], project),
        "plain node": (project) => run(process.execPath, [outsideBin, ...build], project),
        "yarn dlx": (project) =>
          run("corepack", ["yarn", "dlx", "-q", "-p", `hooknostic@file:${cli}`, "hooknostic", ...build], project),
      };

      const observed: Record<string, Partial<Record<Project, Outcome>>> = {};
      for (const [name, zod] of Object.entries(PROJECTS) as [Project, string | undefined][]) {
        const project = join(root, name);
        await mkdir(join(project, "src"), { recursive: true });
        await writeFile(
          join(project, "package.json"),
          JSON.stringify({
            name: `yarn-pnp-${name}`,
            private: true,
            type: "module",
            packageManager: YARN,
            dependencies: {
              "@hooknostic/sdk": `file:${sdk}`,
              hooknostic: `file:${cli}`,
              ...(zod === undefined ? {} : { zod }),
            },
            resolutions: { "@hooknostic/sdk": `file:${sdk}` },
          }),
        );
        await writeFile(
          join(project, ".yarnrc.yml"),
          "nodeLinker: pnp\nenableGlobalCache: false\nenableTelemetry: false\n",
        );
        // Without a lockfile of its own, Yarn adopts an ancestor project, such as one in the user's home.
        await writeFile(join(project, "yarn.lock"), "");
        await cp(join(repo, "examples", "basic", "hooknostic.config.ts"), join(project, "hooknostic.config.ts"));
        await cp(join(repo, "examples", "basic", "src", "hooks.ts"), join(project, "src", "hooks.ts"));
        await must("corepack", ["yarn", "install"], project);

        for (const [mode, invoke] of Object.entries(modes)) {
          await rm(join(project, "dist"), { recursive: true, force: true });
          const result = await invoke(project);
          const runtime = (
            await Promise.all((await files(join(project, "dist", "claude"))).map((file) => readFile(file, "utf8")))
          ).join("\n");
          // esbuild names each module relative to the project. The CLI's Zod
          // can share the project's in-range version (4.6.7 is the newest
          // release in the SDK's range), so the version alone does not say
          // whose copy it is: the project's is in its own cache, at its version.
          const packages = new Set(
            [...runtime.matchAll(/^\/\/ (\S*?node_modules\/zod)\//gm)].map((match) => match[1]!),
          );
          (observed[mode] ??= {})[name] = {
            exit: result.code === 0 ? "ok" : "failed",
            hn504: (result.output.match(/^HN504 /gm) ?? []).length,
            hn109: (result.output.match(/^HN109 /gm) ?? []).length,
            zod: [...packages].map((path) =>
              path.startsWith(".yarn/") && /\/zod-npm-(\d+\.\d+\.\d+)-/.exec(path)?.[1] === zod ? "project" : "cli",
            ),
          };
          if (process.env["HOOKNOSTIC_YARN_PNP_VERBOSE"] === "1")
            console.log(`--- ${name} / ${mode} (exit ${result.code})\n${result.output}`);
        }
      }
      console.log(JSON.stringify(observed, null, 2));
      expect(observed).toEqual(EXPECTED);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
  1_800_000,
);
