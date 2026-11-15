import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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
  JSON.stringify({ name: "@hooknostic/sdk", type: "module", ...(version === undefined ? {} : { version }) });

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

  it("names the CLI's version, the SDK's, and where the SDK is", async () => {
    const { root, sdk, entry } = await project(sdkManifest("0.13.0-rc.1"));
    const diagnostic = sdkReleaseSkew(entry, CLI, root);
    expect(diagnostic).toMatchObject({ code: "HN110", severity: "warn" });
    expect(diagnostic?.message).toContain(`this hooknostic is ${CLI}`);
    expect(diagnostic?.message).toContain(`@hooknostic/sdk at ${sdk} is 0.13.0-rc.1`);
  });

  it("points a node_modules project at npx, and a Plug'n'Play project at yarn", async () => {
    const plain = await project(sdkManifest("0.11.9"));
    const npm = sdkReleaseSkew(plain.entry, CLI, plain.root)?.remediation;
    expect(npm).toContain("`npx hooknostic`");
    expect(npm).not.toContain("yarn hooknostic");

    const pnp = await project(sdkManifest("0.11.9"), { pnp: true });
    const yarn = sdkReleaseSkew(pnp.entry, CLI, pnp.root)?.remediation;
    expect(yarn).toContain("`yarn hooknostic`");
    expect(yarn).not.toContain("`npx hooknostic`");
    for (const remediation of [npm, yarn]) expect(remediation).toContain("at the same version");
  });
});
