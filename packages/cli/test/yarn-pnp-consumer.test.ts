import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runProcess } from "./harness-playback.js";
import { report } from "./report.js";

/** The Yarn release the projects pin through `packageManager`; corepack fetches it. */
const YARN = "yarn@4.18.1";

/** The release the skewed consumer's SDK is repacked as: not the CLI's, so HN110 applies. */
const SKEWED_SDK = "0.11.9";

/**
 * A consumer: its own `zod`, if any, whether its SDK is repacked as
 * {@link SKEWED_SDK}, and whether it builds {@link MCP_CONFIG} instead of
 * `examples/basic`'s config.
 */
interface Consumer {
  zod?: string;
  skewedSdk?: true;
  mcp?: true;
}

const PROJECTS = {
  "no-zod": {},
  "zod-3.24.4": { zod: "3.24.4" },
  "zod-3.25.76": { zod: "3.25.76" },
  "zod-4.6.7": { zod: "4.6.7" },
  // HN110 wherever the project's SDK resolves, naming Yarn's install rather
  // than its cache path (#225), and a guard on #216 under yarn dlx.
  "skew-4.6.7": { zod: "4.6.7", skewedSdk: true },
  // An MCP component, whose launcher bundles cross-spawn and its
  // dependencies, each in its own archive in Yarn's global cache (#224).
  "mcp-4.6.7": { zod: "4.6.7", mcp: true },
} as const satisfies Record<string, Consumer>;
type Project = keyof typeof PROJECTS;

/**
 * The smallest config that projects an MCP component through the launcher:
 * `examples/local-project`'s stdio server, delivered to one Claude project
 * target. Its output stays under `dist/claude`, so every cell's cleanup and
 * Zod scan cover it as they do the other consumers'.
 */
const MCP_CONFIG = `import { defineConfig } from "@hooknostic/sdk";

export default defineConfig({
  project: { root: "." },
  entry: "./src/hooks.ts",
  components: { mcp: "./mcp.json" },
  compatibility: {
    minimum: "emulated",
    onBelowMinimum: "error",
    optionalUnavailable: "info",
  },
  targets: {
    claude: { version: ">=2.1 <3", delivery: "project", output: "./dist/claude" },
  },
});
`;

/** Where {@link MCP_CONFIG}'s launcher is written, relative to the project. */
const MCP_LAUNCHER = ["dist", "claude", "mcp-launcher.mjs"];

/**
 * How HN109 and HN110 name a package Yarn's Plug'n'Play install serves, in
 * place of its cache path. A literal: this suite does not import core's internals.
 */
const PNP_INSTALL = "from Yarn's Plug'n'Play install";

/** Whether a diagnostic names a package by {@link PNP_INSTALL} or by a path. */
type Named = "install" | "path";

const named = (text: string): Named => (text.includes(PNP_INSTALL) ? "install" : "path");

/** How a run turned out, compared as a whole so a failure shows every cell. */
interface Outcome {
  /** The process's exit code: Hooknostic exits 2 for a build with errors. */
  exit: number | null;
  hn504: number;
  /** An artifact that failed to build, such as an MCP launcher esbuild could not bundle (#224). */
  hn301: number;
  /**
   * One entry per HN109, `<reached>/<own>`: whether it names the Zod the SDK
   * reached, then Hooknostic's own Zod bundled instead, by Yarn's Plug'n'Play
   * install or by a path, which in Yarn's cache differs by machine (#256).
   */
  hn109: `${Named}/${Named}`[];
  /**
   * One entry per HN110: whether it names the SDK by Yarn's Plug'n'Play
   * install, or by a path, which in Yarn's cache differs by machine (#225).
   */
  hn110: Named[];
  /**
   * Whose Zod the Claude runtime bundles, per zod archive: the project's
   * version, or another, the CLI's own. In one shared cache the project's
   * in-range 4.6.7 and the CLI's (4.6.7 is the newest release in the SDK's
   * range) are the same archive, so that cell asserts one copy, in range.
   */
  zod: ("project" | "cli")[];
  /**
   * The MCP consumer only: whether the built launcher, started with its
   * server's index from the project directory, answered an MCP `initialize`
   * through the sample server
   * (`responds`), was not built (`missing`), or was built and gave no answer
   * (`silent`).
   */
  mcp?: "responds" | "missing" | "silent";
}

