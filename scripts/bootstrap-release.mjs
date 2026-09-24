import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isMainModule } from "./is-main-module.mjs";

const PACKAGES = ["@hooknostic/sdk", "@hooknostic/agent-plugin", "hooknostic"];
const execute = (command, args) => execFileSync(command, args, { encoding: "utf8" });

/** Produce inspectable first-release assets; this function never invokes publish. */
export async function bootstrapRelease({ repo, tag, directory, run = execute }) {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error("Bootstrap asset directory must be empty");
  for (const name of PACKAGES) {
    await run("pnpm", ["--filter", name, "exec", "pnpm", "pack", "--pack-destination", directory]);
  }
  const files = (await readdir(directory)).sort();
  const version = tag.replace(/^v/, "");
  const expected = ["hooknostic-sdk", "hooknostic-agent-plugin", "hooknostic"]
    .map((name) => `${name}-${version}.tgz`)
    .sort();
  if (JSON.stringify(files) !== JSON.stringify(expected))
    throw new Error("Packed filenames do not match the three release packages and tag");
  const checksums = await Promise.all(
    files.map(
      async (name) =>
        `${createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex")}  ${name}`,
    ),
  );
  await writeFile(join(directory, "SHA256SUMS"), checksums.join("\n") + "\n");
  const release = JSON.parse(await run("gh", ["release", "view", tag, "--repo", repo, "--json", "assets"]));
  const scratch = await mkdtemp(join(tmpdir(), "hooknostic-release-assets-"));
  try {
    for (const name of [...files, "SHA256SUMS"]) {
      if (release.assets.some((asset) => asset.name === name)) {
        await run("gh", ["release", "download", tag, "--repo", repo, "--pattern", name, "--dir", scratch]);
        if (!(await readFile(join(scratch, name))).equals(await readFile(join(directory, name))))
          throw new Error(`Existing release asset ${name} differs; refusing to replace it`);
      } else {
        await run("gh", ["release", "upload", tag, join(directory, name), "--repo", repo]);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const [repo, tag, directory] = process.argv.slice(2);
  if (!repo || !tag || !directory) throw new Error("usage: bootstrap-release.mjs owner/repo vVERSION output-directory");
  await bootstrapRelease({ repo, tag, directory: resolve(directory) });
}
