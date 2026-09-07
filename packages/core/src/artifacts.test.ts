import { describe, expect, it } from "vitest";
import { artifactPathProblem, validateGeneratedArtifacts } from "./artifacts.js";

describe("generated artifact paths", () => {
  it.each([["../escape"], ["file"], ["file/child"], ["worker", "WORKER"]])(
    "rejects unsafe or conflicting explicit directories %j", (...directories) => {
      expect(validateGeneratedArtifacts([{ path: "file", contents: "" }],
        { adapterId: "fake", target: "t" }, directories)).not.toEqual([]);
      expect(validateGeneratedArtifacts([{ path: "worker/server.js", contents: "" }],
        { adapterId: "fake", target: "t" }, ["worker", "worker/empty"])).toEqual([]);
    },
  );

  it("accepts POSIX-style relative paths", () => {
    for (const path of ["hooks/hooks.json", ".codex/hooks.json", "runtime/hooknostic.mjs", "a"]) {
      expect(artifactPathProblem(path), path).toBeUndefined();
    }
  });

  it("rejects paths that could escape the output directory or misbehave across platforms", () => {
    const hostile: unknown[] = [
      "../hooks.ts",
      "a/../../b",
      "/etc/passwd",
      "C:/x",
      "C:\\x",
      "\\\\server\\share",
      "a\\b",
      "./a",
      "a//b",
      "a/",
      "",
      "a\0b",
      42,
      undefined,
    ];
    for (const path of hostile) {
      expect(artifactPathProblem(path), String(path)).toBeDefined();
    }
  });

  it("reports one HN301 per offending artifact, including duplicates", () => {
    const diagnostics = validateGeneratedArtifacts(
      [
        { path: "ok.txt", contents: "" },
        { path: "../escape", contents: "" },
        { path: "ok.txt", contents: "" },
      ],
      { adapterId: "fake", target: "t" },
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "HN301",
        severity: "error",
        target: "t",
        message: expect.stringContaining('"../escape"'),
      }),
      expect.objectContaining({
        code: "HN301",
        severity: "error",
        target: "t",
        message: expect.stringContaining("duplicate artifact path"),
      }),
    ]);
    expect(
      validateGeneratedArtifacts([{ path: "ok.txt", contents: "" }], {
        adapterId: "fake",
        target: "t",
      }),
    ).toEqual([]);
  });

  it("rejects contents and modes writeFile would reject, so check agrees with build", () => {
    const diagnostics = validateGeneratedArtifacts(
      [
        { path: "number.json", contents: 42 as unknown as string },
        { path: "object.json", contents: { nested: true } as unknown as string },
        { path: "mode.sh", contents: "ok", mode: 0o10000 },
        { path: "fraction.sh", contents: "ok", mode: 1.5 },
        { path: "binary.bin", contents: Uint8Array.from([1, 2]), mode: 0o755 },
        { path: "text.txt", contents: "ok" },
      ],
      { adapterId: "fake", target: "t" },
    );
    expect(diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('"number.json" with non-string, non-binary contents'),
      expect.stringContaining('"object.json" with non-string, non-binary contents'),
      expect.stringContaining('"mode.sh" with invalid mode 4096'),
      expect.stringContaining('"fraction.sh" with invalid mode 1.5'),
    ]);
  });

  it("rejects an artifact that is also a directory of another artifact", () => {
    const diagnostics = validateGeneratedArtifacts(
      [
        { path: "hooks", contents: "file" },
        { path: "Hooks/hooks.json", contents: "nested" },
        { path: "runtime/index.mjs", contents: "fine" },
      ],
      { adapterId: "fake", target: "t" },
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "HN301",
        target: "t",
        message: expect.stringContaining('"hooks" that is also a directory'),
      }),
    ]);
  });

  it("rejects paths that collide on case-insensitive filesystems", () => {
    const diagnostics = validateGeneratedArtifacts(
      [
        { path: "hooks/config.json", contents: "first" },
        { path: "Hooks/config.json", contents: "second" },
      ],
      { adapterId: "fake", target: "t" },
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "HN301",
        target: "t",
        message: expect.stringContaining("case-insensitively duplicate artifact path"),
      }),
    ]);
  });
});
