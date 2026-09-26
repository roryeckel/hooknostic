import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { rollingPlaybackVersion } from "./check-harness-releases.mjs";
import { harnessLaneId, harnessLanes } from "./harness-lanes.mjs";

it("advances only the v2 rolling baseline through the watch command-line tools", () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "hooknostic-watch-rehearsal-"));
  try {
    const files = [
      "package.json",
      ...[
        "harness-lanes",
        "is-main-module",
        "check-harness-releases",
        "record-playback-validation",
        "harness-playback-version",
      ].map((name) => `scripts/${name}.mjs`),
    ];
    for (const id of ["opencode-v1", "opencode-v2"]) {
      const path = harnessLanes[id].module.slice(3);
      files.push(path, path.replace("profile.ts", "harness.ts"));
    }
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(repo, file), join(root, file));
    }
    const require = createRequire(import.meta.url);
    cpSync(dirname(require.resolve("semver/package.json")), join(root, "node_modules/semver"), { recursive: true });
    const run = (script, ...args) =>
      spawnSync(process.execPath, ["--experimental-strip-types", join(root, `scripts/${script}.mjs`), ...args], {
        encoding: "utf8",
      });
    const reference = run("harness-playback-version", "opencode-v2").stdout.trim();
    const v1Path = join(root, harnessLanes["opencode-v1"].module.slice(3));
    const v2Path = join(root, harnessLanes["opencode-v2"].module.slice(3));
    const v1Before = readFileSync(v1Path, "utf8");
    const v2Before = readFileSync(v2Path, "utf8");
    const baseline = rollingPlaybackVersion(v2Before) ?? reference;
    const parts = baseline.split(".").map(Number);
    const newer = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    const detect = () => {
      const result = run("check-harness-releases", "opencode-v2", "--version", newer, "--matrix");
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).include;
    };
    expect(detect()).toMatchObject([
      {
        harness: "opencode-v2",
        pkg: "@opencode/cli",
        bootstrap: "postinstall.mjs",
        referenceVersion: reference,
        newerAvailable: true,
      },
    ]);
    const record = run("record-playback-validation", "opencode-v2", newer, "--date", "2026-09-26");
    expect(record.status, record.stderr).toBe(0);
    expect(record.stdout).toContain("outcome=wrote");
    expect(rollingPlaybackVersion(readFileSync(v2Path, "utf8"))).toBe(newer);
    expect(readFileSync(v1Path, "utf8")).toBe(v1Before);
    expect(detect()).toMatchObject([{ referenceVersion: reference, playbackBaseline: newer, newerAvailable: false }]);
    const again = run("record-playback-validation", "opencode-v2", newer);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("outcome=noop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the OpenCode families on independent metadata and installation lanes", () => {
  const v1 = harnessLanes["opencode-v1"],
    v2 = harnessLanes["opencode-v2"];
  expect(v1.pkg).toBe("opencode-ai");
  expect(v2.pkg).toBe("@opencode/cli");
  expect(v1.module).not.toBe(v2.module);
  expect(harnessLaneId("opencode")).toBe("opencode-v1");
  for (const [id, lane] of Object.entries(harnessLanes)) {
    const probe = `const module = await import(${JSON.stringify(new URL(lane.module.replace("profile.ts", "harness.ts"), import.meta.url).href)}); process.stdout.write(module[${JSON.stringify(lane.harnessExport)}].referenceVersion);`;
    const expected = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", probe],
      { encoding: "utf8" },
    );
    const actual = execFileSync(
      process.execPath,
      ["--experimental-strip-types", fileURLToPath(new URL("harness-playback-version.mjs", import.meta.url)), id],
      { encoding: "utf8" },
    ).trim();
    expect(actual).toBe(expected);
  }
});
