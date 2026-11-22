import type * as fs from "node:fs";
import { type BigIntStats, fsync } from "node:fs";
import type * as fsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyProject, fileHash, reconcileProject, recoverProject, supportsDirectoryFlush } from "./project-files.js";

const win32 = process.platform === "win32";
interface Flush {
  path: string;
  contents: string;
  directory: boolean;
  dev: bigint;
  ino: bigint;
}
/** One io operation, in the order it completed, for the ordering assertions below. */
type IoEvent =
  | { type: "open"; path: string }
  | { type: "fsync"; path: string; contents: string; directory: boolean }
  | { type: "rename"; from: string; to: string }
  | { type: "rm"; path: string }
  | { type: "link"; from: string; to: string };

const io = vi.hoisted(() => ({
  /** Give every opened handle a `sync()` and `datasync()` that throw, as Yarn's patched `FileHandle` does. */
  notImplemented: false,
  /** Fail the flush of a file with EIO, chosen by its path and what was written to it. */
  failFlush: undefined as ((path: string, written: string) => boolean) | undefined,
  /** Fail the next directory flush chosen by its path with EIO, once. */
  failDirectoryFlush: undefined as ((path: string) => boolean) | undefined,
  /** Fail every directory flush chosen by its path, with the error it returns. */
  failEveryDirectoryFlush: undefined as ((path: string) => NodeJS.ErrnoException | undefined) | undefined,
  /** Fail the next open chosen by its path, with the error it returns. */
  failOpen: undefined as ((path: string) => NodeJS.ErrnoException | undefined) | undefined,
  /** Fail the next open chosen by its raw requested path, with the error it returns. */
  failRawOpen: undefined as ((path: string) => NodeJS.ErrnoException | undefined) | undefined,
  /** Fail the next canonicalization chosen by its path, with the error it returns. */
  failRealpath: undefined as ((path: string) => NodeJS.ErrnoException | undefined) | undefined,
  /** Fail the next rename chosen by its source and destination, with the error it returns. */
  failRename: undefined as ((from: string, to: string) => NodeJS.ErrnoException | undefined) | undefined,
  /** Fail the next removal chosen by its path, with the error it returns. */
  failRm: undefined as ((path: string) => NodeJS.ErrnoException | undefined) | undefined,
  /** Swap the tree once, just before the open of the path it names and after the flush revalidates it. */
  swapBeforeOpen: undefined as { path: string; run: () => Promise<void> } | undefined,
  /** Every removal attempt, including failed ones. */
  rmAttempts: [] as string[],
  /** Every raw open request, before any mapping, failure hook or actual open. */
  openRequests: [] as string[],
  /** Every close attempt, in order. */
  closeAttempts: [] as string[],
  /** Close the file chosen by its path, then fail that close once with EIO. */
  failClose: undefined as ((path: string) => boolean) | undefined,
  /** Return a custom close error for the path chosen; every close is considered. */
  failCloseWith: undefined as ((path: string) => NodeJS.ErrnoException | undefined) | undefined,
  /** The path each open descriptor belongs to. */
  paths: new Map<number, string>(),
  /** What each handle wrote, by path. */
  written: new Map<string, string>(),
  /** Each completed flush, in order: the file's path, its contents on disk then, and whether it is a directory. */
  flushes: [] as Flush[],
  /** Flushes that failed, so a test can prove the failure was reached without counting it as completed. */
  failedFlushes: [] as Flush[],
  /** Unexpected fstat failures in the fsync mock; afterEach requires none. */
  fstatFailures: [] as unknown[],
  /** Every completed open, flush, rename, removal and link, in order. */
  events: [] as IoEvent[],
  /** Every successful directory open; the Windows test uses `openRequests` for failed attempts too. */
  directoryOpenAttempts: [] as string[],
  /** Every completed directory open, with the descriptor's resolved identity. */
  directoryOpenIdentities: [] as { path: string; dev: bigint; ino: bigint }[],
  /** Runs once, just before the file at the path it is given is opened. */
  beforeOpen: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const requested = String(args[0]);
      io.openRequests.push(requested);
      const rawInjected = io.failRawOpen?.(requested);
      if (rawInjected) {
        io.failRawOpen = undefined;
        throw rawInjected;
      }
      let path = requested;
      const descriptor = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(requested);
      if (descriptor !== null) {
        const parent = io.paths.get(Number(descriptor[1]));
        if (parent !== undefined)
          path = descriptor[2] === undefined ? parent : join(parent, ...descriptor[2].split("/"));
      }
      const beforeOpen = io.beforeOpen;
      io.beforeOpen = undefined;
      await beforeOpen?.(path);
      const swap = io.swapBeforeOpen;
      if (swap?.path === path) {
        io.swapBeforeOpen = undefined;
        await swap.run();
      }
      const injected = io.failOpen?.(path);
      if (injected) {
        io.failOpen = undefined;
        throw injected;
      }
      const handle = await actual.open(...args);
      const opened = await handle.stat({ bigint: true });
      const directory = opened.isDirectory();
      if (directory) {
        io.directoryOpenAttempts.push(path);
        io.directoryOpenIdentities.push({ path, dev: opened.dev, ino: opened.ino });
      }
      io.paths.set(handle.fd, path);
      io.written.set(path, "");
      io.events.push({ type: "open", path });
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (data: Parameters<typeof handle.writeFile>[0], ...rest) => {
        io.written.set(path, io.written.get(path) + String(data));
        return await writeFile(data, ...rest);
      };
      const close = handle.close.bind(handle);
      handle.close = async () => {
        io.closeAttempts.push(path);
        // The descriptor really is closed first, so nothing holds the file open afterwards.
        await close();
        const failOnce = io.failClose?.(path) ?? false;
        if (failOnce) io.failClose = undefined;
        const custom = io.failCloseWith?.(path);
        if (failOnce || custom !== undefined)
          throw custom ?? Object.assign(new Error("EIO: i/o error, close"), { code: "EIO", syscall: "close" });
      };
      if (io.notImplemented) {
        // Not async: Yarn's methods throw before any promise exists.
        const notImplemented = () => {
          throw new Error("Method not implemented.");
        };
        handle.sync = notImplemented;
        handle.datasync = notImplemented;
      }
      return handle;
    },
    async realpath(...args: Parameters<typeof actual.realpath>) {
      const path = String(args[0]);
      const injected = io.failRealpath?.(path);
      if (injected) {
        io.failRealpath = undefined;
        throw injected;
      }
      return await actual.realpath(...args);
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      const injected = io.failRename?.(String(args[0]), String(args[1]));
      if (injected) {
        io.failRename = undefined;
        throw injected;
      }
      const result = await actual.rename(...args);
      io.events.push({ type: "rename", from: String(args[0]), to: String(args[1]) });
      return result;
    },
    async rm(...args: Parameters<typeof actual.rm>) {
      const path = String(args[0]);
      io.rmAttempts.push(path);
      const injected = io.failRm?.(path);
      if (injected) {
        io.failRm = undefined;
        throw injected;
      }
      const result = await actual.rm(...args);
      io.events.push({ type: "rm", path });
      return result;
    },
    async link(...args: Parameters<typeof actual.link>) {
      const result = await actual.link(...args);
      io.events.push({ type: "link", from: String(args[0]), to: String(args[1]) });
      return result;
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    fsync: vi.fn((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      const path = io.paths.get(fd) ?? `<fd ${fd}>`;
      // A directory is never read as a file; its identity and directory-ness
      // come from the descriptor, not a pathname that a swap can change.
      let stats: BigIntStats;
      try {
        stats = actual.fstatSync(fd, { bigint: true });
      } catch (error) {
        // A post-unlink best-effort flush could swallow this; afterEach must see it.
        io.fstatFailures.push(error);
        throw error;
      }
      const directory = stats.isDirectory();
      const flush: Flush = {
        path,
        contents: directory ? "" : actual.readFileSync(path, "utf8"),
        directory,
        dev: stats.dev,
        ino: stats.ino,
      };
      let failure: NodeJS.ErrnoException | undefined;
      if (directory) {
        if (io.failDirectoryFlush?.(path)) {
          io.failDirectoryFlush = undefined;
          failure = Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" });
        }
        failure ??= io.failEveryDirectoryFlush?.(path);
      } else if (io.failFlush?.(path, io.written.get(path) ?? "")) {
        failure = Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" });
      }
      if (failure) {
        io.failedFlushes.push(flush);
        callback(failure);
        return;
      }
      actual.fsync(fd, (error) => {
        if (error) {
          io.failedFlushes.push(flush);
          callback(error);
          return;
        }
        // Completed, so the ordering assertions below describe flushes that
        // really finished; a failed one must not appear among them.
        io.flushes.push(flush);
        io.events.push({ type: "fsync", ...flush });
        callback(null);
      });
    }),
  };
});

