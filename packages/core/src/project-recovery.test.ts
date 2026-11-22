import { spawnSync } from "node:child_process";
import type * as fs from "node:fs/promises";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { applyProject, fileHash, reconcileProject, recoverProject } from "./project-files.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), readFile: vi.fn(actual.readFile), mkdir: vi.fn(actual.mkdir) };
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
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hooknostic-recovery-"));
});
afterEach(async () => {
  vi.mocked(rename).mockReset();
  vi.mocked(rename).mockImplementation((await vi.importActual<typeof fs>("node:fs/promises")).rename);
  vi.mocked(readFile).mockReset();
  vi.mocked(readFile).mockImplementation((await vi.importActual<typeof fs>("node:fs/promises")).readFile);
  vi.mocked(mkdir).mockReset();
  vi.mocked(mkdir).mockImplementation((await vi.importActual<typeof fs>("node:fs/promises")).mkdir);
  await rm(root, { recursive: true, force: true });
});
it("rolls back an ordinary replacement failure", async () => {
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith("z.txt")) throw new Error("injected replacement failure");
    return actual(from, to);
  });
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("new")))).rejects.toThrow(
    "injected",
  );
  await expect(readFile(join(root, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, ".hooknostic/integration.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains a recoverable journal when rollback itself fails", async () => {
  await applyProject(root, owner, await reconcileProject(root, owner, input("before")));
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  let failed = false;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith("z.txt")) {
      failed = true;
      throw new Error("injected commit failure");
    }
    if (failed && String(to).endsWith("a.txt")) throw new Error("injected rollback failure");
    return actual(from, to);
  });
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("after")))).rejects.toThrow(
    "rollback",
  );
  expect(await readFile(join(root, ".hooknostic/transaction.json"), "utf8")).toContain('"before"');
  vi.mocked(rename).mockImplementation(actual);
  await recoverProject(root, owner);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
});
it("rechecks external edits immediately before a replacement", async () => {
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    await actual(from, to);
    if (String(to).endsWith("a.txt")) await writeFile(join(root, "z.txt"), "external");
  });
  await expect(applyProject(root, owner, await reconcileProject(root, owner, input("new")))).rejects.toThrow(
    "recovery conflict",
  );
  expect(await readFile(join(root, "z.txt"), "utf8")).toBe("external");
  expect(await readFile(join(root, ".hooknostic/transaction.json"), "utf8")).toContain('"schemaVersion":1');
});
const locks = [
  { name: ".hooknostic/recovery.lock", holder: "recover" },
  { name: ".hooknostic/sync.lock", holder: "sync or recover" },
];
/**
 * An interrupted transaction of a.txt from "before" to "after", and the lock
 * `name` left by a process that has exited, its mtime an hour in the past. With
 * `create` set to `link`, the lock is created the way `acquire` does it: a
 * staged pid file linked into place.
 */
