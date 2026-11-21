import type * as fs from "node:fs";
import { fsync } from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyProject, fileHash, reconcileProject, recoverProject } from "./project-files.js";

const win32 = process.platform === "win32";
interface Flush {
  path: string;
  contents: string;
  directory: boolean;
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
  /** Close the file chosen by its path, then fail that close once with EIO. */
  failClose: undefined as ((path: string) => boolean) | undefined,
  /** The path each open descriptor belongs to. */
  paths: new Map<number, string>(),
  /** What each handle wrote, by path. */
  written: new Map<string, string>(),
  /** Each flush, in order: the file's path, its contents on disk at that moment, and whether it is a directory. */
  flushes: [] as Flush[],
  /** Every open, flush, rename, removal and link, in completion order. */
  events: [] as IoEvent[],
  /** Runs once, just before the file at the path it is given is opened. */
  beforeOpen: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const path = String(args[0]);
      const beforeOpen = io.beforeOpen;
      io.beforeOpen = undefined;
      await beforeOpen?.(path);
      const handle = await actual.open(...args);
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
        // The descriptor really is closed first, so nothing holds the file open afterwards.
        await close();
        if (io.failClose?.(path)) {
          io.failClose = undefined;
          throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO", syscall: "close" });
        }
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
    async rename(...args: Parameters<typeof actual.rename>) {
      const result = await actual.rename(...args);
      io.events.push({ type: "rename", from: String(args[0]), to: String(args[1]) });
      return result;
    },
    async rm(...args: Parameters<typeof actual.rm>) {
      const result = await actual.rm(...args);
      io.events.push({ type: "rm", path: String(args[0]) });
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
      // A directory is never read as a file; its contents are the entries a
      // filesystem flush persists, not bytes to compare.
      let directory = false;
      try {
        directory = actual.statSync(path).isDirectory();
      } catch {
        directory = false;
      }
      const contents = directory ? "" : actual.readFileSync(path, "utf8");
      io.flushes.push({ path, contents, directory });
      io.events.push({ type: "fsync", path, contents, directory });
      if (directory) {
        if (io.failDirectoryFlush?.(path)) {
          io.failDirectoryFlush = undefined;
          callback(Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" }));
          return;
        }
      } else if (io.failFlush?.(path, io.written.get(path) ?? "")) {
        callback(Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" }));
        return;
      }
      actual.fsync(fd, callback);
    }),
  };
});

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
  io.notImplemented = false;
  io.failFlush = undefined;
  io.failDirectoryFlush = undefined;
  io.failClose = undefined;
  io.paths.clear();
  io.written.clear();
  io.flushes.length = 0;
  io.events.length = 0;
  io.beforeOpen = undefined;
  vi.mocked(fsync).mockClear();
  await rm(root, { recursive: true, force: true });
});

/** Forgets every event so far, with the descriptors and contents that named them. */
function resetIo(): void {
  io.paths.clear();
  io.written.clear();
  io.flushes.length = 0;
  io.events.length = 0;
}
/** The native path of a root-relative project path, as `projectPath` spells it. */
const at = (project: string, path: string) => join(project, ...path.split("/"));

/**
 * The flush, rename, removal and link events of interest, in order and labelled
 * by the project path they concern. Opens and unrelated operations are dropped.
 */
function orderedEvents(project: string): string[] {
  const state = at(project, ".hooknostic");
  const journal = at(project, ".hooknostic/transaction.json");
  const destinations: [string, string][] = [
    ["a.txt", at(project, "a.txt")],
    ["z.txt", at(project, "z.txt")],
    [".hooknostic/integration.json", at(project, ".hooknostic/integration.json")],
  ];
  return io.events.flatMap((event) => {
    if (event.type === "fsync") {
      if (!event.directory) return isJournal(event.contents) ? ["flush journal contents"] : [];
      if (event.path === state) return ["flush .hooknostic"];
      if (event.path === project) return ["flush root"];
      return [`flush ${event.path}`];
    }
    if (event.type === "rename") {
      if (event.to === journal) return ["rename journal"];
      const destination = destinations.find(([, path]) => path === event.to);
      return destination === undefined ? [] : [`rename ${destination[0]}`];
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
  const staged = io.flushes.filter((flush) => !flush.directory && isStaged(flush.path)).map((flush) => flush.contents);
  for (const path of ["a.txt", "z.txt", ".hooknostic/integration.json"])
    expect(staged).toContain(await readFile(join(root, path), "utf8"));
  // The journal, staged and flushed before it was renamed into place.
  expect(staged.filter(isJournal)).toHaveLength(1);
}

it("flushes the lock and every staged file after writing it", async () => {
  await sync("one");
  await expectFlushedAfterWriting();
});

it("synchronizes and recovers when FileHandle.sync() is not implemented, as under Yarn PnP (#229)", async () => {
  io.notImplemented = true;

  await sync("one");
  await expectFlushedAfterWriting();
  io.flushes.length = 0;
  await sync("two");
  await expectFlushedAfterWriting();
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("two");
  expect(await readFile(join(root, "z.txt"), "utf8")).toBe("two");
  await recoverProject(root, owner);

  expect(await exists(".hooknostic/sync.lock")).toBe(false);
  expect(await exists(".hooknostic/recovery.lock")).toBe(false);
  expect(await staging()).toEqual([]);
});

describe("directory flushes make each rename durable before the next step", () => {
  it.skipIf(win32)("flushes the journal directories, each destination directory, then the commit point", async () => {
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
  });

  it.runIf(win32)("skips directory flushes on Windows, where fsync cannot flush a directory", async () => {
    await sync("one");

    expect(io.flushes.filter((flush) => flush.directory)).toEqual([]);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one");
    expect(await exists(".hooknostic/transaction.json")).toBe(false);
  });

  it.skipIf(win32)("rejects a failed journal-directory flush and rolls back", async () => {
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

  it.skipIf(win32)("rejects a failed destination-directory flush after a rename and rolls back", async () => {
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

    await sync("after");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after");
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("after");
  });

  it.skipIf(win32)("flushes restored directories before removing the journal, then the journal directory", async () => {
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
    expect(io.flushes.some((flush) => fail(flush.path, io.written.get(flush.path) ?? ""))).toBe(true);
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