const descriptorWalk = process.platform === "linux" && (await supportsDirectoryFlush());
resetIo();

let root: string;
const owner = "config.ts";
const input = (value: string) => ({
  files: [
    { path: "a.txt", contents: value },
    { path: "z.txt", contents: value },
  ],
  entries: [],
  guidance: [],
});
const sync = async (value: string) => applyProject(root, owner, await reconcileProject(root, owner, input(value)));
const nestedInput = (value: string) => ({
  files: [{ path: "nested/deep/a.txt", contents: value }],
  entries: [],
  guidance: [],
});
const syncNested = async (value: string) =>
  applyProject(root, owner, await reconcileProject(root, owner, nestedInput(value)));
const journalEntry = (path: string, before: string | null, after: string | null) => ({
  path,
  before: before === null ? null : Buffer.from(before).toString("base64"),
  afterHash: after === null ? null : fileHash(after),
  mode: 0o644,
});
const journalText = (entries: ReturnType<typeof journalEntry>[]) =>
  JSON.stringify({ schemaVersion: 1, config: owner, entries });
const exists = (path: string) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );
const staging = async () => readdir(join(root, ".hooknostic/staging")).catch(() => []);
const isLock = (name: string) => (path: string) => path.endsWith(join(".hooknostic", name));
const isStaged = (path: string) => path.includes(join(".hooknostic", "staging"));
/** The recovery journal, which is staged like any file; the manifest is indented and names no entries. */
const isJournal = (contents: string) => contents.startsWith(`{"schemaVersion":1,"config":"${owner}","entries":`);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hooknostic-durability-"));
});
afterEach(async () => {
  const fstatFailures = [...io.fstatFailures];
  io.fstatFailures.length = 0;
  io.notImplemented = false;
  io.failFlush = undefined;
  io.failDirectoryFlush = undefined;
  io.failEveryDirectoryFlush = undefined;
  io.failOpen = undefined;
  io.failRawOpen = undefined;
  io.failRealpath = undefined;
  io.failRename = undefined;
  io.failRm = undefined;
  io.failClose = undefined;
  io.failCloseWith = undefined;
  io.swapBeforeOpen = undefined;
  io.paths.clear();
  io.written.clear();
  io.flushes.length = 0;
  io.failedFlushes.length = 0;
  io.events.length = 0;
  io.directoryOpenAttempts.length = 0;
  io.directoryOpenIdentities.length = 0;
  io.rmAttempts.length = 0;
  io.openRequests.length = 0;
  io.closeAttempts.length = 0;
  io.beforeOpen = undefined;
  vi.mocked(fsync).mockClear();
  await rm(root, { recursive: true, force: true });
  expect(fstatFailures, "unexpected fstatSync failures").toEqual([]);
});

