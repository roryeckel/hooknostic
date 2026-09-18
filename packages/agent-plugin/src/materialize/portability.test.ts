import { describe, expect, it } from "vitest";

import { nativeObjectFormat, verifyPortableTree } from "./portability.js";

const bytes = (path: string, values: number[]) => ({ path, contents: Buffer.from(values) });

function pe(path: string) {
  const contents = Buffer.alloc(0x80);
  contents.write("MZ", 0, "ascii");
  contents.writeUInt32LE(0x40, 0x3c);
  contents.write("PE\0\0", 0x40, "ascii");
  return { path, contents };
}

function universalMachO(path: string) {
  const contents = Buffer.alloc(64);
  contents.writeUInt32BE(0xcafebabe, 0);
  contents.writeUInt32BE(1, 4);
  contents.writeUInt32BE(32, 16);
  contents.writeUInt32BE(16, 20);
  return { path, contents };
}

describe("verifyPortableTree", () => {
  it("accepts opaque data regardless of language-oriented filename conventions", () => {
    expect(
      verifyPortableTree([
        { path: "generated/module.so", contents: Buffer.from("not native") },
        { path: "generated/archive.jar", contents: Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61]) },
      ]),
    ).toEqual([]);
  });

  it.each([
    ["ELF", bytes("generated/a", [0x7f, 0x45, 0x4c, 0x46])],
    ["Mach-O", bytes("generated/b", [0xfe, 0xed, 0xfa, 0xcf])],
    ["universal Mach-O", universalMachO("generated/c")],
    ["PE", pe("generated/d")],
  ])("rejects actual %s bytes", (_format, file) => {
    expect(verifyPortableTree([file])).toEqual([
      expect.objectContaining({ path: file.path, reason: expect.stringContaining("platform") }),
    ]);
  });

  it("does not mistake a printable MZ prefix for a PE image", () => {
    expect(nativeObjectFormat(Buffer.from("MZ ordinary text"))).toBeUndefined();
  });
});