const ok = (hn109: Outcome["hn109"], zod: Outcome["zod"], hn110: Outcome["hn110"] = []): Outcome => ({
  exit: 0,
  hn504: 0,
  hn301: 0,
  hn109,
  hn110,
  zod,
});
const hn504: Outcome = { exit: 2, hn504: 1, hn301: 0, hn109: [], hn110: [], zod: [] };

/**
 * Each HN109 in `output`, by how it names the reached Zod and Hooknostic's
 * own. Each diagnostic is a heading line and its indented message below, so
 * each HN109's whole block is split at the clause that turns to Hooknostic's
 * own Zod, and a block that does not split in two fails the run.
 */
function hn109Blocks(output: string): Outcome["hn109"] {
  return blocks(output, "HN109").map((block) => {
    const halves = block.split("; the runtime bundles");
    if (halves.length !== 2 || halves.some((half) => half.trim() === ""))
      throw new Error(`an HN109 that does not name its two Zods apart:\n${block}`);
    return `${named(halves[0]!)}/${named(halves[1]!)}` as const;
  });
}

/** Every `code` diagnostic in `output`: its heading line and the indented message below. */
function blocks(output: string, code: string): string[] {
  return output.split(/^(?=HN\d{3} )/m).filter((block) => block.startsWith(`${code} `));
}

/** The MCP launcher's `initialize`, as a client sends it. */
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hooknostic-yarn-pnp-check", version: "0.0.0" },
  },
};

/** Whether one line of the launcher's output is the sample server's reply to {@link INITIALIZE}. */
function isInitializeReply(line: string): boolean {
  try {
    const reply = JSON.parse(line) as { id?: unknown; result?: { serverInfo?: { name?: unknown } } };
    return reply.id === INITIALIZE.id && reply.result?.serverInfo?.name === "sample";
  } catch {
    return false;
  }
}

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

describe("the opt-in Yarn check's HN109 classifier", () => {
  const heading = "HN109 SDK's Zod outside its peer range [warn]\n\n";
  const message = (reached: string, own: string) =>
    `  the SDK's zod import reached zod@3.24.4 ${reached}, outside the SDK's zod peer range ^4.6.7; ` +
    `the runtime bundles Hooknostic's own zod@4.6.7 ${own} instead, while user code that imports zod ` +
    "still bundles the project's copy.\n  install a zod that satisfies ^4.6.7 in the project.\n";

  it("names each Zod apart, the reached one first", () => {
    const output =
      `${heading}${message(PNP_INSTALL, "from /tmp/npm-cli/node_modules/zod")}\n` +
      `${heading}${message("at node_modules/zod (relative to the config's directory)", PNP_INSTALL)}\n` +
      "HN110 something else [warn]\n\n  from Yarn's Plug'n'Play install\n";
    expect(hn109Blocks(output)).toEqual(["install/path", "path/install"]);
  });

  it("fails on an HN109 it cannot split in two", () => {
    expect(() => hn109Blocks(`${heading}  the SDK's zod import reached zod@3.24.4 ${PNP_INSTALL}.\n`)).toThrow(
      /does not name its two Zods apart/,
    );
  });
});

/**
 * Under the project's own Yarn runtime, the SDK takes the project's in-range
 * Zod and the CLI's otherwise, and the project's SDK resolves, so a skewed
 * one warns HN110, naming Yarn's install rather than its cache path (#225).
 * An out-of-range Zod warns HN109, which names the project's Zod by Yarn's
 * install, and the CLI's own as `own` says (#256).
 */
