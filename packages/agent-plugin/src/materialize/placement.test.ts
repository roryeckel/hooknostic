import { describe, expect, it } from "vitest";

import { materializedPackageFiles } from "./placement.js";

const tree = (into: string, paths: string[], provider = "fixture") => ({
  provider,
  into,
  files: paths.map((path) => ({ path, contents: Buffer.from(path), mode: 0o644 as 0o644 | 0o755 })),
});

describe("materializedPackageFiles", () => {
  it("places an opaque tree at its already-canonical destination", () => {
    const { files, issues } = materializedPackageFiles([tree("generated/assets", ["index.dat", "data/table.bin"])], {
      claimed: new Set(),
    });

    expect(issues).toEqual([]);
    expect(files.map((file) => file.path)).toEqual(["generated/assets/index.dat", "generated/assets/data/table.bin"]);
    expect(files.map((file) => file.mode)).toEqual([0o644, 0o644]);
  });

  it("places trees under a projector's nested plugin root", () => {
    const executable = tree("generated", ["bin/server"]);
    executable.files[0]!.mode = 0o755;
    const { files } = materializedPackageFiles([executable], {
      prefix: "package/",
      claimed: new Set(),
    });

    expect(files).toEqual([expect.objectContaining({ path: "package/generated/bin/server", mode: 0o755 })]);
  });

  it("refuses to overwrite author package content", () => {
    const { files, issues } = materializedPackageFiles([tree("generated", ["keep.dat", "clash.dat"])], {
      claimed: new Set(["generated/clash.dat"]),
    });

    expect(files.map((file) => file.path)).toEqual(["generated/keep.dat"]);
    expect(issues).toEqual([
      expect.objectContaining({ path: "generated/clash.dat", message: expect.stringContaining("fixture") }),
    ]);
  });

  it("refuses overlapping trees from separate providers", () => {
    const { files, issues } = materializedPackageFiles(
      [tree("generated", ["shared/data.bin"], "first"), tree("generated/shared", ["data.bin"], "second")],
      { claimed: new Set() },
    );

    expect(files.map((file) => file.path)).toEqual(["generated/shared/data.bin"]);
    expect(issues).toEqual([
      expect.objectContaining({ path: "generated/shared/data.bin", message: expect.stringContaining("second") }),
    ]);
  });

  it("refuses trees that differ from author content only in case", () => {
    const { files, issues } = materializedPackageFiles([tree("runtime", ["LIB.so"])], {
      claimed: new Set(["Runtime/lib.SO"]),
    });

    expect(files).toEqual([]);
    expect(issues).toEqual([
      expect.objectContaining({
        path: "runtime/LIB.so",
        message: expect.stringContaining('already ships as "Runtime/lib.SO" on case-insensitive filesystems'),
      }),
    ]);
  });

  it("refuses two trees whose destinations differ only in case", () => {
    const { files, issues } = materializedPackageFiles(
      [tree("runtime", ["lib.so"], "first"), tree("Runtime", ["LIB.SO"], "second")],
      { claimed: new Set() },
    );

    // One file, not two: a case-insensitive install would collapse them and the
    // projection would no longer describe what is on disk.
    expect(files.map((file) => file.path)).toEqual(["runtime/lib.so"]);
    expect(issues).toEqual([
      expect.objectContaining({
        path: "Runtime/LIB.SO",
        message: expect.stringContaining('already provides as "runtime/lib.so" on case-insensitive filesystems'),
      }),
    ]);
  });

  it("emits nothing when no tree was materialized", () => {
    expect(materializedPackageFiles(undefined, { claimed: new Set() })).toEqual({ files: [], issues: [] });
    expect(materializedPackageFiles([], { claimed: new Set() })).toEqual({ files: [], issues: [] });
  });
});
