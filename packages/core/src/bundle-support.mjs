import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cwd } from "node:process";
import { TextEncoder } from "node:util";

// Node >=22.13 supplies getBuiltinModule. Avoid an extra top-level import
// binding: esbuild cannot rename banner identifiers when rebundling an artifact.
// It does reserve `require`, renaming bundled source bindings as needed.
export const createRequireBanner = 'const require = globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url);';

async function manifestAt(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

async function licenseText(directory) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i.test(entry.name))
    .map((entry) => entry.name).sort();
  const parts = await Promise.all(names.map(async (name) =>
    `${name}\n${(await readFile(join(directory, name), "utf8")).replaceAll("\r\n", "\n").trim()}`,
  ));
  return parts.join("\n\n");
}

async function packageNotice(input, workingDir, cache) {
  if (input.startsWith("<")) return undefined;
  const absolute = resolve(workingDir, input);
  const dependency = /[/\\]node_modules[/\\]/.test(absolute);
  let directory = dirname(absolute);
  while (directory !== dirname(directory)) {
    // Some packages (e.g. zod/v3) have nested manifests that only set module type.
    const manifest = await manifestAt(directory);
    if (manifest?.name) {
      const own = manifest.name === "hooknostic" || manifest.name.startsWith("@hooknostic/");
      if (!dependency && !own) return undefined; // authored source retains its legal comments
      if (!cache.has(directory)) {
        let text = await licenseText(directory);
        if (!text && own) {
          // Private workspace libraries use the root license. Published packages
          // have their own LICENSE; never search an installed consumer's parents.
          const root = resolve(directory, "../..");
          if ((await manifestAt(root))?.name === "hooknostic-monorepo") text = await licenseText(root);
        }
        if (!text) throw new Error(`Bundled dependency ${manifest.name}@${manifest.version} has no license/notice file; supply its redistribution notice before bundling.`);
        cache.set(directory, { id: `${manifest.name}@${manifest.version}`, text });
      }
      return cache.get(directory);
    }
    directory = dirname(directory);
  }
  return undefined;
}

function formatNotices(notices) {
  const groups = new Map();
  for (const { id, text } of notices) {
    if (!groups.has(text)) groups.set(text, new Set());
    groups.get(text).add(id);
  }
  return [...groups].map(([text, names]) => `${[...names].sort().join("\n")}\n${text}`).sort().join("\n\n---\n\n");
}

/** Carry full package notices in legal comments so another bundling pass preserves them. */
export function licenseNoticesPlugin({ noticeFile, additionalSources = [] } = {}) {
  return {
    name: "hooknostic-license-notices",
    setup(build) {
      build.initialOptions.metafile = true;
      build.onEnd(async (result) => {
        if (result.errors.length || !result.metafile) return;
        const workingDir = build.initialOptions.absWorkingDir ?? cwd();
        const notices = new Map();
        const packages = new Map();
        const all = new Set();
        for (const [output, metadata] of Object.entries(result.metafile.outputs)) {
          if (!/\.[cm]?js$/.test(output)) continue;
          const included = new Set();
          // Generated stdin templates have no module path in the metafile.
          for (const source of additionalSources) {
            const notice = await packageNotice(source, workingDir, packages);
            if (notice) { included.add(notice); all.add(notice); }
          }
          for (const [input, contribution] of Object.entries(metadata.inputs)) {
            if (contribution.bytesInOutput === 0) continue;
            if (!notices.has(input)) notices.set(input, await packageNotice(input, workingDir, packages));
            const notice = notices.get(input);
            if (notice) {
              included.add(notice);
              all.add(notice);
            }
          }
          if (included.size === 0) continue;
          const comment = `\n/*!\nBundled package notices\n\n${formatNotices(included).replaceAll("*/", "* /")}\n*/\n`;
          const path = resolve(workingDir, output);
          const file = result.outputFiles?.find((file) => file.path === path);
          if (file) file.contents = new TextEncoder().encode(file.text + comment);
          else if (build.initialOptions.write !== false) await writeFile(path, await readFile(path, "utf8") + comment);
        }
        if (noticeFile) await writeFile(noticeFile, `Bundled package notices\n\n${formatNotices(all)}\n`);
      });
    },
  };
}
