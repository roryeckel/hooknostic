import { readFile } from "node:fs/promises";

/**
 * Whether the filesystem holding `path` keeps permission bits, judged from a
 * Linux mount table in `/proc/self/mounts` format.
 *
 * Only WSL's DrvFs mount of a Windows drive is recognised as not keeping them,
 * and only when it is mounted without `metadata`. There every file reads 0777
 * and `chmod` succeeds without changing anything (#248). Captured on WSL2,
 * kernel 5.15.167.4-microsoft-standard-WSL2, 2026-11-19:
 *
 *   default automount, which keeps no modes:
 *   C:\134 /mnt/c 9p rw,dirsync,noatime,aname=drvfs;path=C:\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=5,wfd=5 0 0
 *
 *   `mount -t drvfs C: /mnt/hn248 -o metadata`, which keeps them:
 *   C: /mnt/hn248 9p rw,dirsync,relatime,aname=drvfs;path=C:;metadata;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=3,wfd=3 0 0
 *
 * WSL2 reports DrvFs as `9p` and names it in the `aname=drvfs` option, whose
 * value continues `;`-separated, so options are split on both `,` and `;`. The
 * filesystem type alone does not identify it: `statfs` reports v9fs (magic
 * 0x01021997) for DrvFs and for other 9p mounts such as /usr/lib/wsl/drivers.
 * WSL1 reports the type `drvfs`; that spelling rests on Microsoft's
 * documentation only, not on a capture. DrvFs served over virtiofs is not
 * captured and therefore not detected. Other filesystems that ignore `chmod`
 * (FAT, exFAT, SMB without Unix extensions) are out of scope and not detected.
 *
 * An empty or unreadable table answers `true`, which keeps modes compared.
 */
export function keepsFileModes(mounts: string, path: string): boolean {
  let found: { point: string; type: string; options: string } | undefined;
  for (const line of mounts.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 4) continue;
    const point = unescapeMountField(fields[1]!);
    if (!contains(point, path)) continue;
    // The deepest mount point wins; of equal ones the later line, which is the
    // mount on top.
    if (found === undefined || point.length >= found.point.length)
      found = { point, type: fields[2]!, options: fields[3]! };
  }
  if (found === undefined) return true;
  const options = found.options.split(/[,;]/);
  const drvfs = found.type === "drvfs" || (found.type === "9p" && options.includes("aname=drvfs"));
  return !drvfs || options.some((option) => option === "metadata" || option.startsWith("metadata="));
}

/** The kernel writes space, tab, newline and backslash as `\ooo` octal escapes. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function contains(point: string, path: string): boolean {
  return point === "/" || path === point || path.startsWith(`${point}/`);
}

export interface FileModeHost {
  platform?: NodeJS.Platform;
  readMounts?: () => Promise<string>;
}

/**
 * Whether permission bits read at `path` mean anything. Windows keeps none;
 * on Linux the mount table decides; any other platform is assumed to keep
 * them.
 */
export async function recordsFileModes(
  path: string,
  { platform = process.platform, readMounts = () => readFile("/proc/self/mounts", "utf8") }: FileModeHost = {},
): Promise<boolean> {
  if (platform === "win32") return false;
  if (platform !== "linux") return true;
  let mounts: string;
  try {
    mounts = await readMounts();
  } catch {
    return true;
  }
  return keepsFileModes(mounts, path);
}
