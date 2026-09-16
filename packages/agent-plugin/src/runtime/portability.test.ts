import { describe, expect, it } from "vitest";

import { nativeObjectFormat, verifyPortableTree } from "./portability.js";

const text = (path: string, body = "print(1)") => ({ path, contents: Buffer.from(body, "utf8") });

const withMagic = (path: string, bytes: number[], length = bytes.length) => {
  const contents = Buffer.alloc(Math.max(length, bytes.length));
  for (const [index, byte] of bytes.entries()) contents[index] = byte;
  return { path, contents };
};

/** MZ at 0, `e_lfanew` at 0x3C naming a "PE\0\0" at 0x40: a real PE header. */
function portableExecutable(path: string) {
  const contents = Buffer.alloc(0x80);
  contents.write("MZ", 0, "ascii");
  contents.writeUInt32LE(0x40, 0x3c);
  contents.write("PE\0\0", 0x40, "ascii");
  return { path, contents };
}

describe("verifyPortableTree", () => {
  it("passes a tree that means the same thing on every machine", () => {
    expect(
      verifyPortableTree([
        text("charset_normalizer/__init__.py"),
        text(
          "charset_normalizer-3.4.0.dist-info/WHEEL",
          "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        ),
        text("README.txt", "notes"),
        text("data/table.json", "{}"),
      ]),
    ).toEqual([]);
  });

  it("refuses a compiled extension module on its name alone", () => {
    // Deliberately inert content: the extension rule has to stand on its own,
    // or the magic scan silently covers for it. It earns its place -- a GNU
    // linker script named `libc.so` is plain text and still platform-specific.
    const problems = verifyPortableTree([
      text("pydantic_core/_pydantic_core.cpython-313-x86_64-linux-gnu.so", "not really an object"),
      text("pkg/_speedups.pyd", "inert"),
      text("pkg/libfoo.dylib", "inert"),
      text("node_addon/binding.node", "inert"),
      text("pkg/libfoo.so.1.2", "GROUP ( libc.so.6 libc_nonshared.a )"),
    ]);

    expect(problems.map((problem) => problem.path)).toEqual([
      "pydantic_core/_pydantic_core.cpython-313-x86_64-linux-gnu.so",
      "pkg/_speedups.pyd",
      "pkg/libfoo.dylib",
      "node_addon/binding.node",
      "pkg/libfoo.so.1.2",
    ]);
    expect(problems.every((problem) => problem.reason.includes("one platform"))).toBe(true);
  });

  it("reads the bytes, not the name: a wheel can ship an extension with no suffix", () => {
    const problems = verifyPortableTree([withMagic("pkg/_speedups", [0x7f, 0x45, 0x4c, 0x46])]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain("ELF");
  });

  it("does not mistake text beginning with MZ for a Windows executable", () => {
    // Two printable characters are not a PE header, and a false reject blocks a
    // build that was fine. The offset at 0x3C has to name a real signature.
    const contents = Buffer.alloc(0x80);
    contents.write("MZ is a recording label, not a header", 0, "ascii");

    expect(nativeObjectFormat(contents, "notes.txt")).toBeUndefined();
    expect(verifyPortableTree([{ path: "notes.txt", contents }])).toEqual([]);
  });

  it("refuses a genuine PE, header and all", () => {
    const problems = verifyPortableTree([portableExecutable("bin/tool")]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain("PE");
  });

  it("tells a JVM class file from the universal Mach-O it shares magic with", () => {
    const magic = [0xca, 0xfe, 0xba, 0xbe];

    // Same four bytes; only one of the two is built for a single platform.
    expect(nativeObjectFormat(Buffer.from(magic), "Widget.class")).toBeUndefined();
    expect(nativeObjectFormat(Buffer.from(magic), "libfoo")).toContain("Mach-O");
  });

  it("ignores a short file rather than reading past its end", () => {
    expect(verifyPortableTree([{ path: "empty", contents: Buffer.alloc(0) }])).toEqual([]);
    expect(verifyPortableTree([{ path: "tiny", contents: Buffer.from([0x4d, 0x5a]) }])).toEqual([]);
  });
});
