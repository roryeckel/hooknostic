import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// Git writes these files; anything larger is not one.
const MAX_GIT_METADATA_FILE_BYTES = 64 * 1024;

export interface LinkedWorktree {
  /** Top of the linked worktree that contains the inspected directory. */
  checkout: string;
  /** The main checkout that owns the worktree's common git directory. */
  rootCheckout: string;
}

async function metadataFile(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.size > MAX_GIT_METADATA_FILE_BYTES) return undefined;
    return (await readFile(path, "utf8")).trim();
  } catch {
    return undefined;
  }
}

async function gitdirTarget(dotGit: string): Promise<string | undefined> {
  const contents = await metadataFile(dotGit);
  const target = contents?.startsWith("gitdir:") ? contents.slice("gitdir:".length).trim() : "";
  return target === "" ? undefined : resolve(dirname(dotGit), target);
}

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/**
 * The root checkout a harness resolves `dir` to when `dir` is inside a linked
 * git worktree, or `undefined` for a regular checkout, no repository, or any
 * layout that does not verify.
 *
 * Mirrors codex-rs `resolve_root_git_project_for_trust`
 * (`git-utils/src/trust.rs`, rust-v0.156.1) step for step, because what
 * matters is exactly when Codex redirects, not what `git` would call a
 * worktree: it reads files and never runs `git`, and it declines bare
 * repositories and unverifiable metadata. Every failure here returns
 * `undefined`, so a warning built on it errs towards silence.
 */
export async function linkedWorktree(dir: string): Promise<LinkedWorktree | undefined> {
  // The nearest `.git`, skipping a `.git` directory without HEAD (not a repository).
  let checkout: string | undefined;
  let dotGitStats: Awaited<ReturnType<typeof lstat>> | undefined;
  for (let base = resolve(dir); ;) {
    try {
      dotGitStats = await lstat(join(base, ".git"));
      if (!dotGitStats.isDirectory()) {
        checkout = base;
        break;
      }
      await lstat(join(base, ".git", "HEAD"));
      checkout = base;
      break;
    } catch {
      // No usable `.git` here; keep walking up.
    }
    const parent = dirname(base);
    if (parent === base) return undefined;
    base = parent;
  }
  if (checkout === undefined || dotGitStats === undefined || !dotGitStats.isFile()) return undefined;

  const gitDir = await gitdirTarget(join(checkout, ".git"));
  if (gitDir === undefined) return undefined;
  try {
    const stats = await lstat(gitDir);
    if (!stats.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const canonicalGitDir = await canonical(gitDir);
  if (canonicalGitDir === undefined || basename(dirname(canonicalGitDir)) !== "worktrees") return undefined;
  const commonDir = dirname(dirname(canonicalGitDir));

  // The worktree's own metadata must point back at this checkout and at the
  // same common directory, so an unrelated `.git` file cannot borrow a root.
  const registeredDotGit = await metadataFile(join(canonicalGitDir, "gitdir"));
  if (!registeredDotGit) return undefined;
  const registered = resolve(canonicalGitDir, registeredDotGit);
  if (basename(registered) !== ".git") return undefined;
  const commondir = await metadataFile(join(canonicalGitDir, "commondir"));
  if (!commondir) return undefined;
  const [registeredCheckout, actualCheckout, linkedCommonDir] = await Promise.all([
    canonical(dirname(registered)),
    canonical(checkout),
    canonical(resolve(canonicalGitDir, commondir)),
  ]);
  if (registeredCheckout === undefined || registeredCheckout !== actualCheckout || linkedCommonDir !== commonDir)
    return undefined;

  // The main checkout must own the common directory; a bare repository's
  // parent does not, and neither does a stray directory beside it.
  const rootCheckout = dirname(dirname(dirname(gitDir)));
  const mainDotGit = join(rootCheckout, ".git");
  let mainGitDir: string | undefined;
  try {
    mainGitDir = (await lstat(mainDotGit)).isDirectory() ? mainDotGit : await gitdirTarget(mainDotGit);
  } catch {
    return undefined;
  }
  if (mainGitDir === undefined || (await canonical(mainGitDir)) !== commonDir) return undefined;
  return { checkout, rootCheckout };
}