/** Forgets every event so far, with the descriptors and contents that named them. */
function resetIo(): void {
  io.paths.clear();
  io.written.clear();
  io.flushes.length = 0;
  io.failedFlushes.length = 0;
  io.events.length = 0;
  io.directoryOpenAttempts.length = 0;
  io.directoryOpenIdentities.length = 0;
  io.rmAttempts.length = 0;
  io.openRequests.length = 0;
  io.closeAttempts.length = 0;
}
/** The native path of a root-relative project path, as `projectPath` spells it. */
const at = (project: string, path: string) => join(project, ...path.split("/"));

/**
 * The completed flush, rename and removal events of interest, in order and
 * labelled by the project path they concern. Opens, failed flushes and
 * unrelated operations are dropped.
 */
function orderedEvents(project: string): string[] {
  const state = at(project, ".hooknostic");
  const journal = at(project, ".hooknostic/transaction.json");
  const name = (path: string) => relative(project, path).split(sep).join("/");
  return io.events.flatMap((event) => {
    if (event.type === "fsync") {
      if (!event.directory) return isJournal(event.contents) ? ["flush journal contents"] : [];
      if (event.path === state) return ["flush .hooknostic"];
      if (event.path === project) return ["flush root"];
      return [`flush ${name(event.path)}`];
    }
    if (event.type === "rename") {
      if (event.to === journal) return ["rename journal"];
      return event.to.startsWith(project + sep) ? [`rename ${name(event.to)}`] : [];
    }
    if (event.type === "rm" && event.path === journal) return ["remove journal"];
    return [];
  });
}

/**
 * Every file a synchronization created was flushed once, after its contents
 * were written: the lock with this process's id, and each staged file with
 * what was staged, the new files' and manifest's contents among them.
 */
async function expectFlushedAfterWriting(): Promise<void> {
  for (const flush of io.flushes) {
    if (flush.directory) continue;
    expect(flush.contents, flush.path).toBe(io.written.get(flush.path));
  }
  expect(
    io.flushes.filter((flush) => !flush.directory && isLock("sync.lock")(flush.path)).map((flush) => flush.contents),
  ).toEqual([String(process.pid)]);
  const project = await realpath(root);
  for (const path of ["a.txt", "z.txt", ".hooknostic/integration.json"]) {
    const rename = io.events.find((event) => event.type === "rename" && event.to === at(project, path));
    if (rename?.type !== "rename") throw new Error(`no rename recorded for ${path}`);
    const flush = io.flushes.find((entry) => !entry.directory && entry.path === rename.from);
    expect(flush, `the staged ${path} was flushed`).toBeDefined();
    expect(flush?.contents, path).toBe(await readFile(join(root, path), "utf8"));
  }
  // The journal, staged and flushed exactly once before it was renamed into place.
  const journalRename = io.events.find(
    (event) => event.type === "rename" && event.to === at(project, ".hooknostic/transaction.json"),
  );
  if (journalRename?.type !== "rename") throw new Error("no journal rename recorded");
  const journalFlushes = io.events.filter((event) => event.type === "fsync" && event.path === journalRename.from);
  expect(journalFlushes, "the staged journal was flushed exactly once").toHaveLength(1);
  const journalFlush = journalFlushes[0];
  if (journalFlush?.type !== "fsync") throw new Error("no journal content flush recorded");
  expect(isJournal(journalFlush.contents)).toBe(true);
  expect(io.events.indexOf(journalFlush)).toBeLessThan(io.events.indexOf(journalRename));
}

