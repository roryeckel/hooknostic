import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { build } from "esbuild";

const [entry, outputDir] = process.argv.slice(2);
if (!entry || !outputDir) throw new Error("usage: bundle-mcp.mjs <entry> <output-directory>");
const result = await build({
  entryPoints: [entry],
  outfile: join(outputDir, "greet-mcp.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Bundled CommonJS dependencies can still require Node builtins.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  legalComments: "inline",
  metafile: true,
});

// Full dependency license/notice files travel with the bundle, including those
// whose source contains no esbuild-preserved legal comment.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).filter((path) => path.includes("node_modules"))) {
  let dir = dirname(resolve(input));
  while (dir !== dirname(dir)) {
    const files = await readdir(dir);
    if (files.includes("package.json")) {
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      // Packages can put a type-only package.json in a module subdirectory.
      if (!manifest.name || !manifest.version) {
        dir = dirname(dir);
        continue;
      }
      const notices = files.filter((file) => /^(licen[sc]e|notice)([.-].*)?$/i.test(file)).sort();
      if (notices.length === 0) throw new Error(`No license file for bundled dependency ${manifest.name}`);
      packages.set(
        `${manifest.name}@${manifest.version}`,
        await Promise.all(notices.map((file) => readFile(join(dir, file), "utf8"))),
      );
      break;
    }
    dir = dirname(dir);
  }
}
await writeFile(
  join(outputDir, "THIRD_PARTY_NOTICES.txt"),
  [...packages.keys()]
    .sort()
    .map((name) => `${name}\n\n${packages.get(name).join("\n\n")}`)
    .join("\n\n---\n\n") + "\n",
);
