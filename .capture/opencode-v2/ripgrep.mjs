// Supplies OpenCode's glob/grep with a pinned, checksum-verified ripgrep so the
// tools drive never lets the harness download its own (#264). The harness looks
// for `rg` on PATH, then for `$XDG_CACHE_HOME/opencode/bin/rg` (`rg.exe` on
// Windows), and only then downloads; the drive seeds the second location.
// Evidence and procedure: README.md, "ripgrep pre-seed".
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

export const RIPGREP_VERSION = "15.1.0";

// OpenCode's own platform table (identical in 2.0.17 and 2.3.2). `sha256` pins
// the archive: the values 2.3.2 checks, each matching ripgrep's published
// .sha256 file (2.0.17 checks none). `binarySha256` pins the executable inside,
// hashed from a verified extraction of each archive; the x64-win32 and
// arm64-darwin values also equal the rg the harness itself downloaded in the
// unseeded captures (README, "ripgrep pre-seed").
const ASSETS = {
  "arm64-darwin": {
    platform: "aarch64-apple-darwin",
    extension: "tar.gz",
    sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
    binarySha256: "4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94",
  },
  "arm64-linux": {
    platform: "aarch64-unknown-linux-gnu",
    extension: "tar.gz",
    sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
    binarySha256: "968cabe8efed72fd8fd482cb76b6084fcb695fc5293af7fb62296b02f487fb69",
  },
  "x64-darwin": {
    platform: "x86_64-apple-darwin",
    extension: "tar.gz",
    sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
    binarySha256: "3bafa7e6ee51ba3ac4ed065883484a309be09b26ea6dad561ae4049bfe049c50",
  },
  "x64-linux": {
    platform: "x86_64-unknown-linux-musl",
    extension: "tar.gz",
    sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
    binarySha256: "ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2",
  },
  "arm64-win32": {
    platform: "aarch64-pc-windows-msvc",
    extension: "zip",
    sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
    binarySha256: "f7799d737b520e00b10dfa72def23904fe66fb03315636a7b78549845ee9609c",
  },
  "ia32-win32": {
    platform: "i686-pc-windows-msvc",
    extension: "zip",
    sha256: "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
    binarySha256: "7773ca1c74315c188a84937adbfa3af5b2fa8ef12be0249d66a6ce372f67e82e",
  },
  "x64-win32": {
    platform: "x86_64-pc-windows-msvc",
    extension: "zip",
    sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
    binarySha256: "decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408",
  },
};

/**
 * The seeded copy's modification time. A harness that fetched its own ripgrep
 * into the same place would replace the file and its time with it.
 */
export const SEED_MTIME = new Date("2001-01-01T00:00:00Z");

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