it("flushes the lock and every staged file after writing it", async () => {
  await sync("one");
  await expectFlushedAfterWriting();
});

it("synchronizes and recovers when FileHandle.sync() is not implemented, as under Yarn PnP (#229)", async () => {
  io.notImplemented = true;

  await sync("one");
  await expectFlushedAfterWriting();
  resetIo();
  await sync("two");
  await expectFlushedAfterWriting();
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("two");
  expect(await readFile(join(root, "z.txt"), "utf8")).toBe("two");
  await recoverProject(root, owner);

  expect(await exists(".hooknostic/sync.lock")).toBe(false);
  expect(await exists(".hooknostic/recovery.lock")).toBe(false);
  expect(await staging()).toEqual([]);
});

it("resolves the canonical root before taking the sync lock", async () => {
  const plan = await reconcileProject(root, owner, input("one"));
  let rootCalls = 0;
  io.failRealpath = (path) => {
    if (path !== root) return undefined;
    rootCalls += 1;
    // The first call is applyProject's canonicalization in the fixed order;
    // the second would be acquire's projectPath. After the mutation, the
    // second is the canonicalization and the lock is already held.
    return rootCalls === 2
      ? Object.assign(new Error("injected realpath failure"), { code: "EIO", syscall: "realpath" })
      : undefined;
  };

  await expect(applyProject(root, owner, plan)).rejects.toThrow("injected realpath failure");
  expect(io.failRealpath).toBeUndefined();
  expect(await exists(".hooknostic/sync.lock")).toBe(false);
});

it.runIf(process.platform === "linux")("requires a working Linux descriptor traversal probe", () => {
  expect(
    descriptorWalk,
    "Linux /proc/self/fd descriptor traversal is unavailable; refusing to skip the directory-flush regressions silently",
  ).toBe(true);
});

it.skipIf(!descriptorWalk)("skips directory flushing when only descriptor traversal is masked", async () => {
  vi.resetModules();
  const fresh = await import("./project-files.js");
  const plan = await fresh.reconcileProject(root, owner, input("one"));
  io.openRequests.length = 0;
  io.failRawOpen = (requested) =>
    requested.startsWith("/proc/self/fd/")
      ? Object.assign(new Error("ENOENT: no such file or directory, open"), { code: "ENOENT", syscall: "open" })
      : undefined;

  expect(await fresh.supportsDirectoryFlush()).toBe(false);
  // The failed result is cached: a second call does not probe again.
  expect(await fresh.supportsDirectoryFlush()).toBe(false);
  expect(io.failRawOpen).toBeUndefined();
  await fresh.applyProject(root, owner, plan);

  // Exactly the two probe opens across both capability calls and the sync.
  expect(io.openRequests.filter((path) => path === "/proc/self/fd")).toHaveLength(1);
  expect(io.openRequests.filter((path) => path.startsWith("/proc/self/fd/"))).toHaveLength(1);
  expect(io.flushes.filter((flush) => flush.directory)).toEqual([]);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
});

it.skipIf(!descriptorWalk)("rejects ENOENT for a component after a successful probe", async () => {
  const project = await realpath(root);
  await mkdir(join(root, ".hooknostic"), { recursive: true });
  await writeFile(
    join(root, ".hooknostic/transaction.json"),
    journalText([journalEntry("nested/deep/file.txt", "before", null)]),
  );
  resetIo();
  expect(await supportsDirectoryFlush()).toBe(true);
  io.failOpen = (path) =>
    path === at(project, "nested")
      ? Object.assign(new Error("ENOENT: no such file or directory, open"), { code: "ENOENT", syscall: "open" })
      : undefined;

  await expect(recoverProject(root, owner)).rejects.toMatchObject({ code: "ENOENT" });
  expect(io.failOpen).toBeUndefined();
  expect(await exists(".hooknostic/transaction.json")).toBe(true);
  expect(io.rmAttempts).not.toContain(at(project, ".hooknostic/transaction.json"));
});

