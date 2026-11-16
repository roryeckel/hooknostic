import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { projectSdkReleaseSkew } from "./build.js";
import { sdkReleaseSkew } from "./sdk-resolution.js";

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

/** A project whose `node_modules/@hooknostic/sdk` has `manifest`; returns the project and the SDK's entry. */
async function project(manifest: string, options: { pnp?: boolean } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-skew-"));
  roots.push(root);
  const stray = strayPnpManifest(root);
  if (stray !== undefined) throw new Error(`precondition: no PnP manifest may be above ${tmpdir()}, but ${stray} is`);
  await writeFile(join(root, "package.json"), "{}");
  if (options.pnp) await writeFile(join(root, ".pnp.cjs"), "");
  const sdk = join(root, "node_modules/@hooknostic/sdk");
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

  it("points a node_modules project at npx, and a Plug'n'Play project at yarn", async () => {
    const plain = await project(sdkManifest("0.11.9"));
    const npm = sdkReleaseSkew(plain.entry, CLI, plain.root)?.remediation;
    expect(npm).toContain("`npx hooknostic`");
    // npx runs the project's CLI only once the project installs one.
    expect(npm).toContain("without a local install, npx fetches the registry's latest");
    expect(npm).not.toContain("yarn hooknostic");

    const pnp = await project(sdkManifest("0.11.9"), { pnp: true });
    const yarn = sdkReleaseSkew(pnp.entry, CLI, pnp.root)?.remediation;
    expect(yarn).toContain("`yarn hooknostic`");
    expect(yarn).not.toContain("`npx hooknostic`");
    for (const remediation of [npm, yarn])
      expect(remediation).toContain(
        "add hooknostic to the project's devDependencies at the same version as its @hooknostic/sdk",
      );
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

    it("still checks an absolute SDK alias under yarn dlx", async () => {
      // An alias is read from disk, never resolved through Yarn: no runtime to load.
      const { root } = await project(sdkManifest(CLI), { pnp: true });
      const aliased = await project(sdkManifest("0.10.0"));
      simulateRuntime(join(tmpdir(), "elsewhere-dlx"));
      const diagnostic = projectSdkReleaseSkew(root, { alias: { "@hooknostic/sdk": aliased.entry } });
      expect(diagnostic).toMatchObject({ code: "HN110" });
      expect(diagnostic?.message).toContain("is 0.10.0,");
    });
  });
});
