// Supplies OpenCode's glob/grep with a pinned, checksum-verified ripgrep so the
// tools drive never lets the harness download its own (#264). The harness looks
// for `rg` on PATH, then for `$XDG_CACHE_HOME/opencode/bin/rg` (`rg.exe` on
// Windows), and only then downloads; the drive seeds the second location.
// Evidence and procedure: README.md, "ripgrep pre-seed".
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RIPGREP_VERSION = "15.1.0";

// OpenCode's own platform table (identical in 2.0.17 and 2.3.2). The SHA-256
// pins are the ones 2.3.2 checks; each matches ripgrep's published .sha256 file.
// 2.0.17 checks none, which is one reason the drive verifies its own copy.
const ASSETS = {
  "arm64-darwin": {
    platform: "aarch64-apple-darwin",
    extension: "tar.gz",
    sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
  },
  "arm64-linux": {
    platform: "aarch64-unknown-linux-gnu",
    extension: "tar.gz",
    sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
  },
  "x64-darwin": {
    platform: "x86_64-apple-darwin",
    extension: "tar.gz",
    sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
  },
  "x64-linux": {
    platform: "x86_64-unknown-linux-musl",
    extension: "tar.gz",
    sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
  },
  "arm64-win32": {
    platform: "aarch64-pc-windows-msvc",
    extension: "zip",
    sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
  },
  "ia32-win32": {
    platform: "i686-pc-windows-msvc",
    extension: "zip",
    sha256: "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
  },
  "x64-win32": {
    platform: "x86_64-pc-windows-msvc",
    extension: "zip",
    sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
  },
};

function fail(message) {
  return new Error(`ripgrep pre-seed failed: ${message}`);
}

/** The pinned release asset for one platform, named as the harness names it. */
export function ripgrepAsset(platform = process.platform, arch = process.arch) {
  const key = `${arch}-${platform}`;
  const asset = ASSETS[key];
  if (!asset) throw fail(`no pinned ripgrep for ${key}`);
  const name = `ripgrep-${RIPGREP_VERSION}-${asset.platform}`;
  const file = `${name}.${asset.extension}`;
  return {
    ...asset,
    name,
    file,
    executable: platform === "win32" ? "rg.exe" : "rg",
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${file}`,
  };
}

async function isFile(path) {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

function versionOf(executable) {
  return new Promise((resolve) => {
    execFile(executable, ["--version"], { timeout: 10000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : String(stdout).split(/\r?\n/)[0]),
    );
  });
}

async function usable(executable) {
  return (await isFile(executable)) && (await versionOf(executable))?.startsWith(`ripgrep ${RIPGREP_VERSION}`);
}

async function download(asset, { fetch = globalThis.fetch, attempts = 3, timeoutMs = 20000, retryDelayMs = 1000 }) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt - 1)));
    try {
      const response = await fetch(asset.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== asset.sha256)
        throw new Error(`SHA-256 mismatch: expected ${asset.sha256}, got ${actual} (${bytes.length} bytes)`);
      return bytes;
    } catch (error) {
      last = error;
    }
  }
  throw fail(`${asset.url} after ${attempts} attempts: ${last instanceof Error ? last.message : String(last)}`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(fail(`${command} exited ${code}: ${output.trim()}`))));
  });
}

/**
 * A verified ripgrep in a directory shared across runs: `HKN_RIPGREP_DIR`, or a
 * per-version directory under the OS temp directory. Downloads (SHA-256 pinned,
 * retried) and extracts only when no usable copy is there yet, so a developer
 * machine fetches once; a fresh CI runner still fetches once per job.
 */
export async function ensureRipgrep(options = {}) {
  const asset = options.asset ?? ripgrepAsset();
  const dir =
    options.dir ??
    process.env.HKN_RIPGREP_DIR ??
    join(tmpdir(), "hooknostic-ripgrep", RIPGREP_VERSION, asset.platform);
  const target = join(dir, asset.executable);
  if (await usable(target)) return target;
  await mkdir(dir, { recursive: true });
  const work = await mkdtemp(join(dir, ".fetch-"));
  try {
    const archive = join(work, asset.file);
    await writeFile(archive, await download(asset, options));
    // The zip assets exist only for Windows, whose bsdtar reads zip archives.
    if (asset.extension === "zip")
      await run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive], work);
    else await run("tar", ["-xzf", archive, "-C", work], work);
    const extracted = join(work, asset.name, asset.executable);
    if (!(await isFile(extracted))) throw fail(`${asset.file} did not contain ${asset.name}/${asset.executable}`);
    if (process.platform !== "win32") await chmod(extracted, 0o755);
    const version = await versionOf(extracted);
    if (!version?.startsWith(`ripgrep ${RIPGREP_VERSION}`))
      throw fail(`${extracted} reports ${JSON.stringify(version)}, expected ripgrep ${RIPGREP_VERSION}`);
    // Only the tools drive seeds, so a concurrent writer means two test runs on
    // one machine. POSIX rename replaces atomically; Windows refuses an existing
    // target, which is then either the other run's verified copy (kept) or a
    // stale file (replaced).
    try {
      await rename(extracted, target);
    } catch (error) {
      if (await usable(target)) return target;
      if (!(await isFile(target))) throw error;
      await rm(target, { force: true });
      await rename(extracted, target);
    }
    return target;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Copy the verified ripgrep to where the harness looks under `cacheHome` (its XDG_CACHE_HOME). */
export async function seedRipgrep(cacheHome, options = {}) {
  const asset = options.asset ?? ripgrepAsset();
  const source = await ensureRipgrep({ ...options, asset });
  const bin = join(cacheHome, "opencode", "bin");
  await mkdir(bin, { recursive: true });
  const seeded = join(bin, asset.executable);
  await copyFile(source, seeded);
  if (process.platform !== "win32") await chmod(seeded, 0o755);
  return { source, seeded };
}

function spawnedCommand(line) {
  const match = /message="spawning process" command=("(?:[^"\\]|\\.)*"|\S+)/.exec(line);
  if (!match) return undefined;
  if (!match[1].startsWith('"')) return match[1];
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].slice(1, -1);
  }
}

/**
 * Proof by effect that the run did not fetch ripgrep: the harness logs
 * `downloading ripgrep` at INFO before every bootstrap, successful or not. A log
 * with no INFO line cannot show that either, so it fails rather than passing
 * vacuously. 2.0.17 also logs each process it spawns; the ripgrep ones are
 * returned for the record (2.3.2 logs none).
 */
export function checkRipgrepLog(text, where = "the harness log") {
  const lines = text.split(/\r?\n/);
  const downloaded = lines.find((line) => line.includes('message="downloading ripgrep"'));
  if (downloaded) throw new Error(`OpenCode downloaded ripgrep despite the pre-seed (${where}): ${downloaded}`);
  if (!lines.some((line) => / level=INFO .*message="/.test(line)))
    throw new Error(`no INFO-level harness log lines in ${where}; cannot tell whether ripgrep was downloaded`);
  const spawned = lines
    .map(spawnedCommand)
    .filter((command) => command && /^rg(\.exe)?$/i.test(command.split(/[\\/]/).at(-1)));
  return { spawned: [...new Set(spawned)] };
}

/** checkRipgrepLog over the harness logs under `dataHome` (its XDG_DATA_HOME). */
export async function verifyRipgrepSeed(dataHome) {
  const dir = join(dataHome, "opencode", "log");
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".log"));
  const text = (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).join("\n");
  return checkRipgrepLog(text, dir);
}
