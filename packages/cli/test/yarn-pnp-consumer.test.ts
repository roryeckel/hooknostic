import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runProcess } from "./harness-playback.js";

/** The Yarn release the projects pin through `packageManager`; corepack fetches it. */
const YARN = "yarn@4.18.1";

/** The release the skewed consumer's SDK is repacked as: not the CLI's, so HN110 applies. */
const SKEWED_SDK = "0.11.9";

/** A consumer: its own `zod`, if any, and whether its SDK is repacked as {@link SKEWED_SDK}. */
interface Consumer {
  zod?: string;
  skewedSdk?: true;
}

const PROJECTS = {
  "no-zod": {},
  "zod-3.24.4": { zod: "3.24.4" },
  "zod-3.25.76": { zod: "3.25.76" },
  "zod-4.6.7": { zod: "4.6.7" },
  // HN110 wherever the project's SDK resolves, naming Yarn's install rather
  // than its cache path (#225), and a guard on #216 under yarn dlx.
  "skew-4.6.7": { zod: "4.6.7", skewedSdk: true },
} as const satisfies Record<string, Consumer>;
type Project = keyof typeof PROJECTS;

/** How a run turned out, compared as a whole so a failure shows every cell. */
interface Outcome {
  /** The process's exit code: Hooknostic exits 2 for a build with errors. */
  exit: number | null;
  hn504: number;
  hn109: number;
  /**
   * One entry per HN110: whether it names the SDK by Yarn's Plug'n'Play
   * install, or by a path, which in Yarn's cache differs by machine (#225).
   */
  hn110: ("install" | "path")[];
  /**
   * Whose Zod the Claude runtime bundles, per zod archive: the project's
   * version, or another, the CLI's own. In one shared cache the project's
   * in-range 4.6.7 and the CLI's (4.6.7 is the newest release in the SDK's
   * range) are the same archive, so that cell asserts one copy, in range.
   */
  zod: ("project" | "cli")[];
}

const ok = (hn109: number, zod: Outcome["zod"], hn110: Outcome["hn110"] = []): Outcome => ({
  exit: 0,
  hn504: 0,
  hn109,
  hn110,
  zod,
});
const hn504: Outcome = { exit: 2, hn504: 1, hn109: 0, hn110: [], zod: [] };

/**
 * The network tokens a registry fetch or download failure leaves in Yarn's,
 * corepack's or npm's output (Yarn exits 1 for it, never 2 as Hooknostic
 * does). Yarn's own codes say nothing on their own: YN0013 is the fetch step
 * of every install, and YN0001 is any exception, a missing `file:` tarball
 * included. Node's socket errors (`ERR_SOCKET_CLOSED_BEFORE_CONNECTION`) are
 * what Yarn printed against an unreachable registry.
 */
const NETWORK_FAILURE =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\bERR_SOCKET_\w+|Error when performing the request|\bSSL\b|CERT_/;

/** Whether a failed step's output shows a network failure rather than a product one. */
function isNetworkFailure(output: string): boolean {
  return NETWORK_FAILURE.test(output);
}

describe("the opt-in Yarn check's network classifier", () => {
  it("does not take a successful install's fetch step for a network failure", () => {
    const log = [
      "➤ YN0000: · Yarn 4.18.1",
      "➤ YN0000: ┌ Fetch step",
      "➤ YN0013: │ A package was added to the project (+ 1.2 MiB).",
      "➤ YN0000: └ Completed in 0s 412ms",
    ].join("\n");
    expect(isNetworkFailure(log)).toBe(false);
  });

  it("does not take a missing file: tarball for a network failure", () => {
    const log = [
      "➤ YN0000: ┌ Resolution step",
      "➤ YN0001: │ Error: hooknostic@file:/tmp/packs/hooknostic-0.12.0.tgz: ENOENT: no such file or directory, " +
        "stat '/tmp/packs/hooknostic-0.12.0.tgz'",
      "➤ YN0000: └ Completed",
    ].join("\n");
    expect(isNetworkFailure(log)).toBe(false);
  });

  it("takes a socket closed before connecting for a network failure", () => {
    // As Yarn 4.18.1 printed it against an unreachable registry.
    const log =
      "➤ YN0001: │ Error [ERR_SOCKET_CLOSED_BEFORE_CONNECTION]: Socket closed before the connection was established";
    expect(isNetworkFailure(log)).toBe(true);
  });

  it("takes a reset connection for a network failure", () => {
    expect(isNetworkFailure("➤ YN0001: │ RequestError: read ECONNRESET")).toBe(true);
  });

  it("takes a TLS teardown for a network failure", () => {
    // As Yarn 4.18.1 printed it when a download was cut off.
    expect(isNetworkFailure("➤ YN0001: │ Error: write ECANCELED Canceled because of SSL destruction")).toBe(true);
  });
});

/**
 * Under the project's own Yarn runtime, the SDK takes the project's in-range
 * Zod and the CLI's otherwise, and the project's SDK resolves, so a skewed
 * one warns HN110, naming Yarn's install rather than its cache path (#225).
 */
