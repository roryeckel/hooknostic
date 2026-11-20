import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { projectSdkRelease, projectSdkReleaseSkew } from "./build.js";
import { anotherInstallsPnpRuntime, nodeModulesHas, sdkReleaseSkew } from "./sdk-resolution.js";

const CLI = "0.12.0";
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A PnP manifest in an ancestor of the temporary directory would make every project here PnP. */
function strayPnpManifest(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const found = [".pnp.data.json", ".pnp.cjs", ".pnp.js"].find((name) => existsSync(join(current, name)));
    if (found !== undefined) return join(current, found);
    if (dirname(current) === current) return undefined;
  }
}

/**
 * A project whose SDK, at `location` (relative to the project or absolute;
 * `node_modules/@hooknostic/sdk` by default), has `manifest`; returns the
 * project and the SDK's entry.
 */
async function project(manifest: string, options: { pnp?: boolean; location?: string } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
  roots.push(root);
  const stray = strayPnpManifest(root);
  if (stray !== undefined) throw new Error(`precondition: no PnP manifest may be above ${tmpdir()}, but ${stray} is`);
  await writeFile(join(root, "package.json"), "{}");
  if (options.pnp) await writeFile(join(root, ".pnp.cjs"), "");
  const sdk = resolve(root, options.location ?? "node_modules/@hooknostic/sdk");
  await mkdir(join(sdk, "dist"), { recursive: true });
  await writeFile(join(sdk, "package.json"), manifest);
  await writeFile(join(sdk, "dist/index.js"), "export {};\n");
  return { root, sdk, entry: join(sdk, "dist/index.js") };
}

const sdkManifest = (version: unknown) =>
  JSON.stringify({
    name: "@hooknostic/sdk",
    type: "module",
    exports: { ".": "./dist/index.js" },
    ...(version === undefined ? {} : { version }),
  });