const underYarnRuntime = (own: Named): Record<Project, Outcome> => ({
  "no-zod": ok([], ["cli"]),
  "zod-3.24.4": ok([`install/${own}`], ["cli"]),
  "zod-3.25.76": ok([`install/${own}`], ["cli"]),
  "zod-4.6.7": ok([], ["project"]),
  "skew-4.6.7": ok([], ["project"], ["install"]),
  // The launcher's dependencies resolve through the runtime that loaded the
  // CLI, not esbuild's manifest lookup from cross-spawn's archive (#224).
  "mcp-4.6.7": { ...ok([], ["project"]), mcp: "responds" },
});

const EXPECTED: Record<string, Record<Project, Outcome>> = {
  "yarn hooknostic": underYarnRuntime("install"),
  // The CLI npm installed outside the project: its own Zod is a real path.
  "node -r .pnp.cjs": underYarnRuntime("path"),
  // npx, a global install, pnpm dlx: Hooknostic outside the project, without
  // Yarn's runtime. Node cannot resolve the project's SDK, so HN110 is silent.
  "plain node": {
    "no-zod": hn504,
    "zod-3.24.4": hn504,
    "zod-3.25.76": hn504,
    "zod-4.6.7": hn504,
    "skew-4.6.7": hn504,
    // A build with HN504 commits no artifacts, and the cell's cleanup leaves
    // no launcher from the previous mode to answer.
    "mcp-4.6.7": { ...hn504, mcp: "missing" },
  },
  // Yarn's runtime, but the dlx install, which holds the CLI's own Zod, is not
  // in the project's manifest. HN110 stays silent there: looking up the
  // project's SDK would load the project's runtime beside dlx's, and break the
  // build in a shared global cache (#216).
  "yarn dlx": {
    "no-zod": hn504,
    "zod-3.24.4": hn504,
    "zod-3.25.76": hn504,
    "zod-4.6.7": ok([], ["project"]),
    "skew-4.6.7": ok([], ["project"]),
    "mcp-4.6.7": { ...ok([], ["project"]), mcp: "responds" },
  },
};

/**
 * The consumer that also synchronizes a repository-local integration through
 * `yarn hooknostic`: in range, so its builds print no HN109 or HN110.
 */
const SYNCED: Project = "zod-4.6.7";

/**
 * How `init --local`, `sync`, a second `sync` and `verify` exited, whether
 * the integration's state was written where the lock is looked for, and
 * whether the lock remained (#229).
 */
interface Synced {
  init: number | null;
  sync: number | null;
  resync: number | null;
  verify: number | null;
  state: boolean;
  lock: boolean;
}

/** Whether anything is at `path`. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every file under `directory`, recursively. */
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