describe("directory flushes make each rename durable before the next step", () => {
  it.skipIf(!descriptorWalk)(
    "flushes the journal directories, each destination directory, then the commit point",
    async () => {
      const project = await realpath(root);

      await sync("one");

      expect(orderedEvents(project)).toEqual([
        "flush journal contents",
        "rename journal",
        "flush .hooknostic",
        "flush root",
        "rename a.txt",
        "rename z.txt",
        "rename .hooknostic/integration.json",
        "flush root",
        "flush .hooknostic",
        "remove journal",
        "flush .hooknostic",
      ]);
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
      expect(await exists(".hooknostic/transaction.json")).toBe(false);
    },
  );

  it.runIf(win32)("skips directory flushes on Windows, where fsync cannot flush a directory", async () => {
    const project = await realpath(root);
    // The recorder must see failed opens too, or a failed probe attempt would
    // be invisible below.
    await expect(open(join(root, "missing"), "r")).rejects.toMatchObject({ code: "ENOENT" });
    expect(io.openRequests).toContain(join(root, "missing"));
    resetIo();

    await sync("one");

    expect(io.directoryOpenAttempts).toEqual([]);
    expect(io.openRequests.filter((path) => path === "/proc/self/fd" || path.startsWith("/proc/self/fd/"))).toEqual([]);
    expect(io.openRequests).not.toContain(project);
    expect(io.flushes.filter((flush) => flush.directory)).toEqual([]);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)("rejects a failed journal-directory flush and rolls back", async () => {
    const project = await realpath(root);
    await sync("before");
    resetIo();
    io.failDirectoryFlush = (path) => path === at(project, ".hooknostic");

    await expect(sync("after")).rejects.toMatchObject({ code: "EIO", syscall: "fsync" });
    expect(io.failDirectoryFlush).toBeUndefined();
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
    expect(await exists(".hooknostic/sync.lock")).toBe(false);
    expect(await staging()).toEqual([]);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("before");

    await sync("after");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after");
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("after");
  });

  it.skipIf(!descriptorWalk)("rejects a failed destination-directory flush after a rename and rolls back", async () => {
    const project = await realpath(root);
    const renamed = () => io.events.some((event) => event.type === "rename" && event.to === at(project, "a.txt"));
    await sync("before");
    resetIo();
    let afterRename = false;
    io.failDirectoryFlush = (path) => {
      if (path !== project) return false;
      afterRename = renamed();
      return afterRename;
    };

    await expect(sync("after")).rejects.toMatchObject({ code: "EIO", syscall: "fsync" });
    // The failure hit the flush after the renames, not the journal's root flush.
    expect(afterRename).toBe(true);
    expect(io.failDirectoryFlush).toBeUndefined();
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
    expect(await exists(".hooknostic/sync.lock")).toBe(false);
    expect(await staging()).toEqual([]);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("before");
    // Only completed flushes count: the failed post-rename flush is absent,
    // while the journal's earlier root flush and rollback's completed one are.
    expect(
      io.events.filter((event) => event.type === "fsync" && event.directory && event.path === project),
    ).toHaveLength(2);
    expect(io.failedFlushes.filter((flush) => flush.directory && flush.path === project)).toHaveLength(1);

    await sync("after");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after");
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("after");
  });

  it.skipIf(!descriptorWalk)(
    "flushes restored directories before removing the journal, then the journal directory",
    async () => {
      const project = await realpath(root);
      await mkdir(join(root, ".hooknostic"), { recursive: true });
      await writeFile(join(root, "a.txt"), "after");
      await writeFile(
        join(root, ".hooknostic/transaction.json"),
        JSON.stringify({
          schemaVersion: 1,
          config: owner,
          entries: [
            {
              path: "a.txt",
              before: Buffer.from("before").toString("base64"),
              afterHash: fileHash("after"),
              mode: 0o644,
            },
          ],
        }),
      );
      resetIo();

      await recoverProject(root, owner);

      expect(orderedEvents(project)).toEqual(["rename a.txt", "flush root", "remove journal", "flush .hooknostic"]);
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
      expect(await exists(".hooknostic/transaction.json")).toBe(false);
    },
  );

  it.skipIf(!descriptorWalk)("flushes every newly created ancestor of a nested destination", async () => {
    const project = await realpath(root);

    await syncNested("one");

    expect(orderedEvents(project)).toEqual([
      "flush journal contents",
      "rename journal",
      "flush .hooknostic",
      "flush root",
      "rename nested/deep/a.txt",
      "rename .hooknostic/integration.json",
      "flush root",
      "flush .hooknostic",
      "flush nested",
      "flush nested/deep",
      "remove journal",
      "flush .hooknostic",
    ]);
    expect(await readFile(join(root, "nested/deep/a.txt"), "utf8")).toBe("one");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)("flushes directories created while restoring a missing nested path", async () => {
    const project = await realpath(root);
    await mkdir(join(root, ".hooknostic"), { recursive: true });
    await writeFile(
      join(root, ".hooknostic/transaction.json"),
      journalText([journalEntry("nested/deep/a.txt", "before", null)]),
    );
    resetIo();

    await recoverProject(root, owner);

    expect(orderedEvents(project)).toEqual([
      "rename nested/deep/a.txt",
      "flush root",
      "flush nested",
      "flush nested/deep",
      "remove journal",
      "flush .hooknostic",
    ]);
    expect(await readFile(join(root, "nested/deep/a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)("repeats the parent flush on a retried recovery before removing the journal", async () => {
    const project = await realpath(root);
    await mkdir(join(root, ".hooknostic"), { recursive: true });
    await writeFile(join(root, "a.txt"), "after");
    await writeFile(
      join(root, ".hooknostic/transaction.json"),
      journalText([journalEntry("a.txt", "before", "after")]),
    );
    resetIo();
    let rootFlushes = 0;
    io.failEveryDirectoryFlush = (path) => {
      if (path !== project) return undefined;
      rootFlushes += 1;
      return Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" });
    };

    await expect(recoverProject(root, owner)).rejects.toMatchObject({ code: "EIO" });
    expect(rootFlushes).toBe(1);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(true);

    // The file is already at its preimage, so nothing is replaced this time;
    // the parent must still be flushed before the journal can be removed.
    await expect(recoverProject(root, owner)).rejects.toMatchObject({ code: "EIO" });
    expect(rootFlushes).toBe(2);
    expect(await exists(".hooknostic/transaction.json")).toBe(true);

    io.failEveryDirectoryFlush = undefined;
    await recoverProject(root, owner);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)("flushes intermediate ancestors on a retry that replaces nothing", async () => {
    const project = await realpath(root);
    await mkdir(join(root, ".hooknostic"), { recursive: true });
    await writeFile(
      join(root, ".hooknostic/transaction.json"),
      journalText([journalEntry("nested/deep/a.txt", "before", null)]),
    );
    resetIo();
    let nestedFlushes = 0;
    io.failEveryDirectoryFlush = (path) => {
      if (path !== at(project, "nested")) return undefined;
      nestedFlushes += 1;
      return Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" });
    };

    await expect(recoverProject(root, owner)).rejects.toMatchObject({ code: "EIO" });
    expect(nestedFlushes).toBe(1);
    expect(await readFile(join(root, "nested/deep/a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(true);

    // The retry replaces nothing, because the file is already at its preimage.
    // It must still walk back up through `nested`, not only flush `deep`.
    resetIo();
    await expect(recoverProject(root, owner)).rejects.toMatchObject({ code: "EIO" });
    expect(nestedFlushes).toBe(2);
    expect(io.events.some((event) => event.type === "rename")).toBe(false);
    expect(await exists(".hooknostic/transaction.json")).toBe(true);

    io.failEveryDirectoryFlush = undefined;
    await recoverProject(root, owner);
    expect(await readFile(join(root, "nested/deep/a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)(
    "flushes the pinned directory when a parent is swapped after its descriptor opens",
    async () => {
      const project = await realpath(root);
      const outside = await mkdtemp(join(tmpdir(), "hooknostic-outside-"));
      try {
        await mkdir(join(outside, "deep"), { recursive: true });
        await mkdir(join(root, ".hooknostic"), { recursive: true });
        await writeFile(
          join(root, ".hooknostic/transaction.json"),
          journalText([journalEntry("nested/deep/file.txt", "before", null)]),
        );
        resetIo();
        const nested = at(project, "nested");
        const nestedReal = at(project, "nested.real");
        io.swapBeforeOpen = {
          path: at(project, "nested/deep"),
          run: async () => {
            await rename(nested, nestedReal);
            await symlink(outside, nested, "dir");
          },
        };

        // The parent descriptor is already pinned, so the child resolves through
        // it and the pinned directory is flushed rather than the symlink target.
        await recoverProject(root, owner);
        const moved = await stat(join(root, "nested.real/deep"), { bigint: true });
        const outsideDeep = await stat(join(outside, "deep"), { bigint: true });
        const flush = io.flushes.find((entry) => entry.directory && entry.path === at(project, "nested/deep"));
        expect(flush, "the pinned directory was flushed").toBeDefined();
        expect(flush?.dev).toBe(moved.dev);
        expect(flush?.ino).toBe(moved.ino);
        expect({ dev: flush?.dev, ino: flush?.ino }).not.toEqual({
          dev: outsideDeep.dev,
          ino: outsideDeep.ino,
        });
        expect(
          io.directoryOpenIdentities.some(
            (identity) => identity.dev === outsideDeep.dev && identity.ino === outsideDeep.ino,
          ),
        ).toBe(false);
        expect(await readFile(join(root, "nested.real/deep/file.txt"), "utf8")).toBe("before");
        expect(await exists(".hooknostic/transaction.json")).toBe(false);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!descriptorWalk)("rejects a parent swapped for a symlink before its descriptor opens", async () => {
    const project = await realpath(root);
    const outside = await mkdtemp(join(tmpdir(), "hooknostic-outside-"));
    try {
      await mkdir(join(outside, "deep"), { recursive: true });
      await mkdir(join(root, ".hooknostic"), { recursive: true });
      await writeFile(
        join(root, ".hooknostic/transaction.json"),
        journalText([journalEntry("nested/deep/file.txt", "before", null)]),
      );
      resetIo();
      const nested = at(project, "nested");
      const nestedReal = at(project, "nested.real");
      io.swapBeforeOpen = {
        path: nested,
        run: async () => {
          await rename(nested, nestedReal);
          await symlink(outside, nested, "dir");
        },
      };

      await expect(recoverProject(root, owner)).rejects.toThrow("directory changed while flushing");
      expect(await exists(".hooknostic/transaction.json")).toBe(true);
      expect(io.rmAttempts).not.toContain(at(project, ".hooknostic/transaction.json"));
      const outsideDeep = await stat(join(outside, "deep"), { bigint: true });
      expect(
        io.directoryOpenIdentities.some(
          (identity) => identity.dev === outsideDeep.dev && identity.ino === outsideDeep.ino,
        ),
      ).toBe(false);
      expect(await readFile(join(root, "nested.real/deep/file.txt"), "utf8")).toBe("before");

      await rm(nested, { force: true });
      await rename(nestedReal, nested);
      await recoverProject(root, owner);
      expect(await readFile(join(root, "nested/deep/file.txt"), "utf8")).toBe("before");
      expect(await exists(".hooknostic/transaction.json")).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(!descriptorWalk)("surfaces an intermediate parent close failure", async () => {
    const project = await realpath(root);
    await mkdir(join(root, ".hooknostic"), { recursive: true });
    await writeFile(
      join(root, ".hooknostic/transaction.json"),
      journalText([journalEntry("nested/deep/file.txt", "before", null)]),
    );
    resetIo();
    let rootCloses = 0;
    io.failCloseWith = (path) => {
      if (path === project) {
        rootCloses += 1;
        // The root's own final close succeeds; its close as the intermediate
        // parent of `nested` fails.
        if (rootCloses === 2)
          return Object.assign(new Error("injected parent close failure"), { code: "EIO", syscall: "close" });
      }
      if (path === at(project, "nested"))
        return Object.assign(new Error("injected child close failure"), { code: "EIO", syscall: "close" });
      return undefined;
    };

    const failure = await recoverProject(root, owner).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("injected parent close failure");
    expect((failure as Error).message).not.toContain("injected child close failure");
    expect(io.closeAttempts).toContain(at(project, "nested"));
    expect(await exists(".hooknostic/transaction.json")).toBe(true);
  });

  it.skipIf(!descriptorWalk)("skips a directory open the filesystem does not support", async () => {
    const project = await realpath(root);
    io.failOpen = (path) =>
      path === at(project, ".hooknostic")
        ? Object.assign(new Error("EOPNOTSUPP: operation not supported, open"), {
            code: "EOPNOTSUPP",
            syscall: "open",
          })
        : undefined;

    await sync("one");

    expect(io.failOpen).toBeUndefined();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)("rejects a real directory open failure and rolls back", async () => {
    const project = await realpath(root);
    await sync("before");
    resetIo();
    io.failOpen = (path) =>
      path === at(project, ".hooknostic")
        ? Object.assign(new Error("EIO: i/o error, open"), { code: "EIO", syscall: "open" })
        : undefined;

    await expect(sync("after")).rejects.toMatchObject({ code: "EIO", syscall: "open" });
    expect(io.failOpen).toBeUndefined();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
    expect(await exists(".hooknostic/sync.lock")).toBe(false);
    expect(await staging()).toEqual([]);
  });

  it.skipIf(!descriptorWalk)("names both failures and keeps the journal when rollback fails", async () => {
    const project = await realpath(root);
    await sync("before");
    resetIo();
    let rootFlushes = 0;
    io.failEveryDirectoryFlush = (path) => {
      if (path !== project) return undefined;
      rootFlushes += 1;
      if (rootFlushes === 1)
        return Object.assign(new Error("injected journal-directory flush failure"), {
          code: "EIO",
          syscall: "fsync",
        });
      if (rootFlushes === 2)
        return Object.assign(new Error("injected rollback-directory flush failure"), {
          code: "EIO",
          syscall: "fsync",
        });
      return undefined;
    };

    const failure = await sync("after").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.message).toContain("injected journal-directory flush failure");
    expect(error.message).toContain("injected rollback-directory flush failure");
    expect(error.message).toContain("transaction journal remains");
    expect(error.message).toContain("hooknostic recover with the same configuration");
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect((error.cause as AggregateError).errors).toHaveLength(2);
    expect(await exists(".hooknostic/transaction.json")).toBe(true);
    expect(await exists(".hooknostic/sync.lock")).toBe(false);
    expect(await staging()).toEqual([]);

    io.failEveryDirectoryFlush = undefined;
    await recoverProject(root, owner);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)("ignores a failed commit flush after the journal is removed", async () => {
    const project = await realpath(root);
    await sync("before");
    resetIo();
    const state = at(project, ".hooknostic");
    const journal = at(project, ".hooknostic/transaction.json");
    io.failDirectoryFlush = (path) =>
      path === state && io.events.some((event) => event.type === "rm" && event.path === journal);

    await sync("after");

    expect(io.failDirectoryFlush).toBeUndefined();
    expect(io.failedFlushes.filter((flush) => flush.directory && flush.path === state)).toHaveLength(1);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)("ignores a failed commit flush after recovery removes the journal", async () => {
    const project = await realpath(root);
    await mkdir(join(root, ".hooknostic"), { recursive: true });
    await writeFile(join(root, "a.txt"), "after");
    await writeFile(
      join(root, ".hooknostic/transaction.json"),
      journalText([journalEntry("a.txt", "before", "after")]),
    );
    resetIo();
    const state = at(project, ".hooknostic");
    const journal = at(project, ".hooknostic/transaction.json");
    io.failDirectoryFlush = (path) =>
      path === state && io.events.some((event) => event.type === "rm" && event.path === journal);

    await recoverProject(root, owner);

    expect(io.failDirectoryFlush).toBeUndefined();
    expect(io.failedFlushes.filter((flush) => flush.directory && flush.path === state)).toHaveLength(1);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it("reports a failed replacement, not a failed staged cleanup", async () => {
    const project = await realpath(root);
    await sync("before");
    resetIo();
    let failedSource = "";
    io.failRename = (from, to) => {
      if (to !== at(project, "a.txt")) return undefined;
      failedSource = from;
      return Object.assign(new Error("injected replacement rename failure"), { code: "EIO", syscall: "rename" });
    };
    io.failRm = (path) =>
      isStaged(path)
        ? Object.assign(new Error("injected staged cleanup failure"), { code: "EIO", syscall: "unlink" })
        : undefined;

    const failure = await sync("after").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("injected replacement rename failure");
    expect((failure as Error).message).not.toContain("injected staged cleanup failure");
    expect(io.failRm).toBeUndefined();
    expect(failedSource).not.toBe("");
    expect(io.rmAttempts.filter((path) => path === failedSource)).toHaveLength(1);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(!descriptorWalk)("reports a restore failure, not a failed lock release", async () => {
    const project = await realpath(root);
    await mkdir(join(root, ".hooknostic"), { recursive: true });
    await writeFile(join(root, "a.txt"), "after");
    await writeFile(
      join(root, ".hooknostic/transaction.json"),
      journalText([journalEntry("a.txt", "before", "after")]),
    );
    resetIo();
    io.failEveryDirectoryFlush = (path) =>
      path === project
        ? Object.assign(new Error("injected restore flush failure"), { code: "EIO", syscall: "fsync" })
        : undefined;
    io.failRm = (path) =>
      path.endsWith(join(".hooknostic", "sync.lock"))
        ? Object.assign(new Error("injected sync lock removal failure"), { code: "EIO", syscall: "unlink" })
        : undefined;

    const failure = await recoverProject(root, owner).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("injected restore flush failure");
    expect((failure as Error).message).not.toContain("injected sync lock removal failure");
    expect(io.failRm).toBeUndefined();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await exists(".hooknostic/transaction.json")).toBe(true);
    expect(await exists(".hooknostic/sync.lock")).toBe(true);
    expect(await exists(".hooknostic/recovery.lock")).toBe(false);
  });
});

describe("a failed flush aborts and leaves nothing behind", () => {
  it.each([
    { name: "the lock", fail: isLock("sync.lock") },
    { name: "a staged file", fail: (path: string, written: string) => isStaged(path) && written === "after" },
    { name: "the journal", fail: (path: string, written: string) => isStaged(path) && isJournal(written) },
  ])("in synchronization, at $name", async ({ fail }) => {
    await sync("before");
    io.failFlush = fail;

    await expect(sync("after")).rejects.toMatchObject({ code: "EIO" });
    expect(io.failedFlushes.some((flush) => fail(flush.path, io.written.get(flush.path) ?? ""))).toBe(true);
    expect(await exists(".hooknostic/sync.lock")).toBe(false);
    expect(await staging()).toEqual([]);
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("before");

    io.failFlush = undefined;
    await sync("after");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after");
  });

  it("in recovery, at its lock", async () => {
    io.failFlush = isLock("recovery.lock");

    await expect(recoverProject(root, owner)).rejects.toMatchObject({ code: "EIO" });
    expect(await exists(".hooknostic/recovery.lock")).toBe(false);

    io.failFlush = undefined;
    await recoverProject(root, owner);
    expect(await exists(".hooknostic/recovery.lock")).toBe(false);
    expect(await exists(".hooknostic/sync.lock")).toBe(false);
  });
});

it("names the other recover when one takes the recovery lock first (#267)", async () => {
  const lock = join(await realpath(root), ".hooknostic", "recovery.lock");
  // A peer recover creates its lock after this one found none and before it creates its own.
  io.beforeOpen = async (path) => {
    if (path === lock) await writeFile(lock, String(process.pid));
  };

  await expect(recoverProject(root, owner)).rejects.toMatchObject({
    message: `another hooknostic recover may be running: ${lock} exists; rerun hooknostic recover, which removes a lock whose recorded process ID has exited`,
    code: "EEXIST",
    path: lock,
    cause: { code: "EEXIST", path: lock },
  });
  expect(await readFile(lock, "utf8")).toBe(String(process.pid));
});

it("removes the lock when closing it fails after a successful flush", async () => {
  await sync("before");
  io.failClose = isLock("sync.lock");

  await expect(sync("after")).rejects.toMatchObject({ code: "EIO", syscall: "close" });
  expect(io.failClose).toBeUndefined();
  expect(await exists(".hooknostic/sync.lock")).toBe(false);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");

  await sync("after");
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after");
});

it("reports a failed flush, not the failed close after it", async () => {
  io.failFlush = isLock("sync.lock");
  io.failClose = isLock("sync.lock");

  await expect(sync("one")).rejects.toMatchObject({ code: "EIO", syscall: "fsync" });
  expect(io.failClose).toBeUndefined();
  expect(await exists(".hooknostic/sync.lock")).toBe(false);
});
