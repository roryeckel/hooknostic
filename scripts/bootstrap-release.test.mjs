import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { bootstrapRelease } from "./bootstrap-release.mjs";

it("packs three workspace-aware tarballs with checksums and resumes partial uploads without publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-bootstrap-test-"));
  const assets = new Map();
  const run = vi.fn(async (command, args) => {
    if (command === "pnpm") {
      expect(args.slice(0, 1)).toEqual(["--filter"]);
      expect(args.slice(2, 6)).toEqual(["exec", "pnpm", "pack", "--pack-destination"]);
      const name = `${args[1].replace("@", "").replace("/", "-")}-1.2.3.tgz`;
      await writeFile(join(args[6], name), `packed ${args[1]}`);
    } else if (args[1] === "view") return JSON.stringify({ assets: [...assets.keys()].map((name) => ({ name })) });
    else if (args[1] === "upload") {
      const name = args[3].split(/[/\\]/).at(-1);
      assets.set(name, await readFile(args[3]));
    } else if (args[1] === "download")
      await writeFile(
        join(args[args.indexOf("--dir") + 1], args[args.indexOf("--pattern") + 1]),
        assets.get(args[args.indexOf("--pattern") + 1]),
      );
    else throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    return "";
  });
  try {
    await bootstrapRelease({ repo: "owner/repo", tag: "v1.2.3", directory: join(root, "first"), run });
    expect(assets.size).toBe(4);
    const checksums = assets.get("SHA256SUMS").toString();
    for (const [name, bytes] of assets)
      if (name.endsWith(".tgz"))
        expect(checksums).toContain(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    // A failed upload may leave any subset on the release. Existing matching files survive.
    assets.delete("hooknostic-1.2.3.tgz");
    run.mockClear();
    await bootstrapRelease({ repo: "owner/repo", tag: "v1.2.3", directory: join(root, "retry"), run });
    expect(run.mock.calls.filter(([, args]) => args[1] === "upload")).toHaveLength(1);
    expect(run.mock.calls.some(([, args]) => args.includes("publish") || args.includes("--clobber"))).toBe(false);
    assets.set("hooknostic-1.2.3.tgz", Buffer.from("different"));
    await expect(
      bootstrapRelease({ repo: "owner/repo", tag: "v1.2.3", directory: join(root, "mismatch"), run }),
    ).rejects.toThrow("refusing to replace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects stale output directories and incorrectly versioned tarballs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-bootstrap-invalid-"));
  try {
    await writeFile(join(root, "stale"), "stale");
    await expect(
      bootstrapRelease({ repo: "owner/repo", tag: "v1.2.3", directory: root, run: vi.fn() }),
    ).rejects.toThrow("must be empty");
    await rm(join(root, "stale"));
    await expect(
      bootstrapRelease({
        repo: "owner/repo",
        tag: "v1.2.3",
        directory: root,
        run: async () => {
          await writeFile(join(root, "wrong.tgz"), "wrong");
        },
      }),
    ).rejects.toThrow("do not match");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
