import { describe, expect, it } from "vitest";

import { detectCommandVersion, detectSpawnArgs } from "./detect.js";

describe("detectSpawnArgs", () => {
  it("puts the whole line in the command on Windows, with no args array", () => {
    // The DEP0190 regression. Node 24 warns -- on stderr, over doctor's own
    // output -- whenever a shell spawn is given args to concatenate. Passing
    // the joined line and no args is the same spawn without the warning.
    expect(detectSpawnArgs(["codex", "--version"], "win32")).toEqual({
      file: "codex --version",
      args: [],
      shell: true,
    });
  });

  it("spawns the binary directly elsewhere", () => {
    expect(detectSpawnArgs(["codex", "--version"], "linux")).toEqual({
      file: "codex",
      args: ["--version"],
      shell: false,
    });
  });

  it("never pairs a shell spawn with args, on any platform", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const spawn = detectSpawnArgs(["a", "b", "c"], platform);
      expect(spawn.shell && spawn.args.length > 0).toBe(false);
    }
  });
});

describe("detectCommandVersion", () => {
  it("reports the version of a command that is really installed", async () => {
    // `node` stands in for a harness CLI: it is guaranteed present, and it
    // exercises whichever platform path this run is actually on.
    const result = await detectCommandVersion("node");
    expect(result.installed).toBe(true);
    expect(result.version).toBe(process.version.slice(1));
  });

  it("reports a missing command as not installed rather than throwing", async () => {
    const result = await detectCommandVersion("hooknostic-no-such-harness");
    expect(result).toEqual({
      installed: false,
      detail: "hooknostic-no-such-harness not found on PATH",
    });
  });

  it("uses the adapter's own wording for a missing command", async () => {
    const result = await detectCommandVersion("hooknostic-no-such-harness", {
      notFoundDetail: "fake CLI not found on PATH",
    });
    expect(result.detail).toBe("fake CLI not found on PATH");
  });

  it("refuses a probe that would need shell quoting", async () => {
    // Concatenation is only safe for literals; anything a shell would have to
    // parse is a programming error in the adapter, not a runtime condition.
    await expect(
      detectCommandVersion("node", { args: ["--eval", "console.log(1); rm -rf /"] }),
    ).rejects.toThrow(/would need shell quoting/);
    await expect(detectCommandVersion("my harness")).rejects.toThrow(
      /would need shell quoting/,
    );
  });
});