const underYarnRuntime: Record<Project, Outcome> = {
  "no-zod": ok(0, ["cli"]),
  "zod-3.24.4": ok(1, ["cli"]),
  "zod-3.25.76": ok(1, ["cli"]),
  "zod-4.6.7": ok(0, ["project"]),
  "skew-4.6.7": ok(0, ["project"], ["install"]),
};

const EXPECTED: Record<string, Record<Project, Outcome>> = {
  "yarn hooknostic": underYarnRuntime,
  "node -r .pnp.cjs": underYarnRuntime,
  // npx, a global install, pnpm dlx: Hooknostic outside the project, without
  // Yarn's runtime. Node cannot resolve the project's SDK, so HN110 is silent.
  "plain node": {
    "no-zod": hn504,
    "zod-3.24.4": hn504,
    "zod-3.25.76": hn504,
    "zod-4.6.7": hn504,
    "skew-4.6.7": hn504,
  },
  // Yarn's runtime, but the dlx install, which holds the CLI's own Zod, is not
  // in the project's manifest. HN110 stays silent there: looking up the
  // project's SDK would load the project's runtime beside dlx's, and break the
  // build in a shared global cache (#216).
  "yarn dlx": {
    "no-zod": hn504,
    "zod-3.24.4": hn504,
    "zod-3.25.76": hn504,
    "zod-4.6.7": ok(0, ["project"]),
    "skew-4.6.7": ok(0, ["project"]),
  },
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
      // One cache for every install and dlx run, so each archive downloads once.
      YARN_GLOBAL_FOLDER: join(root, "yarn-global"),
      YARN_ENABLE_GLOBAL_CACHE: "true",
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
      const output = result.stdout + result.stderr;
      // A failed download is the environment, not a missing HN504: stop here and say so.
      if (command !== process.execPath && result.code !== 0 && result.code !== 2 && isNetworkFailure(output))
        throw new Error(
          `ENVIRONMENT/NETWORK FAILURE, not a Hooknostic result: \`${command} ${args.join(" ")}\` in ${cwd} ` +
            `exited ${result.code} on a fetch or network error. Rerun when the registry is reachable.\n${output}`,
        );
      return { code: result.code, output };
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
      // The same SDK under another release's version. Paths stay relative to
      // the working directory: GNU tar takes a drive letter's colon for a host.
      await mkdir(join(root, "repack"));
      await must("tar", ["-xzf", `packs/${basename(sdk)}`, "-C", "repack"], root);
      const repackedManifest = join(root, "repack", "package", "package.json");
      const manifest = JSON.parse(await readFile(repackedManifest, "utf8")) as { version: string };
      await writeFile(repackedManifest, JSON.stringify({ ...manifest, version: SKEWED_SDK }, null, 2));
      const skewedSdk = join(root, `hooknostic-sdk-${SKEWED_SDK}.tgz`);
      await must("tar", ["-czf", basename(skewedSdk), "-C", "repack", "package"], root);

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
      for (const [name, consumer] of Object.entries(PROJECTS) as [Project, Consumer][]) {
        const { zod } = consumer;
        const projectSdk = consumer.skewedSdk ? skewedSdk : sdk;
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
              "@hooknostic/sdk": `file:${projectSdk}`,
              hooknostic: `file:${cli}`,
              ...(zod === undefined ? {} : { zod }),
            },
            resolutions: { "@hooknostic/sdk": `file:${projectSdk}` },
          }),
        );
        await writeFile(
          join(project, ".yarnrc.yml"),
          "nodeLinker: pnp\nenableGlobalCache: true\nenableTelemetry: false\n",
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
          // esbuild names each module by its path: in Yarn's cache, an archive
          // whose name carries the version.
          const packages = new Set(
            [...runtime.matchAll(/^\/\/ (\S*?node_modules\/zod)\//gm)].map((match) => match[1]!),
          );
          (observed[mode] ??= {})[name] = {
            exit: result.code,
            hn504: (result.output.match(/^HN504 /gm) ?? []).length,
            hn109: (result.output.match(/^HN109 /gm) ?? []).length,
            // Each diagnostic is a heading line and its indented message
            // below, so classify each HN110's whole block.
            hn110: result.output
              .split(/^(?=HN\d{3} )/m)
              .filter((block) => block.startsWith("HN110 "))
              .map((block) => (block.includes("from Yarn's Plug'n'Play install") ? "install" : "path")),
            zod: [...packages].map((path) => {
              // A Zod outside Yarn's cache, such as the npm-installed CLI's, is never the project's.
              const version = /\/zod-npm-(\d+\.\d+\.\d+)-/.exec(path)?.[1];
              return version !== undefined && version === zod ? "project" : "cli";
            }),
          };
          if (process.env["HOOKNOSTIC_YARN_PNP_VERBOSE"] === "1")
            console.log(
              `--- ${name} / ${mode} (exit ${result.code}), zod: ${[...packages].join(", ")}\n${result.output}`,
            );
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
