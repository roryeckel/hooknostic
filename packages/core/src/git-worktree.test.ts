import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { linkedWorktree } from "./git-worktree.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
}

/** A committed repository `main` inside a fresh scratch directory. */
async function repository(): Promise<{ scratch: string; main: string }> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "hooknostic-worktree-")));
  dirs.push(scratch);
  const main = join(scratch, "main");
  await mkdir(main);
  git(main, ["init", "--quiet"]);
  await writeFile(join(main, "README"), "synthetic\n");
  git(main, ["add", "README"]);
  git(main, [
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Synthetic worktree fixture",
  ]);
  return { scratch, main };
}

describe("linkedWorktree", () => {
  it("resolves a sibling linked worktree, and a directory inside it, to the root checkout", async () => {
    const { scratch, main } = await repository();
    const linked = join(scratch, "linked");
    git(main, ["worktree", "add", "--detach", "--quiet", linked, "HEAD"]);
    await mkdir(join(linked, "nested/deeper"), { recursive: true });

    expect(await linkedWorktree(linked)).toEqual({ checkout: linked, rootCheckout: main });
    expect(await linkedWorktree(join(linked, "nested/deeper"))).toEqual({ checkout: linked, rootCheckout: main });
  });

  it("resolves a worktree nested inside the root checkout to the root checkout, not itself", async () => {
    const { main } = await repository();
    const linked = join(main, ".claude", "worktrees", "linked");
    git(main, ["worktree", "add", "--detach", "--quiet", linked, "HEAD"]);

    expect(await linkedWorktree(linked)).toEqual({ checkout: linked, rootCheckout: main });
  });

  it("reports nothing for a regular checkout or a directory outside any repository", async () => {
    const { scratch, main } = await repository();
    await mkdir(join(main, "nested"));
    const outside = join(scratch, "outside");
    await mkdir(outside);

    expect(await linkedWorktree(main)).toBeUndefined();
    expect(await linkedWorktree(join(main, "nested"))).toBeUndefined();
    expect(await linkedWorktree(outside)).toBeUndefined();
  });

  it("reports nothing for a gitdir file that is not a registered worktree", async () => {
    const { scratch, main } = await repository();
    const linked = join(scratch, "linked");
    git(main, ["worktree", "add", "--detach", "--quiet", linked, "HEAD"]);
    // A submodule-style pointer: gitdir outside any `worktrees/` directory.
    const submodule = join(scratch, "submodule");
    await mkdir(join(scratch, "modules", "sub"), { recursive: true });
    await mkdir(submodule);
    await writeFile(join(submodule, ".git"), `gitdir: ${join(scratch, "modules", "sub")}\n`);
    // A copied worktree: its `.git` file names a worktree registered elsewhere.
    const impostor = join(scratch, "impostor");
    await mkdir(impostor);
    await writeFile(join(impostor, ".git"), `gitdir: ${join(main, ".git", "worktrees", "linked")}\n`);

    expect(await linkedWorktree(submodule)).toBeUndefined();
    expect(await linkedWorktree(impostor)).toBeUndefined();
  });

  it("follows directory symlinks where Codex's metadata lookup does", async () => {
    const { scratch, main } = await repository();
    const linked = join(scratch, "linked");
    git(main, ["worktree", "add", "--detach", "--quiet", linked, "HEAD"]);
    // Move the root checkout's git directory away and link it back. The
    // worktree's gitdir still names it through main/.git, so Codex redirects.
    const store = join(scratch, "store");
    await rename(join(main, ".git"), store);
    await symlink(store, join(main, ".git"), process.platform === "win32" ? "junction" : "dir");
    // A linked `.git` directory without HEAD is not a repository: keep walking.
    const empty = join(scratch, "empty");
    await mkdir(empty);
    await mkdir(join(linked, "sub"));
    await symlink(empty, join(linked, "sub", ".git"), process.platform === "win32" ? "junction" : "dir");

    expect(await linkedWorktree(linked)).toEqual({ checkout: linked, rootCheckout: main });
    expect(await linkedWorktree(join(linked, "sub"))).toEqual({ checkout: linked, rootCheckout: main });
  });

  it("reports nothing for a worktree of a bare repository, which has no root checkout", async () => {
    const { scratch, main } = await repository();
    // Inside an unrelated checkout, so the bare repository's parent has a
    // `.git` of its own -- one that does not own the worktree.
    const bare = join(main, "bare.git");
    git(scratch, ["clone", "--bare", "--quiet", main, bare]);
    const linked = join(scratch, "from-bare");
    git(bare, ["worktree", "add", "--detach", "--quiet", linked, "HEAD"]);

    expect(await linkedWorktree(linked)).toBeUndefined();
  });
});