it("reports its diagnostics through stderr, which every reporter shows on a passing run", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    report("--- probe");
    expect(stderr).toHaveBeenCalledWith("--- probe\n");
    expect(log).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    log.mockRestore();
  }
});

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
    // Start the built launcher for server 0 from the project directory, send
    // one `initialize` and close its input, so the sample server answers and exits.
    // A launcher that hangs is killed with the server it started, which would
    // otherwise hold the project directory open, and reads as silent.
    const launch = async (project: string): Promise<NonNullable<Outcome["mcp"]>> => {
      const launcher = join(project, ...MCP_LAUNCHER);
      if (!(await exists(launcher))) return "missing";
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((settle) => {
        const child = spawn(process.execPath, [launcher, "0"], {
          cwd: project,
          env,
          // Its own process group, so a timeout can kill the server with it.
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        // A promise settles once: a late `close` or `error` after this is ignored.
        const timer = setTimeout(() => {
          stderr += "\n(timed out: killed with its process tree)";
          if (child.pid === undefined) child.kill();
          else if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
          else
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // The group is gone already, or never formed: kill the launcher alone.
              child.kill("SIGKILL");
            }
          // Do not wait on pipes the kill may not have released.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          settle({ code: null, stdout, stderr });
        }, 60_000);
        child.on("error", (error) => {
          clearTimeout(timer);
          settle({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          settle({ code, stdout, stderr });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(INITIALIZE) + "\n");
      });
      const responds = result.stdout.split(/\r?\n/).some(isInitializeReply);
      if (!responds || process.env["HOOKNOSTIC_YARN_PNP_VERBOSE"] === "1")
        report(`--- launcher in ${project} (exit ${result.code})\n${result.stdout}${result.stderr}`);
      return responds ? "responds" : "silent";
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
      let synced: Synced | undefined;
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
        if (consumer.mcp) {
          await writeFile(join(project, "hooknostic.config.ts"), MCP_CONFIG);
          for (const file of ["mcp.json", "sample-server.mjs"])
            await cp(join(repo, "examples", "local-project", file), join(project, file));
        } else await cp(join(repo, "examples", "basic", "hooknostic.config.ts"), join(project, "hooknostic.config.ts"));
        await cp(join(repo, "examples", "basic", "src", "hooks.ts"), join(project, "src", "hooks.ts"));
        await must("corepack", ["yarn", "install"], project);

        for (const [mode, invoke] of Object.entries(modes)) {
          await rm(join(project, "dist"), { recursive: true, force: true });
          // No cell may observe a previous mode's output, a launcher above all.
          expect(await files(join(project, "dist")), `${name} / ${mode}: dist/ before the build`).toEqual([]);
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
            // Counted by heading line: esbuild's text below it may span lines.
            hn301: (result.output.match(/^HN301 /gm) ?? []).length,
            hn109: hn109Blocks(result.output),
            hn110: blocks(result.output, "HN110").map(named),
            zod: [...packages].map((path) => {
              // A Zod outside Yarn's cache, such as the npm-installed CLI's, is never the project's.
              const version = /\/zod-npm-(\d+\.\d+\.\d+)-/.exec(path)?.[1];
              return version !== undefined && version === zod ? "project" : "cli";
            }),
            ...(consumer.mcp ? { mcp: await launch(project) } : {}),
          };
          if (process.env["HOOKNOSTIC_YARN_PNP_VERBOSE"] === "1")
            report(
              `--- ${name} / ${mode} (exit ${result.code}), zod: ${[...packages].join(", ")}` +
                `${consumer.mcp ? `, mcp: ${observed[mode][name]!.mcp}` : ""}\n${result.output}`,
            );
        }

        if (name === SYNCED) {
          // A config of init's own in a subdirectory, so the integration is
          // written there and the build cells' dist/ is left alone.
          await mkdir(join(project, "sync"));
          const config = ["--config", join("sync", "hooknostic.config.ts")];
          const step = async (label: string, args: string[]) => {
            const result = await run("corepack", ["yarn", "hooknostic", ...args, ...config], project);
            if (result.code !== 0 || process.env["HOOKNOSTIC_YARN_PNP_VERBOSE"] === "1")
              report(`--- ${name} / ${label} (exit ${result.code})\n${result.output}`);
            return result.code;
          };
          const present = (file: string) =>
            stat(join(project, "sync", ".hooknostic", file)).then(
              () => true,
              () => false,
            );
          synced = {
            init: await step("init", ["init", "--local"]),
            sync: await step("sync", ["sync"]),
            resync: await step("resync", ["sync"]),
            verify: await step("verify", ["verify"]),
            state: await present("integration.json"),
            lock: await present("sync.lock"),
          };
        }
      }
      report(JSON.stringify({ builds: observed, sync: synced }, null, 2));
      expect({ builds: observed, sync: synced }).toEqual({
        builds: EXPECTED,
        sync: { init: 0, sync: 0, resync: 0, verify: 0, state: true, lock: false } satisfies Synced,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
  1_800_000,
);