/** A per-user cache directory: never a shared temporary directory another account could write. */
export function defaultRipgrepDir(
  asset = ripgrepAsset(),
  { platform = process.platform, env = process.env, home = homedir() } = {},
) {
  const base =
    platform === "win32"
      ? (env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
      : platform === "darwin"
        ? join(home, "Library", "Caches")
        : env.XDG_CACHE_HOME || join(home, ".cache");
  return join(base, "hooknostic", "ripgrep", RIPGREP_VERSION, asset.platform);
}

async function isFile(path) {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Only the pinned executable, byte for byte, is ever reused or seeded. */
async function pinned(path, asset) {
  return (await isFile(path)) && (await sha256File(path)) === asset.binarySha256;
}

function versionOf(executable) {
  return new Promise((resolve) => {
    execFile(executable, ["--version"], { timeout: 10000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : String(stdout).split(/\r?\n/)[0]),
    );
  });
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
 * The pinned ripgrep in a per-user directory shared across runs:
 * `HKN_RIPGREP_DIR`, or `defaultRipgrepDir()`. A copy there is reused only if
 * its SHA-256 is the pinned executable's. Otherwise the archive is downloaded
 * (SHA-256 pinned, retried) and extracted, and the executable must hash to its
 * pin and report the version. A developer machine fetches once; a fresh CI
 * runner fetches once per job unless the directory is cached. A relative
 * directory is resolved against the cwd. Tests may replace `fetch` and
 * `versionOf`.
 */
export async function ensureRipgrep(options = {}) {
  const asset = options.asset ?? ripgrepAsset();
  // Absolute before any path is built: extraction runs with the work directory as its cwd.
  const dir = resolve(options.dir ?? process.env.HKN_RIPGREP_DIR ?? defaultRipgrepDir(asset));
  const target = join(dir, asset.executable);
  if (await pinned(target, asset)) return target;
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
    const actual = await sha256File(extracted);
    if (actual !== asset.binarySha256)
      throw fail(`${asset.name}/${asset.executable} SHA-256 mismatch: expected ${asset.binarySha256}, got ${actual}`);
    if (process.platform !== "win32") await chmod(extracted, 0o755);
    // Move it into place before it ever runs: on Windows a just-run (or
    // just-written) executable can stay locked for a moment, and moving or
    // deleting it then failed in 3 of 250 local runs (README). Only the tools
    // drive seeds, so a concurrent writer means two test runs on one machine;
    // its pinned copy is kept. A stale file is replaced.
    if ((await isFile(target)) && !(await pinned(target, asset))) await unlocked(() => rm(target, { force: true }));
    try {
      await unlocked(() => rename(extracted, target));
    } catch (error) {
      if (await pinned(target, asset)) return target;
      throw error;
    }
    const version = await (options.versionOf ?? versionOf)(target);
    if (!version?.startsWith(`ripgrep ${RIPGREP_VERSION}`)) {
      await rm(target, { force: true }).catch(() => {});
      throw fail(`${target} reports ${JSON.stringify(version)}, expected ripgrep ${RIPGREP_VERSION}`);
    }
    return target;
  } finally {
    // A leftover temporary directory is harmless; failing to remove one is not a failed seed.
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

/** Retries the transient Windows lock errors on a freshly written executable (about 4.5 s at most). */
async function unlocked(operation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 10 || !["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/**
 * Copy the pinned ripgrep to where the harness looks under `cacheHome` (its
 * XDG_CACHE_HOME): `<cacheHome>/opencode/bin/rg`, `rg.exe` on Windows. The copy
 * is checked against the pin and given `SEED_MTIME`.
 */
export async function seedRipgrep(cacheHome, options = {}) {
  const asset = options.asset ?? ripgrepAsset();
  const source = await ensureRipgrep({ ...options, asset });
  const bin = resolve(cacheHome, "opencode", "bin");
  await mkdir(bin, { recursive: true });
  const seeded = join(bin, asset.executable);
  await copyFile(source, seeded);
  if (process.platform !== "win32") await chmod(seeded, 0o755);
  if (!(await pinned(seeded, asset))) throw fail(`${seeded} is not the pinned executable after copying`);
  await utimes(seeded, SEED_MTIME, SEED_MTIME);
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

const isRipgrep = (command) => /^rg(\.exe)?$/i.test(command.split(/[\\/]/).at(-1));
const samePath = (a, b) =>
  process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/**
 * Checks the harness log of one run for evidence that it fetched ripgrep:
 *
 * - any line naming the release download, by the harness's message
 *   (`downloading ripgrep`), the release URL, or an archive name (the
 *   extraction of 2.0.17 logs it), at any level;
 * - no INFO line from the harness server (`role=server`), where the bootstrap
 *   runs and logs: such a log could not show a download, however named. The
 *   `--version` and `run` processes log as `role=cli` and do not count;
 * - a ripgrep process other than `expected` logged by the server;
 * - when the log reaches the tool calls (`coversTools`: a server line at or
 *   after `toolsFrom`, the first glob/grep call), on a build whose server logs
 *   the processes it starts (2.0.17), no ripgrep among them.
 *
 * Only server spawns count: the run CLI logs its own spawn of `opencode serve`
 * (role=cli). The server's later lines can be missing from the file even when
 * the run succeeded: a CI log ended before glob was called, with both tools
 * completed (README, "ripgrep pre-seed"). Such a log is reported with
 * `coversTools: false`; it can show neither a download nor which rg ran, so
 * only the download scan of what it has and verifyRipgrepSeed's file check
 * apply to it.
 *
 * Text-based: a build that downloads without logging the URL, the archive or
 * its processes is caught only by verifyRipgrepSeed's file check.
 */
export function checkRipgrepLog(text, { expected, where = "the harness log", toolsFrom } = {}) {
  const lines = text.split(/\r?\n/);
  const fetched = lines.find(
    (line) =>
      line.includes('message="downloading ripgrep"') ||
      line.includes("github.com/BurntSushi/ripgrep") ||
      /ripgrep-\d+\.\d+\.\d+-[\w.-]+\.(?:zip|tar\.gz)/.test(line),
  );
  if (fetched) throw new Error(`OpenCode downloaded ripgrep despite the pre-seed (${where}): ${fetched}`);
  if (!lines.some((line) => / level=INFO /.test(line) && / role=server(?:\s|$)/.test(line)))
    throw new Error(`no INFO line from the harness server in ${where}; cannot tell whether it downloaded ripgrep`);
  const server = serverLines(lines);
  const coversTools = Number.isFinite(toolsFrom) && server.some((line) => timeOf(line) >= toolsFrom);
  const processes = server.map(spawnedCommand).filter(Boolean);
  const spawned = [...new Set(processes.filter(isRipgrep))];
  if (coversTools && processes.length && !spawned.length)
    throw new Error(`the harness server logged the processes it started but no ripgrep among them (${where})`);
  const other = expected ? spawned.filter((command) => !samePath(command, expected)) : [];
  if (other.length) throw new Error(`OpenCode ran ${other[0]}, not the expected ripgrep ${expected} (${where})`);
  return { spawned, coversTools };
}

const roleOf = (line) => / role=(\w+)(?:\s|$)/.exec(line)?.[1];
const runOf = (line) => / run=(\S+)/.exec(line)?.[1];

/**
 * The server process's lines: those tagged role=server, and untagged lines
 * from a run that has role=server lines. 2.0.17 leaves some of its server's
 * `watcher subscribe` and `event` lines untagged, under the server's run id;
 * a role=cli line never counts, although the serve process logs its own
 * `cli starting` under that same run id.
 */
function serverLines(lines) {
  const runs = new Set(lines.filter((line) => roleOf(line) === "server").map(runOf));
  return lines.filter((line) => roleOf(line) === "server" || (roleOf(line) === undefined && runs.has(runOf(line))));
}
const timeOf = (line) => Date.parse(/^timestamp=(\S+)/.exec(line)?.[1] ?? "");

/**
 * When glob or grep was first called (epoch ms), from the capture plugin's
 * rows: the session.tool.called event of an execute.before for either tool.
 * NaN when neither was called.
 */
export function searchToolsCalledAt(captured) {
  const ids = captured
    .filter((row) => row.hook === "execute.before" && ["glob", "grep"].includes(row.event?.tool))
    .map((row) => row.event.id);
  const times = captured
    .filter((row) => row.hook === "event" && row.event?.type === "session.tool.called" && ids.includes(row.event.data?.id))
    .map((row) => row.event.created);
  return times.length ? Math.min(...times) : NaN;
}

/**
 * Where the harness's PATH lookup finds `name` first, if anywhere: like a
 * `which`, a POSIX candidate must be executable, and a Windows PATH entry may be
 * quoted.
 */
export async function findOnPath(name, searchPath = "") {
  for (const entry of searchPath.split(delimiter)) {
    const dir = process.platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!dir) continue;
    const candidate = join(dir, name);
    if (!(await isFile(candidate))) continue;
    if (process.platform !== "win32" && !(await access(candidate, constants.X_OK).then(() => true, () => false)))
      continue;
    return candidate;
  }
  return undefined;
}

/**
 * After a run: checkRipgrepLog over the harness logs under `dataHome` (its
 * XDG_DATA_HOME), expecting the seeded ripgrep unless the harness's PATH holds
 * one, which it looks up first; and the seeded file still carries SEED_MTIME,
 * so nothing replaced it. `toolsFrom` is searchToolsCalledAt's time.
 */
export async function verifyRipgrepSeed(seed, dataHome, searchPath, toolsFrom) {
  const dir = resolve(dataHome, "opencode", "log");
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".log"));
  const text = (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).join("\n");
  const onPath = await findOnPath(basename(seed.seeded), searchPath);
  const expected = onPath ?? seed.seeded;
  const { spawned, coversTools } = checkRipgrepLog(text, { expected, where: dir, toolsFrom });
  const info = await stat(seed.seeded).catch(() => undefined);
  if (!info || Math.round(info.mtimeMs / 1000) !== SEED_MTIME.getTime() / 1000)
    throw new Error(
      `the seeded ${seed.seeded} was ${info ? `replaced (modified ${info.mtime.toISOString()})` : "removed"} during the run`,
    );
  return { expected, spawned, coversTools };
}