describe("sdkReleaseSkew (HN110)", () => {
  it("is silent when the project has no SDK", async () => {
    // The build passes undefined when resolveProjectSdk finds nothing.
    expect(sdkReleaseSkew(undefined, CLI, tmpdir())).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["numeric", 12],
    ["not semver", "latest"],
  ])("is silent when the SDK's version is unreadable (%s)", async (_, version) => {
    const { root, entry } = await project(sdkManifest(version));
    expect(sdkReleaseSkew(entry, CLI, root)).toBeUndefined();
  });

  it.each([
    ["0.12.0-rc.1", "0.12.0"],
    ["0.12.0", "0.12.0-rc.1"],
  ])("counts a prerelease as another release (SDK %s, CLI %s)", async (sdk, cli) => {
    const { root, entry } = await project(sdkManifest(sdk));
    expect(sdkReleaseSkew(entry, cli, root)).toMatchObject({ code: "HN110" });
  });

  it.each([
    ["0.12.0+local.1", "0.12.0"],
    ["0.12.0", "0.12.0+local.1"],
  ])("ignores build metadata (SDK %s, CLI %s)", async (sdk, cli) => {
    const { root, entry } = await project(sdkManifest(sdk));
    expect(sdkReleaseSkew(entry, cli, root)).toBeUndefined();
  });

  it("is silent when the package that owns the entry is not the SDK", async () => {
    // A vendored copy with no manifest of its own: the nearest named manifest
    // is the project's, whose version says nothing about the SDK.
    const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    const entry = join(root, "vendor/hooknostic-sdk/dist/index.js");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "export {};\n");
    expect(sdkReleaseSkew(entry, CLI, root)).toBeUndefined();
  });

  it("is silent when the CLI's own version is not semver", async () => {
    const { root, entry } = await project(sdkManifest("0.11.9"));
    expect(sdkReleaseSkew(entry, "workspace", root)).toBeUndefined();
  });

  it("names both versions, and an SDK inside the project by its relative path", async () => {
    const { root, entry } = await project(sdkManifest("0.13.0-rc.1"));
    const diagnostic = sdkReleaseSkew(entry, CLI, root);
    expect(diagnostic).toMatchObject({ code: "HN110", severity: "warn" });
    expect(diagnostic?.message).toContain(`this hooknostic is ${CLI}`);
    // Forward slashes on every platform: the build report may be committed.
    expect(diagnostic?.message).toContain(
      "@hooknostic/sdk at node_modules/@hooknostic/sdk (relative to the config's directory) is 0.13.0-rc.1,",
    );
    expect(diagnostic?.message).toContain("mixes one release's SDK with another release's compiler and shims");
  });

  it("names an SDK outside the project by its absolute path", async () => {
    // A config in a subdirectory that resolves an SDK installed above it.
    const { root, sdk, entry } = await project(sdkManifest("0.11.9"));
    const app = join(root, "app");
    await mkdir(app);
    expect(sdkReleaseSkew(entry, CLI, app)?.message).toContain(`@hooknostic/sdk at ${sdk} is 0.11.9,`);
  });

  /** A directory standing in for Yarn's global cache, outside every project. */
  async function globalCache() {
    const cache = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-global-"));
    roots.push(cache);
    return cache;
  }

  // Real directories named as Yarn names them: without Yarn's runtime nothing
  // can read inside a real zip archive, and HN110 would stay silent.
  it.each<[string, () => Promise<string>]>([
    // The project cache, as the testkit's synthetic PnP project lays it out.
    [
      "a zip in the project's cache",
      async () => ".yarn/cache/@hooknostic-sdk-npm-0.11.9-a1b2.zip/node_modules/@hooknostic/sdk",
    ],
    // A virtual path through the project into the global cache, as observed in
    // the opt-in Yarn check's (yarn-pnp-consumer.test.ts) Yarn 4.18.1 run on
    // Windows on 2026-11-19, for its file: SDK; not a committed capture.
    [
      "__virtual__ into the global cache",
      async () =>
        ".yarn/__virtual__/@hooknostic-sdk-virtual-323d0e602f/2/yarn-global/cache/@hooknostic-sdk-file-530e797bc7-10c0.zip/node_modules/@hooknostic/sdk",
    ],
    // Derived from Yarn's documented layout, not captured: an unplugged package behind a virtual path, no zip.
    [
      "an unplugged package behind __virtual__",
      async () =>
        ".yarn/__virtual__/@hooknostic-sdk-virtual-a1b2/0/unplugged/@hooknostic-sdk-npm-0.11.9-a1b2/node_modules/@hooknostic/sdk",
    ],
    // Derived from Yarn's documented layout, not captured: Yarn 2's virtual folder, no zip.
    [
      "Yarn 2's $$virtual",
      async () =>
        ".yarn/$$virtual/@hooknostic-sdk-virtual-a1b2/0/unplugged/@hooknostic-sdk-npm-0.11.9-a1b2/node_modules/@hooknostic/sdk",
    ],
    [
      "a zip in a global cache outside the project",
      async () => join(await globalCache(), "cache/@hooknostic-sdk-npm-0.11.9-a1b2.zip/node_modules/@hooknostic/sdk"),
    ],
  ])("names a Plug'n'Play SDK by its install, not its path (%s, #225)", async (_, location) => {
    // The path differs by machine (the virtual hash and depth, the global
    // cache's folder), and the build report that carries it may be committed.
    const { root, sdk, entry } = await project(sdkManifest("0.11.9"), { pnp: true, location: await location() });
    const message = sdkReleaseSkew(entry, CLI, root)?.message;
    expect(message).toContain("the project's @hooknostic/sdk from Yarn's Plug'n'Play install is 0.11.9,");
    expect(message).not.toMatch(/\.yarn|\.zip|virtual|relative to the config's directory/);
    expect(message).not.toContain(sdk);
  });

  it("names a Plug'n'Play SDK by its install from a workspace below the manifest (#225)", async () => {
    // A Yarn workspace: `.pnp.cjs` and `.yarn` are at the root, the config in
    // packages/app, so the SDK's virtual path is outside the config's directory.
    // The registry's archive, at the depth the issue shows.
    const { root, sdk, entry } = await project(sdkManifest("0.11.9"), {
      pnp: true,
      location:
        ".yarn/__virtual__/@hooknostic-sdk-virtual-a1b2/3/yarn-global/cache/@hooknostic-sdk-npm-0.11.9-a1b2.zip/node_modules/@hooknostic/sdk",
    });
    const app = join(root, "packages/app");
    await mkdir(app, { recursive: true });
    const message = sdkReleaseSkew(entry, CLI, app)?.message;
    expect(message).toContain("the project's @hooknostic/sdk from Yarn's Plug'n'Play install is 0.11.9,");
    expect(message).not.toContain(sdk);
  });

  it("keeps the path of a node_modules SDK in a Plug'n'Play project (#225)", async () => {
    // A PnP manifest alone says nothing about where this SDK is.
    const { root, entry } = await project(sdkManifest("0.11.9"), { pnp: true });
    expect(sdkReleaseSkew(entry, CLI, root)?.message).toContain(
      "@hooknostic/sdk at node_modules/@hooknostic/sdk (relative to the config's directory) is 0.11.9,",
    );
  });

  it("keeps the path of a directory named *.zip outside Plug'n'Play (#225)", async () => {
    const { root, entry } = await project(sdkManifest("0.11.9"), {
      location: "vendor.zip/node_modules/@hooknostic/sdk",
    });
    expect(sdkReleaseSkew(entry, CLI, root)?.message).toContain(
      "@hooknostic/sdk at vendor.zip/node_modules/@hooknostic/sdk (relative to the config's directory) is 0.11.9,",
    );
  });

  it("names an SDK relatively when the config's directory is reached through a link", async () => {
    // Node resolves the SDK to its real path, so a project reached through a
    // junction or symlink (macOS's tmpdir is one) is compared by its real path too.
    const { root, entry } = await project(sdkManifest("0.11.9"));
    const parent = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-link-"));
    const link = join(parent, "project");
    await symlink(root, link, "junction");
    try {
      expect(sdkReleaseSkew(entry, CLI, link)?.message).toContain(
        "@hooknostic/sdk at node_modules/@hooknostic/sdk (relative to the config's directory) is 0.11.9,",
      );
    } finally {
      // Unlink the junction itself: a recursive remove would descend into the project.
      await rm(link, { force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("points a node_modules project at npx or pnpm exec, and a Plug'n'Play project at yarn (#245)", async () => {
    const plain = await project(sdkManifest("0.11.9"));
    const npm = sdkReleaseSkew(plain.entry, CLI, plain.root)?.remediation;
    // The whole text: npx runs the project's CLI only once the project installs
    // one, and pnpm exec is offered only "in a pnpm project", since an npm user
    // may have no pnpm. npx refuses a project made by `pnpm init` (#245). Each
    // install command names the SDK's version, saved exactly (npm saves ^V
    // without --save-exact), and with no pnpm install state to read, pnpm's
    // command leaves out --allow-build, which pnpm before 10.4 refuses (#259).
    expect(npm).toBe(
      "add hooknostic to the project's devDependencies at the same version as its @hooknostic/sdk, " +
        "with `npm install --save-dev --save-exact hooknostic@0.11.9`, " +
        "or `pnpm add -D hooknostic@0.11.9` in a pnpm project, " +
        "and run that CLI from the project directory with `npx hooknostic` " +
        "(without a local install, npx fetches the registry's latest), " +
        "or `pnpm exec hooknostic` in a pnpm project.",
    );

    const pnp = await project(sdkManifest("0.11.9"), { pnp: true });
    const yarn = sdkReleaseSkew(pnp.entry, CLI, pnp.root)?.remediation;
    expect(yarn).toBe(
      "add hooknostic to the project's devDependencies at the same version as its @hooknostic/sdk, " +
        "with `yarn add -D hooknostic@0.11.9`, " +
        "and run `yarn hooknostic`, which runs that CLI (under Plug'n'Play, npx fetches the registry's latest).",
    );
    // pnpm exec would run the CLI outside Yarn's runtime, where the build fails with HN504.
    expect(yarn).not.toContain("pnpm");
  });

  // Trimmed from `node_modules/.modules.yaml` as pnpm wrote it in the
  // .capture/pnpm-pnp session: pnpm 11 and 12 write JSON, pnpm 9 and 10 YAML.
  const modulesYaml = (nodeLinker: string, pnpm: string, format: "json" | "yaml" = "json") =>
    format === "json"
      ? JSON.stringify(
          { hoistPattern: ["*"], layoutVersion: 5, nodeLinker, packageManager: `pnpm@${pnpm}`, pendingBuilds: [] },
          null,
          2,
        )
      : `hoistPattern:\n  - '*'\nhoistedDependencies: {}\nnodeLinker: ${nodeLinker}\npackageManager: pnpm@${pnpm}\n`;

  /** Write `files` (relative path to content) into `root`. */
  async function lay(root: string, files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }

  it("gives pnpm's install command --allow-build=esbuild only for a pnpm that accepts it (#259)", async () => {
    // pnpm 12 refuses esbuild's install script with ERR_PNPM_IGNORED_BUILDS
    // unless it is allowed; pnpm 9.15.9 and 10.3.0 exit 1 on the unknown
    // option, and 10.4.0 is the first whose `pnpm add --help` lists it.
    const cases: [string, "json" | "yaml", boolean][] = [
      ["12.21.0", "json", true],
      ["11.28.13", "json", true],
      ["10.4.0", "yaml", true],
      ["10.3.0", "yaml", false],
      ["9.15.9", "yaml", false],
    ];
    for (const [pnpm, format, allowed] of cases) {
      const { root, entry } = await project(sdkManifest("0.11.9"));
      await lay(root, { "node_modules/.modules.yaml": modulesYaml("isolated", pnpm, format) });
      const remediation = sdkReleaseSkew(entry, CLI, root)?.remediation;
      const command = allowed ? "pnpm add -D --allow-build=esbuild hooknostic@0.11.9" : "pnpm add -D hooknostic@0.11.9";
      expect(remediation, `pnpm ${pnpm}`).toContain(`\`${command}\` in a pnpm project`);
      if (!allowed) expect(remediation, `pnpm ${pnpm}`).not.toContain("allow-build");
    }
  });

  it("reads pnpm's install state from an ancestor, as from a workspace package (#259)", async () => {
    const { root, entry } = await project(sdkManifest("0.11.9"));
    await lay(root, { "node_modules/.modules.yaml": modulesYaml("isolated", "12.21.0") });
    const app = join(root, "packages/app");
    await mkdir(app, { recursive: true });
    expect(sdkReleaseSkew(entry, CLI, app)?.remediation).toContain(
      "`pnpm add -D --allow-build=esbuild hooknostic@0.11.9` in a pnpm project",
    );
  });

  it("does not let a record that names no pnpm release hide an ancestor's (#259)", async () => {
    // An interrupted or hand-edited record nearer the config: the flag the
    // root's pnpm 12 needs must not be dropped for it.
    const { root, entry } = await project(sdkManifest("0.11.9"));
    const app = join(root, "packages/app");
    await lay(root, {
      "node_modules/.modules.yaml": modulesYaml("isolated", "12.21.0"),
      "packages/app/node_modules/.modules.yaml": JSON.stringify({ layoutVersion: 5, nodeLinker: "isolated" }),
    });
    expect(sdkReleaseSkew(entry, CLI, app)?.remediation).toContain(
      "`pnpm add -D --allow-build=esbuild hooknostic@0.11.9` in a pnpm project",
    );
  });

  it.each([
    ["one-line JSON", '{"nodeLinker":"pnp","packageManager":"pnpm@12.21.0"}'],
    ["YAML's flow form", "{nodeLinker: pnp, packageManager: pnpm@12.21.0}\n"],
  ])("reads pnpm's record written as %s (#259)", async (_, record) => {
    // No lockfile: the record alone says pnpm, and which release.
    const { root, entry } = await project(sdkManifest("0.11.9"), { pnp: true });
    await lay(root, { "node_modules/.modules.yaml": record });
    expect(sdkReleaseSkew(entry, CLI, root)?.remediation).toContain(
      "with `pnpm add -D --allow-build=esbuild hooknostic@0.11.9`, and run it with `pnpm exec hooknostic`.",
    );
  });

  it("points a pnpm node-linker=pnp project at pnpm exec, not yarn (#259)", async () => {
    // pnpm 12.21.0 with `nodeLinker: pnp` writes .pnp.cjs beside pnpm-lock.yaml
    // and node_modules/.modules.yaml, and serves packages from real
    // directories under node_modules/.pnpm (.capture/pnpm-pnp).
    const { root, entry } = await project(sdkManifest("0.11.9"), { pnp: true });
    await lay(root, {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "node_modules/.modules.yaml": modulesYaml("pnp", "12.21.0"),
    });
    expect(sdkReleaseSkew(entry, CLI, root)?.remediation).toBe(
      "add hooknostic to the project's devDependencies at the same version as its @hooknostic/sdk, " +
        "with `pnpm add -D --allow-build=esbuild hooknostic@0.11.9`, and run it with `pnpm exec hooknostic`.",
    );
  });

  it.each<[string, Record<string, string>]>([
    ["by its install state alone", { "node_modules/.modules.yaml": modulesYaml("pnp", "12.21.0") }],
    // pnpm 9 and 10 write the record as YAML.
    ["by a YAML install state alone", { "node_modules/.modules.yaml": modulesYaml("pnp", "10.4.0", "yaml") }],
    // A project moved from Yarn with `pnpm import`, which needs yarn.lock and
    // leaves it beside pnpm's lockfile, .pnp.cjs and record (.capture/pnpm-pnp,
    // Session 3). The record wins: Yarn's install deletes it (YN0031).
    [
      "by its install state beside a yarn.lock left by pnpm import",
      {
        "yarn.lock": "",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "node_modules/.modules.yaml": modulesYaml("pnp", "12.21.0"),
      },
    ],
  ])("tells pnpm's Plug'n'Play from Yarn's %s (#259)", async (_, files) => {
    const { root, entry } = await project(sdkManifest("0.11.9"), { pnp: true });
    await lay(root, files);
    const remediation = sdkReleaseSkew(entry, CLI, root)?.remediation;
    expect(remediation).toContain("`pnpm add -D --allow-build=esbuild hooknostic@0.11.9`");
    expect(remediation).toContain("`pnpm exec hooknostic`");
    expect(remediation).not.toContain("yarn");
  });

  it("keeps --allow-build with a note when only pnpm-lock.yaml says pnpm (#259)", async () => {
    // node_modules deleted for a clean reinstall: the lockfile still says pnpm,
    // but nothing records which pnpm. pnpm 12 needs the flag, and pnpm before
    // 10.4 refuses it, so the advice says both.
    const { root, entry } = await project(sdkManifest("0.11.9"), { pnp: true });
    await lay(root, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    expect(sdkReleaseSkew(entry, CLI, root)?.remediation).toBe(
      "add hooknostic to the project's devDependencies at the same version as its @hooknostic/sdk, " +
        "with `pnpm add -D --allow-build=esbuild hooknostic@0.11.9` (without `--allow-build=esbuild` before pnpm 10.4), " +
        "and run it with `pnpm exec hooknostic`.",
    );
  });

  it.each<[string, Record<string, string>]>([
    // Yarn 4.18.1's own layout (.capture/pnpm-pnp): .pnp.cjs, yarn.lock, .yarn, no node_modules.
    ["Yarn's own layout", { "yarn.lock": "", ".yarn/install-state.gz": "" }],
    // An isolated record says pnpm did not write the manifest.
    [
      "a stale isolated pnpm install state",
      { "yarn.lock": "", "node_modules/.modules.yaml": modulesYaml("isolated", "12.21.0") },
    ],
    // With no record, yarn.lock vetoes the pnpm-lock.yaml fallback.
    ["both lockfiles", { "yarn.lock": "", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }],
  ])("keeps a Yarn Plug'n'Play project on yarn with %s (#259)", async (_, files) => {
    const { root, entry } = await project(sdkManifest("0.11.9"), { pnp: true });
    await lay(root, files);
    const remediation = sdkReleaseSkew(entry, CLI, root)?.remediation;
    expect(remediation).toContain("`yarn add -D hooknostic@0.11.9`");
    expect(remediation).not.toContain("pnpm");
  });

  it("names the SDK's version, not the CLI's, without build metadata (#259)", async () => {
    const { root, entry } = await project(sdkManifest("0.11.9+local.1"));
    const remediation = sdkReleaseSkew(entry, CLI, root)?.remediation;
    expect(remediation).toContain("`npm install --save-dev --save-exact hooknostic@0.11.9`");
    expect(remediation).not.toContain("+local");
    expect(remediation).not.toContain(CLI);
  });
});

// The walk doctor's SDK lookup gates on (#246), as esbuild walks a bare specifier.
describe("nodeModulesHas", () => {
  it("needs the package's manifest, not just its folder", async () => {
    // Node's lookup walks past a folder without a package.json, on to
    // NODE_PATH, which esbuild never searches.
    const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
    roots.push(root);
    await mkdir(join(root, "node_modules/@hooknostic/sdk/dist"), { recursive: true });
    expect(nodeModulesHas(root, "@hooknostic/sdk")).toBe(false);
    await writeFile(join(root, "node_modules/@hooknostic/sdk/package.json"), sdkManifest("0.0.1-test"));
    expect(nodeModulesHas(root, "@hooknostic/sdk")).toBe(true);
  });

  it("skips a directory that is itself named node_modules, as esbuild and Node do", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
    roots.push(root);
    const named = join(root, "node_modules");
    await mkdir(join(named, "node_modules/@hooknostic/sdk"), { recursive: true });
    await writeFile(join(named, "node_modules/@hooknostic/sdk/package.json"), sdkManifest("0.0.1-test"));
    expect(nodeModulesHas(named, "@hooknostic/sdk")).toBe(false);
    // The same layout under an ordinary name is found.
    const plain = join(root, "app");
    await mkdir(join(plain, "node_modules/@hooknostic/sdk"), { recursive: true });
    await writeFile(join(plain, "node_modules/@hooknostic/sdk/package.json"), sdkManifest("0.0.1-test"));
    expect(nodeModulesHas(plain, "@hooknostic/sdk")).toBe(true);
  });
});

// The project SDK's release, as doctor reports it (#246); the runtime cases
// are under "under Yarn's runtime" below, beside the runtime they simulate.
describe("projectSdkRelease", () => {
  it("reports the version from the SDK's own manifest", async () => {
    const { root } = await project(sdkManifest("0.0.1-test"));
    expect(projectSdkRelease(root)).toEqual({ status: "found", version: "0.0.1-test" });
  });

  it("reports a project with no node_modules/@hooknostic/sdk as not found, whatever NODE_PATH reaches", async () => {
    // vitest's bin shim puts pnpm's hoisted packages, this workspace's SDK
    // among them, on NODE_PATH, as pnpm's shims do for a consumer's CLI; the
    // build's esbuild never searches it. doctor.test.ts pins a NODE_PATH that
    // does not depend on how vitest was started.
    const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), "{}");
    expect(projectSdkRelease(root)).toEqual({ status: "not-found" });
  });

  it("finds an SDK installed in an ancestor's node_modules", async () => {
    const { root } = await project(sdkManifest("0.0.1-test"));
    const app = join(root, "packages/app");
    await mkdir(app, { recursive: true });
    expect(projectSdkRelease(app)).toEqual({ status: "found", version: "0.0.1-test" });
  });

  it("does not look the SDK up in a Plug'n'Play project outside Yarn's runtime (HN504's case)", async () => {
    // Node's resolution cannot see a PnP install without Yarn's runtime, so
    // "not found" would send a report the wrong way.
    const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@hooknostic/sdk": "0.0.1" } }));
    await writeFile(join(root, ".pnp.cjs"), "");
    expect(projectSdkRelease(root)).toEqual({
      status: "not-looked-up",
      reason: "outside-pnp-runtime",
      manifest: join(root, ".pnp.cjs"),
    });
  });

  it("still finds a node_modules SDK below a Plug'n'Play manifest outside Yarn's runtime", async () => {
    // A stray ancestor manifest above a node_modules project, as HN504 allows.
    const { root } = await project(sdkManifest("0.0.1-test"), { pnp: true });
    expect(projectSdkRelease(root)).toEqual({ status: "found", version: "0.0.1-test" });
  });

  it.each([
    ["has no version", sdkManifest(undefined)],
    ["has a version that is not a string", sdkManifest(12)],
    [
      "names another package",
      JSON.stringify({ name: "hooknostic-sdk-fork", version: "1.0.0", exports: { ".": "./dist/index.js" } }),
    ],
  ])("reports an SDK that resolves but whose manifest %s as unidentified", async (_, manifest) => {
    const { root } = await project(manifest);
    expect(projectSdkRelease(root)).toEqual({ status: "unidentified" });
  });
});

describe("projectSdkReleaseSkew (HN110)", () => {
  it("checks an absolute SDK alias, and the project's own SDK for a bare package name alias", async () => {
    const { root } = await project(sdkManifest("0.11.9"));
    const aliased = await project(sdkManifest("0.10.0"));
    expect(projectSdkReleaseSkew(root, { alias: { "@hooknostic/sdk": aliased.entry } })?.message).toContain(
      "is 0.10.0,",
    );
    // A bare name has no manifest to walk up from: walking from "." would read
    // whatever package the process runs in.
    expect(projectSdkReleaseSkew(root, { alias: { "@hooknostic/sdk": "hooknostic-sdk-fork" } })?.message).toContain(
      "is 0.11.9,",
    );
  });

  /**
   * A pnpm 12 `nodeLinker: pnp` project as .capture/pnpm-pnp records it: the
   * SDK linked into node_modules. Its manifest names `main`, as the SDK's has
   * since #259, unless `main` is false.
   */
  async function pnpmPnpProject(options: { main?: boolean } = {}) {
    const manifest = JSON.parse(sdkManifest("0.11.9")) as Record<string, unknown>;
    if (options.main !== false) manifest["main"] = "./dist/index.js";
    const created = await project(JSON.stringify(manifest), { pnp: true });
    await writeFile(join(created.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(
      join(created.root, "node_modules/.modules.yaml"),
      JSON.stringify({ layoutVersion: 5, nodeLinker: "pnp", packageManager: "pnpm@12.21.0" }, null, 2),
    );
    return created;
  }

  it("warns a pnpm node-linker=pnp project with pnpm's advice outside any runtime (#259)", async () => {
    // As captured for a CLI run with plain node, npx or a global install:
    // the SDK resolves through pnpm's node_modules link, and HN110 is shown.
    const { root } = await pnpmPnpProject();
    const diagnostic = projectSdkReleaseSkew(root);
    expect(diagnostic).toMatchObject({ code: "HN110" });
    expect(diagnostic?.remediation).toContain("`pnpm add -D --allow-build=esbuild hooknostic@0.11.9`");
    expect(diagnostic?.remediation).toContain("`pnpm exec hooknostic`");
    expect(diagnostic?.remediation).not.toContain("yarn");
  });

  describe("under Yarn's runtime", () => {
    const versions = process.versions as Record<string, string | undefined>;
    const nodeModule = Module as unknown as {
      findPnpApi?: (location: string) => unknown;
      _resolveFilename: (request: string, parent: { filename?: string } | undefined, ...rest: unknown[]) => string;
    };
    const originalResolve = nodeModule._resolveFilename;
    /** The paths `findPnpApi` was asked about, and the issuer of every resolution. */
    let asked: string[] = [];
    let issuers: string[] = [];

    /**
     * Yarn's runtime: `findPnpApi` returns the API serving a path, which lists
     * only paths under `listed`; with `ownOutside`, it returns null for a path
     * outside `listed`, as for a CLI outside every Yarn install.
     */
    function simulateRuntime(listed: string, options: { ownOutside?: boolean } = {}): void {
      versions["pnp"] = "3";
      nodeModule.findPnpApi = (location: string) => {
        asked.push(location);
        if (options.ownOutside && !location.startsWith(listed)) return null;
        return {
          findPackageLocator: (path: string) =>
            path.startsWith(listed) ? { name: "app", reference: "workspace:." } : null,
        };
      };
      nodeModule._resolveFilename = function (request, parent, ...rest) {
        if (parent?.filename !== undefined) issuers.push(parent.filename);
        return originalResolve.call(this, request, parent, ...rest);
      };
    }

    afterEach(() => {
      delete versions["pnp"];
      delete nodeModule.findPnpApi;
      nodeModule._resolveFilename = originalResolve;
      asked = [];
      issuers = [];
    });

    it("never resolves from a Plug'n'Play project under another install's runtime (yarn dlx, #216)", async () => {
      const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
      // Without Yarn's runtime the project's skewed SDK resolves and warns.
      expect(projectSdkReleaseSkew(root)).toMatchObject({ code: "HN110" });
      simulateRuntime(join(tmpdir(), "elsewhere-dlx"));
      // Under yarn dlx, a resolution from the project loads its PnP API beside
      // dlx's own, and esbuild's next lookup in a shared global cache fails.
      expect(projectSdkReleaseSkew(root)).toBeUndefined();
      expect(issuers.filter((issuer) => issuer.startsWith(root))).toEqual([]);
      // findPnpApi loads the API that serves the path it is asked about.
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.filter((location) => location.startsWith(root))).toEqual([]);
    });

    it("still warns under the project's own runtime (yarn hooknostic)", async () => {
      const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
      // The API serving the CLI is the project's, which lists the project.
      simulateRuntime(root);
      const diagnostic = projectSdkReleaseSkew(root);
      expect(diagnostic).toMatchObject({ code: "HN110" });
      expect(diagnostic?.message).toContain("is 0.11.9,");
    });

    it("still warns with a CLI outside every Yarn install under the project's runtime (node -r .pnp.cjs)", async () => {
      const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
      simulateRuntime(root, { ownOutside: true });
      const diagnostic = projectSdkReleaseSkew(root);
      expect(diagnostic).toMatchObject({ code: "HN110" });
      expect(diagnostic?.message).toContain("is 0.11.9,");
    });

    it("still warns in a node_modules project under yarn dlx", async () => {
      // No project manifest: Node's resolution from the project loads no API.
      const { root } = await project(sdkManifest("0.11.9"));
      simulateRuntime(join(tmpdir(), "elsewhere-dlx"));
      const diagnostic = projectSdkReleaseSkew(root);
      expect(diagnostic).toMatchObject({ code: "HN110" });
      expect(diagnostic?.message).toContain("is 0.11.9,");
    });

    it("is silent when Yarn throws for the CLI's own directory (several APIs already loaded)", async () => {
      const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
      expect(projectSdkReleaseSkew(root)).toMatchObject({ code: "HN110" });
      versions["pnp"] = "3";
      nodeModule.findPnpApi = () => {
        throw new Error("controlled by multiple pnpapi instances");
      };
      expect(projectSdkReleaseSkew(root)).toBeUndefined();
    });

    it("still warns under Yarn 2, which has no findPnpApi", async () => {
      const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
      versions["pnp"] = "3";
      expect(projectSdkReleaseSkew(root)).toMatchObject({ code: "HN110" });
    });

    // Doctor's version line looks the SDK up as HN110 does (#246).
    it("projectSdkRelease does not look the SDK up under another install's runtime (yarn dlx, #216)", async () => {
      const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
      expect(projectSdkRelease(root)).toEqual({ status: "found", version: "0.11.9" });
      simulateRuntime(join(tmpdir(), "elsewhere-dlx"));
      expect(projectSdkRelease(root)).toEqual({ status: "not-looked-up", reason: "another-pnp-runtime" });
      expect(issuers.filter((issuer) => issuer.startsWith(root))).toEqual([]);
      expect(asked.filter((location) => location.startsWith(root))).toEqual([]);
    });

    it("projectSdkRelease still finds the SDK under the project's own runtime (yarn hooknostic)", async () => {
      const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
      simulateRuntime(root);
      expect(projectSdkRelease(root)).toEqual({ status: "found", version: "0.11.9" });
    });

    it("projectSdkRelease resolves through the project's own runtime without node_modules (yarn hooknostic)", async () => {
      // A Plug'n'Play install has no node_modules: Yarn's runtime resolves the SDK.
      const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
      roots.push(root);
      await writeFile(join(root, "package.json"), "{}");
      await writeFile(join(root, ".pnp.cjs"), "");
      simulateRuntime(root);
      const release = projectSdkRelease(root);
      expect(issuers.filter((issuer) => issuer.startsWith(root))).not.toEqual([]);
      expect(release.status).not.toBe("not-looked-up");
    });

    it("projectSdkRelease keeps the node_modules walk under another runtime in a node_modules project (yarn dlx)", async () => {
      // No project manifest: Yarn's runtime does not serve the project, so
      // Node's resolution, NODE_PATH and all, must not be asked.
      const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
      roots.push(root);
      await writeFile(join(root, "package.json"), "{}");
      simulateRuntime(join(tmpdir(), "elsewhere-dlx"));
      expect(projectSdkRelease(root)).toEqual({ status: "not-found" });
      expect(issuers.filter((issuer) => issuer.startsWith(root))).toEqual([]);
    });

    /** Bare requests pnpm 12's hook resolved, by the hook below. */
    let pnpmResolved: string[] = [];

    /**
     * pnpm 12.21.0's `.pnp.cjs`, which pnpm exec loads through NODE_OPTIONS,
     * as .capture/pnpm-pnp quotes it: it leaves process.versions.pnp unset,
     * sets Module.findPnpApi (undefined for a path its registry does not
     * list), and hooks Module._resolveFilename to turn a bare request from the
     * project into the package's directory, which it hands to Node's own
     * resolver. Node resolves a directory by its manifest's `main` alone.
     */
    function simulatePnpm12Runtime(root: string): void {
      nodeModule.findPnpApi = (location: string) => {
        asked.push(location);
        return location.startsWith(root) ? { findPackageLocator: () => ({ name: null, reference: null }) } : undefined;
      };
      nodeModule._resolveFilename = function (request, parent, ...rest) {
        const issuer = parent?.filename;
        const name = /^(@[^/]+\/[^/]+|[^./@][^/]*)/.exec(request)?.[1];
        if (name === undefined || request.startsWith("node:") || issuer === undefined || !issuer.startsWith(root))
          return originalResolve.call(this, request, parent, ...rest);
        pnpmResolved.push(request);
        const directory = join(root, "node_modules", name, request.slice(name.length));
        return originalResolve.call(this, directory, parent, ...rest);
      };
    }

    afterEach(() => {
      pnpmResolved = [];
    });

    it("warns under pnpm 12's node-linker=pnp runtime, through the SDK's main (#259)", async () => {
      // The #216 gate stays open, never asking pnpm's findPnpApi: pnpm's
      // runtime leaves process.versions.pnp unset. The SDK's `main` lets
      // pnpm's hook resolve it, so pnpm exec warns and doctor finds it.
      const { root } = await pnpmPnpProject();
      simulatePnpm12Runtime(root);
      const diagnostic = projectSdkReleaseSkew(root);
      expect(pnpmResolved).toContain("@hooknostic/sdk");
      expect(asked).toEqual([]);
      expect(diagnostic).toMatchObject({ code: "HN110" });
      expect(diagnostic?.remediation).toContain("`pnpm exec hooknostic`");
      expect(projectSdkRelease(root)).toEqual({ status: "found", version: "0.11.9" });
    });

    it("finds no SDK without main under pnpm 12's runtime, as for an SDK before #259", async () => {
      // Pins why the SDK names `main`: an SDK of 0.13.0 or earlier has only
      // `exports`, and under pnpm exec HN110 is silent and doctor says
      // not-found, as captured.
      const { root } = await pnpmPnpProject({ main: false });
      expect(projectSdkReleaseSkew(root)).toMatchObject({ code: "HN110" });
      simulatePnpm12Runtime(root);
      expect(projectSdkReleaseSkew(root)).toBeUndefined();
      expect(pnpmResolved).toContain("@hooknostic/sdk");
      expect(projectSdkRelease(root)).toEqual({ status: "not-found" });
    });

    it("pins a known limitation: silent under pnpm 11's node-linker=pnp runtime (#269)", async () => {
      // Not a fix test: this holds before and after #259. pnpm 11.28.13's
      // .pnp.cjs is Yarn's runtime: under pnpm exec it sets
      // process.versions.pnp to 3, and its API's findPackageLocator returns
      // null for the project's root (.capture/pnpm-pnp, background). The
      // #216 gate then reads it as another install, as under yarn dlx: a
      // known limitation of best-effort pnpm Plug'n'Play, not fixed here.
      const { root } = await pnpmPnpProject();
      expect(projectSdkReleaseSkew(root)).toMatchObject({ code: "HN110" });
      simulateRuntime(join(tmpdir(), "elsewhere-pnpm-11"));
      expect(projectSdkReleaseSkew(root)).toBeUndefined();
      expect(projectSdkRelease(root)).toEqual({ status: "not-looked-up", reason: "another-pnp-runtime" });
    });

    it("still checks an absolute SDK alias under yarn dlx", async () => {
      // An alias is read from disk, never resolved through Yarn: no runtime to load.
      const { root } = await project(sdkManifest(CLI), { pnp: true });
      const aliased = await project(sdkManifest("0.10.0"));
      simulateRuntime(join(tmpdir(), "elsewhere-dlx"));
      const diagnostic = projectSdkReleaseSkew(root, { alias: { "@hooknostic/sdk": aliased.entry } });
      expect(diagnostic).toMatchObject({ code: "HN110" });
      expect(diagnostic?.message).toContain("is 0.10.0,");
    });

    /**
     * Today's answers for the layouts the #269 probe ran against real installs
     * (Yarn 4.18.1, Node 24.20.0, Windows, 2026-11-19). These tests simulate
     * the outcomes it captured; they are not a live capture.
     */
    describe("asks about the CLI's own directory wherever it is (#269 probe)", () => {
      /**
       * Yarn's runtime with these APIs loaded, each listing the paths under
       * its prefixes. `findPnpApi` returns the API that lists a path, or null,
       * as Yarn's does.
       */
      function loadedApis(...apis: string[][]): void {
        versions["pnp"] = "3";
        const lists = (prefixes: string[], path: string) => prefixes.some((prefix) => path.startsWith(prefix));
        nodeModule.findPnpApi = (location: string) => {
          asked.push(location);
          const api = apis.find((prefixes) => lists(prefixes, location));
          if (api === undefined) return null;
          return {
            findPackageLocator: (path: string) => (lists(api, path) ? { name: "app", reference: "workspace:." } : null),
          };
        };
        nodeModule._resolveFilename = function (request, parent, ...rest) {
          if (parent?.filename !== undefined) issuers.push(parent.filename);
          return originalResolve.call(this, request, parent, ...rest);
        };
      }

      const installA = join(tmpdir(), "yarn-install-a");
      const portal = join(tmpdir(), "hooknostic-checkout", "packages", "cli", "dist");

      // R1: resolving from the project loaded its manifest beside install A's.
      it.each([
        [
          "unplugged",
          join(installA, ".yarn", "unplugged", "hooknostic-npm-0.0.0-0", "node_modules", "hooknostic", "dist"),
        ],
        ["a workspace", join(installA, "packages", "hooknostic", "dist")],
        ["through portal:", portal],
      ])("answers true for a CLI install A holds outside a zip (%s), against another project", async (_, own) => {
        const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
        loadedApis([installA, portal]);
        expect(anotherInstallsPnpRuntime(root, own)).toBe(true);
        expect(asked).toEqual([own]);
      });

      it("answers false for an unplugged CLI in the project's own install", async () => {
        const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
        const own = join(root, ".yarn", "unplugged", "hooknostic-npm-0.0.0-0", "node_modules", "hooknostic", "dist");
        loadedApis([root]);
        expect(anotherInstallsPnpRuntime(root, own)).toBe(false);
      });

      // R2: resolving from the project loaded its manifest beside the tree's.
      it("answers true for an npm CLI inside another Yarn tree, started with that tree's runtime", async () => {
        const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
        const tree = join(tmpdir(), "yarn-tree-f");
        const own = join(tree, "tools", "node_modules", "hooknostic", "dist");
        loadedApis([tree]);
        expect(anotherInstallsPnpRuntime(root, own)).toBe(true);
      });

      // The #269 layout. The probe found the tree's manifest already loaded
      // when the CLI starts, and this answer wrong: the runtime is the
      // project's, and resolving from it loads nothing. Accepted.
      it("answers true, wrongly, for that CLI started with the project's own runtime (accepted)", async () => {
        const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
        const tree = join(tmpdir(), "yarn-tree-f");
        const own = join(tree, "tools", "node_modules", "hooknostic", "dist");
        loadedApis([root], [tree]);
        expect(anotherInstallsPnpRuntime(root, own)).toBe(true);
      });

      it("keeps HN110 silent and doctor's SDK not looked up in the #269 layout (accepted)", async () => {
        const { root } = await project(sdkManifest("0.11.9"), { pnp: true });
        // This file's package stands for the other Yarn tree around the CLI.
        loadedApis([root], [resolve(import.meta.dirname, "..")]);
        expect(projectSdkReleaseSkew(root)).toBeUndefined();
        expect(projectSdkRelease(root)).toEqual({ status: "not-looked-up", reason: "another-pnp-runtime" });
        expect(issuers.filter((issuer) => issuer.startsWith(root))).toEqual([]);
      });
    });
  });
});
