import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { portableRelative } from "./portable-path.js";

describe("portableRelative", () => {
  it("is relative within one Windows root, with forward slashes", () => {
    expect(portableRelative("C:\\work\\project\\.pi\\extensions", "C:\\work\\project\\tools", win32)).toBe(
      "../../tools",
    );
    expect(portableRelative("C:\\work\\project", "c:\\WORK\\project", win32)).toBe(".");
    expect(portableRelative("\\\\host\\share\\project\\a", "\\\\host\\share\\tools", win32)).toBe("../../tools");
  });

  it("is the absolute target where no relative path reaches it", () => {
    expect(portableRelative("C:\\work\\project", "D:\\portable", win32)).toBe("D:/portable");
    // win32.relative would give ..\..\other\tools, which resolve() clamps onto \\host\share.
    const from = "\\\\host\\share\\project\\.pi\\extensions";
    const offset = portableRelative(from, "\\\\host\\other\\tools", win32);
    expect(offset).toBe("//host/other/tools");
    expect(win32.resolve(from, offset)).toBe("\\\\host\\other\\tools");
  });

  it("keeps a POSIX backslash, an ordinary file-name character there", () => {
    expect(portableRelative("/work/project/.pi/extensions", "/work/project/tools\\name", posix)).toBe(
      "../../tools\\name",
    );
    expect(portableRelative("/work/project", "/work/project", posix)).toBe(".");
  });
});
