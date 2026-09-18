import { describe, expect, it } from "vitest";

import { materializedPackageFiles } from "./placement.js";

const tree = (into: string, paths: string[], provider = "fixture") => ({
  provider,
  into,
  files: paths.map((path) => ({ path, contents: Buffer.from(path) })),
});

describe("materializedPackageFiles", () => {
  it("places an opaque tree at its already-canonical destination", () => {
    const { files, issues } = materializedPackageFiles([tree("generated/assets", ["index.dat", "data/table.bin"])], {
      claimed: new Set(),
    });

    expect(issues).toEqual([]);
    expect(files.map((file) => file.path)).toEqual(["generated/assets/index.dat", "generated/assets/data/table.bin"]);
  });

  it("places trees under a projector's nested plugin root", () => {
    const { files } = materializedPackageFiles([tree("generated", ["index.dat"])], {
      prefix: "package/",
      claimed: new Set(),
    });

    expect(files.map((file) => file.path)).toEqual(["package/generated/index.dat"]);
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

  it("emits nothing when no tree was materialized", () => {
    expect(materializedPackageFiles(undefined, { claimed: new Set() })).toEqual({ files: [], issues: [] });
    expect(materializedPackageFiles([], { claimed: new Set() })).toEqual({ files: [], issues: [] });
  });
});
