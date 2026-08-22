import { describe, expect, it } from "vitest";
import { artifactPathProblem, validateGeneratedArtifacts } from "./artifacts.js";

describe("generated artifact paths", () => {
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
