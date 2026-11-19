import { describe, expect, it, vi } from "vitest";

import { keepsFileModes, recordsFileModes } from "./file-modes.js";

// Captured on WSL2 (kernel 5.15.167.4-microsoft-standard-WSL2, 2026-11-19), in
// the order /proc/self/mounts lists them.
const captured = [
  "none /mnt/wsl tmpfs rw,relatime 0 0",
  "drivers /usr/lib/wsl/drivers 9p ro,dirsync,nosuid,nodev,noatime,aname=drivers;fmask=222;dmask=222,mmap,access=client,msize=65536,trans=fd,rfd=7,wfd=7 0 0",
  "/dev/sde / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0",
  String.raw`C:\134 /mnt/c 9p rw,dirsync,noatime,aname=drvfs;path=C:\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=5,wfd=5 0 0`,
].join("\n");
// Captured the same day from a transient `mount -t drvfs C: /mnt/hn248 -o metadata`.
const metadata = String.raw`C: /mnt/hn248 9p rw,dirsync,relatime,aname=drvfs;path=C:;metadata;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=3,wfd=3 0 0`;
const ext4 = (point: string) => `/dev/sdf ${point} ext4 rw,relatime 0 0`;
const drvfs = (point: string) =>
  String.raw`C:\134 ${point} 9p rw,noatime,aname=drvfs;path=C:\;uid=1000;gid=1000;symlinkroot=/mnt/ 0 0`;

describe("keepsFileModes", () => {
  it("finds a DrvFs mount without metadata among the captured mounts", () => {
    expect(keepsFileModes(captured, "/mnt/c/Users/x/p")).toBe(false);
    expect(keepsFileModes(captured, "/mnt/c")).toBe(false);
    expect(keepsFileModes(captured, "/home/u/p")).toBe(true);
    expect(keepsFileModes(captured, "/mnt/wsl/x")).toBe(true);
    expect(keepsFileModes(captured, "/usr/lib/wsl/drivers/x")).toBe(true);
  });

  it("keeps modes on a DrvFs mount with metadata", () => {
    expect(keepsFileModes(`${captured}\n${metadata}`, "/mnt/hn248/Users/x/p")).toBe(true);
    expect(keepsFileModes(`${captured}\n${metadata.replace(";metadata;", ";metadata=1;")}`, "/mnt/hn248/p")).toBe(true);
  });

  it("finds a WSL1 drvfs mount", () => {
    // WSL1's spelling, from Microsoft's documentation rather than a capture.
    const wsl1 = String.raw`C:\134 /mnt/c drvfs rw,noatime,uid=1000,gid=1000,case=off 0 0`;
    expect(keepsFileModes(`${ext4("/")}\n${wsl1}`, "/mnt/c/p")).toBe(false);
    expect(keepsFileModes(`${ext4("/")}\n${wsl1.replace("case=off", "metadata,case=off")}`, "/mnt/c/p")).toBe(true);
  });

  it("matches a mount point only at a path boundary", () => {
    expect(keepsFileModes(captured, "/mnt/cx/p")).toBe(true);
  });

  it.each([
    { order: "parent first", lines: [drvfs("/mnt/c"), ext4(String.raw`/mnt/c/my\040dir`)] },
    { order: "nested mount first", lines: [ext4(String.raw`/mnt/c/my\040dir`), drvfs("/mnt/c")] },
  ])("lets the deepest mount decide ($order)", ({ lines }) => {
    const table = [ext4("/"), ...lines].join("\n");
    expect(keepsFileModes(table, "/mnt/c/my dir/p")).toBe(true);
    expect(keepsFileModes(table, "/mnt/c/other/p")).toBe(false);
  });

  it("lets the later of two mounts at one point decide", () => {
    expect(keepsFileModes([ext4("/"), drvfs("/mnt/c"), ext4("/mnt/c")].join("\n"), "/mnt/c/p")).toBe(true);
    expect(keepsFileModes([ext4("/"), ext4("/mnt/c"), drvfs("/mnt/c")].join("\n"), "/mnt/c/p")).toBe(false);
  });

  it("unescapes a mount point in one pass", () => {
    // `\134040` is a backslash followed by the characters 040.
    const table = [ext4("/"), drvfs(String.raw`/mnt/c/a\134040b`)].join("\n");
    expect(keepsFileModes(table, String.raw`/mnt/c/a\040b/p`)).toBe(false);
    expect(keepsFileModes(table, "/mnt/c/a b/p")).toBe(true);
  });

  it("keeps modes when the table is empty or names no mount", () => {
    expect(keepsFileModes("", "/mnt/c/p")).toBe(true);
    expect(keepsFileModes("not a mount table", "/mnt/c/p")).toBe(true);
  });
});

describe("recordsFileModes", () => {
  const unread = () => Promise.reject(new Error("must not read the mount table"));

  it("records none on Windows", async () => {
    await expect(recordsFileModes("C:\\p", { platform: "win32", readMounts: unread })).resolves.toBe(false);
  });

  it("records none on Linux inside a DrvFs mount without metadata", async () => {
    const readMounts = async () => captured;
    await expect(recordsFileModes("/mnt/c/Users/x/p", { platform: "linux", readMounts })).resolves.toBe(false);
  });

  it("records them on Linux on an ordinary filesystem", async () => {
    const readMounts = async () => captured;
    await expect(recordsFileModes("/home/u/p", { platform: "linux", readMounts })).resolves.toBe(true);
  });

  it("records them on Linux when the mount table cannot be read", async () => {
    await expect(
      recordsFileModes("/mnt/c/p", { platform: "linux", readMounts: () => Promise.reject(new Error("EACCES")) }),
    ).resolves.toBe(true);
  });

  it("records them on another POSIX platform without reading a mount table", async () => {
    const readMounts = vi.fn(async () => captured);
    await expect(recordsFileModes("/mnt/c/p", { platform: "darwin", readMounts })).resolves.toBe(true);
    expect(readMounts).not.toHaveBeenCalled();
  });
});
