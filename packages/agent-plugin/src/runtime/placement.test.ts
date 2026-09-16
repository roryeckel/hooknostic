import { describe, expect, it } from "vitest";

import { materializedRuntimeFiles } from "./placement.js";

const runtime = (into: string, paths: string[]) => ({
  ecosystem: "pypi",
  into,
  files: paths.map((path) => ({ path, contents: Buffer.from(path) })),
});

describe("materializedRuntimeFiles", () => {
  it("places a tree at the destination the runtime declared", () => {
    const { files, issues } = materializedRuntimeFiles(
      [runtime("runtime/pypi", ["idna/core.py", "idna/__init__.py"])],
      {
        claimed: new Set(),
      },
    );

    expect(issues).toEqual([]);
    expect(files.map((file) => file.path)).toEqual(["runtime/pypi/idna/core.py", "runtime/pypi/idna/__init__.py"]);
  });

  it("puts the tree under a nested plugin root, which is OpenCode's shape", () => {
    // OpenCode's ${PLUGIN_ROOT} is the nested package directory, so a
    // root-level path would be unreachable from the mcp.json that names it.
    const { files } = materializedRuntimeFiles([runtime("runtime/pypi", ["idna/core.py"])], {
      prefix: "package/",
      claimed: new Set(),
    });

    expect(files.map((file) => file.path)).toEqual(["package/runtime/pypi/idna/core.py"]);
  });

  it("normalizes a destination written the other ways authors write it", () => {
    for (const into of ["./runtime/pypi", "runtime/pypi/", "./runtime/pypi/"]) {
      const { files } = materializedRuntimeFiles([runtime(into, ["a.py"])], { claimed: new Set() });
      expect(files[0]?.path).toBe("runtime/pypi/a.py");
    }
  });

  it("refuses to overwrite a file the package already ships", () => {
    const { files, issues } = materializedRuntimeFiles([runtime("runtime", ["keep.py", "clash.py"])], {
      claimed: new Set(["runtime/clash.py"]),
    });

    expect(files.map((file) => file.path)).toEqual(["runtime/keep.py"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("already ships");
    expect(issues[0]?.path).toBe("runtime/clash.py");
  });

  it("emits nothing when no runtime was materialized", () => {
    expect(materializedRuntimeFiles(undefined, { claimed: new Set() })).toEqual({ files: [], issues: [] });
    expect(materializedRuntimeFiles([], { claimed: new Set() })).toEqual({ files: [], issues: [] });
  });
});