async function deadLockAndJournal(name: string, create: "write" | "link" = "write") {
  const { pid: dead } = spawnSync(process.execPath, ["-e", ""]);
  expect(dead, "spawn a child to get a dead pid").toBeTypeOf("number");
  await mkdir(join(root, ".hooknostic"));
  await writeFile(join(root, "a.txt"), "after");
  const journal = JSON.stringify({
    schemaVersion: 1,
    config: owner,
    entries: [
      { path: "a.txt", before: Buffer.from("before").toString("base64"), afterHash: fileHash("after"), mode: 0o644 },
    ],
  });
  await writeFile(join(root, ".hooknostic/transaction.json"), journal);
  const lock = join(await realpath(root), name);
  if (create === "link") {
    const staged = join(dirname(lock), "staging", "lock");
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, String(dead));
    await link(staged, lock);
    await rm(staged);
  } else {
    await writeFile(lock, String(dead));
  }
  const old = new Date(Date.now() - 3_600_000);
  await utimes(lock, old, old);
  /** Recover changed nothing: the transaction is still unfinished and staging holds no claim. */
  const untouched = async () => {
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after");
    expect(await readFile(join(root, ".hooknostic/transaction.json"), "utf8")).toBe(journal);
    expect(await readdir(join(root, ".hooknostic/staging"))).toEqual([]);
  };
  return { lock, dead: String(dead), untouched };
}
const actualFs = () => vi.importActual<typeof fs>("node:fs/promises");
it.each(locks)("clears a dead $name created by linking a flushed staging file (#293)", async ({ name }) => {
  const { lock } = await deadLockAndJournal(name, "link");

  await recoverProject(root, owner);

  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
  await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(root, ".hooknostic/staging"))).toEqual([]);
});
it.each(locks)(
  "leaves a live lock that replaced a dead $name while recover checked it (#267)",
  async ({ name, holder }) => {
    const { lock, untouched } = await deadLockAndJournal(name);
    const actual = (await actualFs()).rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      // After recover found the lock dead and before it claimed it, a peer
      // removed the dead lock and created its own.
      if (String(from) === lock) {
        await rm(lock);
        await writeFile(lock, String(process.pid));
      }
      return actual(from, to);
    });
    await expect(recoverProject(root, owner)).rejects.toThrow(
      `another hooknostic ${holder} is running: it took ${lock} while recover was checking it; rerun hooknostic recover after it finishes`,
    );
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    await untouched();
  },
);
it.each(locks)(
  "tells a replacement $name with the same bytes from the one it judged dead (#267)",
  async ({ name, holder }) => {
    const { lock, dead, untouched } = await deadLockAndJournal(name);
    const actual = (await actualFs()).rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      // A peer replaced the lock with a new file holding the same bytes, so
      // only its inode and mtime set it apart. The new file is written beside
      // the old one and renamed over it, so the two never share an inode.
      if (String(from) === lock) {
        await writeFile(`${lock}.peer`, dead);
        await actual(`${lock}.peer`, lock);
      }
      return actual(from, to);
    });
    await expect(recoverProject(root, owner)).rejects.toThrow(
      `another hooknostic ${holder} is running: it took ${lock} while recover was checking it`,
    );
    expect(await readFile(lock, "utf8")).toBe(dead);
    await untouched();
  },
);
it.each(locks)(
  "tells a live $name linked from staging with the same bytes from the one it judged dead (#293)",
  async ({ name, holder }) => {
    const { lock, dead, untouched } = await deadLockAndJournal(name);
    const actual = await actualFs();
    vi.mocked(rename).mockImplementation(async (from, to) => {
      // A peer replaced the dead lock with a new file holding the same bytes,
      // created exactly as acquire does it: written to staging, then linked.
      // Only the new inode and mtime set it apart.
      if (String(from) === lock) {
        const staged = join(dirname(lock), "staging", "peer-lock");
        await actual.rm(lock);
        await writeFile(staged, dead);
        await actual.link(staged, lock);
        await actual.rm(staged);
      }
      return actual.rename(from, to);
    });
    await expect(recoverProject(root, owner)).rejects.toThrow(
      `another hooknostic ${holder} is running: it took ${lock} while recover was checking it`,
    );
    expect(await readFile(lock, "utf8")).toBe(dead);
    await untouched();
  },
);
it.each([
  {
    name: ".hooknostic/recovery.lock",
    message: (lock: string) =>
      `another hooknostic recover may be running: ${lock} exists; rerun hooknostic recover, which removes a lock whose recorded process ID has exited`,
  },
  {
    name: ".hooknostic/sync.lock",
    message: (lock: string) =>
      `another hooknostic sync or recover may be running: ${lock} exists; if neither is, run hooknostic recover with the same configuration, which removes a lock whose recorded process ID has exited`,
  },
])("leaves $name to a peer that claimed it first, and names the peer (#267)", async ({ name, message }) => {
  const { lock, untouched } = await deadLockAndJournal(name);
  const actual = (await actualFs()).rename;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    // A peer claimed the dead lock first, so this claim finds nothing, and
    // the peer then created its own.
    if (String(from) !== lock) return actual(from, to);
    await rm(lock);
    try {
      return await actual(from, to);
    } finally {
      await writeFile(lock, String(process.pid));
    }
  });
  await expect(recoverProject(root, owner)).rejects.toMatchObject({ message: message(lock), code: "EEXIST" });
  expect(await readFile(lock, "utf8")).toBe(String(process.pid));
  await untouched();
});
it.each(locks)("puts a claimed $name back when checking the claim fails (#267)", async ({ name }) => {
  const { lock, dead, untouched } = await deadLockAndJournal(name);
  const actual = (await actualFs()).readFile;
  vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof actual>) => {
    if (String(args[0]).includes(join(".hooknostic", "staging")))
      throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO", syscall: "read" });
    return actual(...args);
  });
  await expect(recoverProject(root, owner)).rejects.toMatchObject({ code: "EIO" });
  vi.mocked(readFile).mockImplementation(actual);
  expect(await readFile(lock, "utf8")).toBe(dead);
  await untouched();
});
it.each(locks)(
  "does not claim a $name replaced between the liveness check and the claim (#267)",
  async ({ name, holder }) => {
    const { lock, untouched } = await deadLockAndJournal(name);
    const actual = await actualFs();
    const recoveryLock = join(await realpath(root), ".hooknostic", "recovery.lock");
    let replaced = false;
    vi.mocked(mkdir).mockImplementation(async (...args: Parameters<typeof actual.mkdir>) => {
      // Recover creates the staging directory after judging the lock and
      // before claiming it; a peer replaces the lock in that window. Taking the
      // recovery lock now also creates staging first, so for the sync lock wait
      // until that lock exists: the next staging mkdir is the claim's.
      if (
        !replaced &&
        String(args[0]).endsWith(join(".hooknostic", "staging")) &&
        (name.endsWith("recovery.lock") ||
          (await stat(recoveryLock).then(
            () => true,
            () => false,
          )))
      ) {
        replaced = true;
        await writeFile(`${lock}.peer`, String(process.pid));
        await actual.rename(`${lock}.peer`, lock);
      }
      return actual.mkdir(...args);
    });
    await expect(recoverProject(root, owner)).rejects.toThrow(
      `another hooknostic ${holder} is running: it took ${lock} while recover was checking it`,
    );
    // The peer's lock was never moved, not even briefly.
    expect(vi.mocked(rename).mock.calls.filter(([from]) => String(from) === lock)).toEqual([]);
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    await untouched();
  },
);
/** Fails the rename that would put a claimed lock back from staging to `lock`. */
const failPutBack = async (lock: string, before?: () => Promise<void>) => {
  const actual = (await actualFs()).rename;
  const claims: string[] = [];
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(from) === lock) {
      await before?.();
      claims.push(String(to));
    }
    if (String(to) === lock && claims.includes(String(from)))
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM", syscall: "rename" });
    return actual(from, to);
  });
  return claims;
};
it.each(locks)("names where a peer's $name is when it cannot be put back (#267)", async ({ name, holder }) => {
  const { lock, untouched } = await deadLockAndJournal(name);
  // A peer replaced the dead lock just before the claim, so the claim is the
  // peer's live lock, and putting it back fails.
  const claims = await failPutBack(lock, async () => {
    await writeFile(`${lock}.peer`, String(process.pid));
    await (await actualFs()).rename(`${lock}.peer`, lock);
  });
  const error: unknown = await recoverProject(root, owner).catch((caught: unknown) => caught);
  expect(claims).toHaveLength(1);
  expect(error).toMatchObject({
    message: `another hooknostic ${holder} is running: it took ${lock} while recover was checking it, and recover could not put that lock back; it is now at ${claims[0]}. Once no hooknostic sync or recover is running, delete that file and rerun hooknostic recover`,
    cause: { code: "EPERM" },
  });
  expect(await readFile(claims[0]!, "utf8")).toBe(String(process.pid));
  await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
  await rm(claims[0]!);
  await untouched();
});
it.each(locks)(
  "names where a claimed $name is when it can be neither checked nor put back (#267)",
  async ({ name }) => {
    const { lock, dead, untouched } = await deadLockAndJournal(name);
    const actual = (await actualFs()).readFile;
    vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof actual>) => {
      if (String(args[0]).includes(join(".hooknostic", "staging")))
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO", syscall: "read" });
      return actual(...args);
    });
    const claims = await failPutBack(lock);
    const error: unknown = await recoverProject(root, owner).catch((caught: unknown) => caught);
    vi.mocked(readFile).mockImplementation(actual);
    expect(claims).toHaveLength(1);
    expect(error).toMatchObject({
      message: `recover could not check the lock it claimed from ${lock} (EIO: i/o error, read), and could not put it back; it is now at ${claims[0]}. Once no hooknostic sync or recover is running, delete that file and rerun hooknostic recover`,
      cause: { code: "EPERM" },
    });
    expect(await readFile(claims[0]!, "utf8")).toBe(dead);
    await rm(claims[0]!);
    await untouched();
  },
);
it.each(locks.flatMap((lock) => ["EPERM", "EBUSY", "EACCES"].map((code) => ({ ...lock, code }))))(
  "names the other $holder when the claim of $name fails with $code (#267)",
  async ({ name, holder, code }) => {
    // On Windows a lock its holder is deleting while another process has it
    // open cannot be renamed.
    const { lock, dead, untouched } = await deadLockAndJournal(name);
    const actual = (await actualFs()).rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(from) === lock) throw Object.assign(new Error(`${code}: rename`), { code, syscall: "rename" });
      return actual(from, to);
    });
    await expect(recoverProject(root, owner)).rejects.toMatchObject({
      message: `another hooknostic ${holder} may be running: ${lock} could not be claimed (${code}), as when its holder is removing it; rerun hooknostic recover`,
      code,
      path: lock,
      cause: { code },
    });
    expect(await readFile(lock, "utf8")).toBe(dead);
    await untouched();
  },
);
it.skipIf(process.platform === "win32")("applies the requested mode despite a restrictive umask", async () => {
  const previousUmask = process.umask(0o077);
  try {
    await applyProject(
      root,
      owner,
      await reconcileProject(root, owner, {
        files: [{ path: "a.txt", contents: "generated", mode: 0o644 }],
        entries: [],
        guidance: [],
      }),
    );
  } finally {
    process.umask(previousUmask);
  }

  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
  await expect(
    reconcileProject(root, owner, {
      files: [{ path: "a.txt", contents: "generated", mode: 0o644 }],
      entries: [],
      guidance: [],
    }),
  ).resolves.toMatchObject({ changes: [] });
});
it.skipIf(process.platform === "win32")("accepts a checkout whose permission bits follow its umask", async () => {
  // Git checks committed 0644 and 0755 files out as 0666 and 0777 less the
  // umask: 0666 under umask 000, 0700 under umask 077.
  const desired = {
    files: [
      { path: "a.txt", contents: "same", mode: 0o644 },
      { path: "b.sh", contents: "same", mode: 0o755 },
    ],
    entries: [],
    guidance: [],
  };
  await applyProject(root, owner, await reconcileProject(root, owner, desired));
  await chmod(join(root, "a.txt"), 0o666);
  await chmod(join(root, "b.sh"), 0o700);
  await chmod(join(root, ".hooknostic/integration.json"), 0o664);

  await expect(reconcileProject(root, owner, desired)).resolves.toMatchObject({ changes: [] });
});
it.skipIf(process.platform === "win32").each([
  { mode: 0o644, observed: 0o744, name: "0644 as 0744" },
  { mode: 0o644, observed: 0o645, name: "0644 as 0645" },
  { mode: 0o755, observed: 0o655, name: "0755 as 0655" },
])("rejects an execute change a checkout cannot produce ($name)", async ({ mode, observed }) => {
  const desired = { files: [{ path: "a.txt", contents: "same", mode }], entries: [], guidance: [] };
  await applyProject(root, owner, await reconcileProject(root, owner, desired));
  await chmod(join(root, "a.txt"), observed);

  await expect(reconcileProject(root, owner, desired)).rejects.toThrow("unowned or modified generated file: a.txt");
});
it.skipIf(process.platform === "win32")("applies a newly requested non-execute mode exactly", async () => {
  const desired = (mode: number) => ({ files: [{ path: "a.txt", contents: "same", mode }], entries: [], guidance: [] });
  await applyProject(root, owner, await reconcileProject(root, owner, desired(0o644)));
  await chmod(join(root, "a.txt"), 0o666);

  await applyProject(root, owner, await reconcileProject(root, owner, desired(0o600)));

  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o600);
  await expect(reconcileProject(root, owner, desired(0o600))).resolves.toMatchObject({ changes: [] });

  await applyProject(root, owner, await reconcileProject(root, owner, desired(0o644)));
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
});
it.skipIf(process.platform === "win32")("rejects a checkout that loosened a restrictive mode", async () => {
  // Git cannot record 0600, so a fresh checkout under umask 022 yields 0644.
  const desired = { files: [{ path: "a.txt", contents: "same", mode: 0o600 }], entries: [], guidance: [] };
  await applyProject(root, owner, await reconcileProject(root, owner, desired));
  await chmod(join(root, "a.txt"), 0o644);

  await expect(reconcileProject(root, owner, desired)).rejects.toThrow("unowned or modified generated file: a.txt");
});
it.skipIf(process.platform === "win32")("rolls back a mode-only replacement after a later failure", async () => {
  const modes = (mode: number) => ({
    files: [
      { path: "a.txt", contents: "same", mode },
      { path: "z.txt", contents: "same", mode },
    ],
    entries: [],
    guidance: [],
  });
  await applyProject(root, owner, await reconcileProject(root, owner, modes(0o644)));
  const actual = (await vi.importActual<typeof fs>("node:fs/promises")).rename;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (String(to).endsWith("z.txt")) throw new Error("injected replacement failure");
    return actual(from, to);
  });

  await expect(applyProject(root, owner, await reconcileProject(root, owner, modes(0o755)))).rejects.toThrow(
    "injected",
  );
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
  await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.skipIf(process.platform === "win32")("recovers a mode-only committed state from its journal", async () => {
  await mkdir(join(root, ".hooknostic"));
  await writeFile(join(root, "a.txt"), "same");
  await chmod(join(root, "a.txt"), 0o755);
  await writeFile(
    join(root, ".hooknostic/transaction.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: owner,
      entries: [
        {
          path: "a.txt",
          before: Buffer.from("same").toString("base64"),
          afterHash: fileHash("same"),
          mode: 0o755,
          beforeMode: 0o644,
        },
      ],
    }),
  );

  await recoverProject(root, owner);
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o644);
});
it.skipIf(process.platform === "win32")("rejects a concurrent chmod without overwriting it", async () => {
  const desired = (mode: number) => ({ files: [{ path: "a.txt", contents: "same", mode }], entries: [], guidance: [] });
  await applyProject(root, owner, await reconcileProject(root, owner, desired(0o644)));
  const plan = await reconcileProject(root, owner, desired(0o755));
  await chmod(join(root, "a.txt"), 0o700);

  await expect(applyProject(root, owner, plan)).rejects.toThrow("changed during planning");
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o700);
});
it.skipIf(process.platform === "win32")("records the ownership manifest preimage mode", async () => {
  await applyProject(root, owner, await reconcileProject(root, owner, input("before")));
  const manifest = join(root, ".hooknostic/integration.json");
  await chmod(manifest, 0o600);
  const plan = await reconcileProject(root, owner, input("after"));

  expect(plan.changes.find((change) => change.path === ".hooknostic/integration.json")?.beforeMode).toBe(0o600);
});
