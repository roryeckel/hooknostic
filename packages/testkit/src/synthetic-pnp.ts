import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

/** One package Yarn would install into its zip cache. */
export interface SyntheticPnpPackage {
  name: string;
  version: string;
  /** File contents by path relative to the package root, `package.json` included. */
  files: Record<string, string>;
  /** Names of other packages in the same layout that this one depends on. */
  dependencies?: readonly string[];
}

/**
 * A zip archive of stored (uncompressed) entries, as Yarn 4 writes its cache
 * by default. No directory entries: esbuild's reader infers them.
 */
export function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * A Yarn Plug'n'Play project written without Yarn: a `.pnp.data.json`
 * manifest and one stored zip per package under `.yarn/cache`, which esbuild
 * resolves and reads through its own PnP support. A process without Yarn's
 * runtime cannot read inside those zips, exactly as with a real Yarn install.
 *
 * The project, named `name`, depends on every package in `packages`. Returns
 * each package's root inside its zip, by package name.
 */
export async function writeSyntheticPnpProject(
  root: string,
  name: string,
  packages: readonly SyntheticPnpPackage[],
): Promise<Record<string, string>> {
  const cache = join(root, ".yarn", "cache");
  await mkdir(cache, { recursive: true });
  const reference = (pkg: SyntheticPnpPackage) => `npm:${pkg.version}`;
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const roots: Record<string, string> = {};
  const registry: unknown[] = [];
  for (const pkg of packages) {
    const zip = `${pkg.name.replace("/", "-")}-npm-${pkg.version}.zip`;
    const inside = `node_modules/${pkg.name}/`;
    await writeFile(
      join(cache, zip),
      storedZip(Object.fromEntries(Object.entries(pkg.files).map(([path, text]) => [`${inside}${path}`, text]))),
    );
    roots[pkg.name] = join(cache, zip, ...inside.split("/"));
    const dependencies = [pkg.name, ...(pkg.dependencies ?? [])].map((dependency) => {
      const target = byName.get(dependency);
      if (target === undefined) throw new Error(`synthetic PnP: ${pkg.name} depends on unknown ${dependency}`);
      return [dependency, reference(target)];
    });
    registry.push([
      pkg.name,
      [
        [
          reference(pkg),
          { packageLocation: `./.yarn/cache/${zip}/${inside}`, packageDependencies: dependencies, linkType: "HARD" },
        ],
      ],
    ]);
  }
  const project = {
    packageLocation: "./",
    packageDependencies: packages.map((pkg) => [pkg.name, reference(pkg)]),
    linkType: "SOFT",
  };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name, dependencies: Object.fromEntries(packages.map((pkg) => [pkg.name, pkg.version])) }),
  );
  await writeFile(
    join(root, ".pnp.data.json"),
    JSON.stringify({
      __info: [],
      dependencyTreeRoots: [{ name, reference: "workspace:." }],
      enableTopLevelFallback: true,
      ignorePatternData: null,
      fallbackExclusionList: [],
      fallbackPool: [],
      packageRegistryData: [[null, [[null, project]]], [name, [["workspace:.", project]]], ...registry],
    }),
  );
  return roots;
}
