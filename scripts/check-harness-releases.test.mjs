import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";
import { describe, expect, it } from "vitest";

import {
  assessRelease,
  classifyJump,
  isMainModule,
  rollingPlaybackVersion,
  shouldInclude,
} from "./check-harness-releases.mjs";

const PROFILE = (rolling) =>
  [
    'import type { CapabilityProfile } from "@hooknostic/core";',
    "export const fakeCapabilityProfiles = [{",
    '  range: ">=0.140 <1",',
    "  source: {",
    '    date: "2026-08-29",',
    "    validatedOn: [",
    '      { version: "0.151.0", date: "2026-08-30", method: "router-log",',
    '        what: "exec_command router args" },',
    '      { version: "0.152.0", date: "2026-08-31", method: "live-probe",',
    '        what: "a scoped probe of one channel" },',
    "      // scheduled-playback:begin",
    rolling === undefined
      ? "      // (empty)"
      : '      { version: "' + rolling + '", date: "2026-09-02", method: "live-probe",',
    rolling === undefined
      ? ""
      : '        what: "scheduled model-free playback vs a newer build: artifact discovery, rewrite/block markers, and lifecycle events verified" },',
    "      // scheduled-playback:end",
    "    ],",
    "  },",
    "}];",
  ].join("\n");

const BASE = {
  harness: "codex",
  pkg: "@openai/codex",
  referenceVersion: "0.148.0",
  semver,
};

describe("rollingPlaybackVersion", () => {
  it("reads the rolling record version from the marker region", () => {
    expect(rollingPlaybackVersion(PROFILE("0.151.0"))).toBe("0.151.0");
  });
  it("returns undefined for an empty region and for missing markers", () => {
    expect(rollingPlaybackVersion(PROFILE(undefined))).toBeUndefined();
    expect(rollingPlaybackVersion("export const x = 1;")).toBeUndefined();
  });
});

describe("isMainModule", () => {
  it("recognizes an absolute script path on every platform", () => {
    const scriptPath = resolve("scripts/check-harness-releases.mjs");
    expect(isMainModule(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    expect(isMainModule(pathToFileURL(scriptPath).href, resolve("other.mjs"))).toBe(false);
  });
});

describe("classifyJump", () => {
  it("folds semver.diff to patch/minor/major", () => {
    expect(classifyJump("0.148.0", "0.148.1", semver)).toBe("patch");
    expect(classifyJump("0.148.0", "0.149.0", semver)).toBe("minor");
    expect(classifyJump("0.148.0", "1.0.0", semver)).toBe("major");
    expect(classifyJump("0.148.0", "0.148.0", semver)).toBeNull();
  });
});

describe("assessRelease", () => {
  it("baselines on referenceVersion when the rolling record is absent", () => {
    const r = assessRelease({ ...BASE, latest: "0.149.0" });
    expect(r.playbackBaseline).toBe("0.148.0");
    expect(r.newerAvailable).toBe(true);
    // 0.148.0 -> 0.149.0: minor bump (0.x semver treats minor as the
    // breaking axis; the workflow only distinguishes patch vs rest).
    expect(r.jump).toBe("minor");
  });

  it("raises the baseline on the rolling record only", () => {
    const r = assessRelease({
      ...BASE,
      rollingVersion: "0.150.0",
      latest: "0.151.0",
    });
    expect(r.playbackBaseline).toBe("0.150.0");
    expect(r.newerAvailable).toBe(true);
  });

  it("a newer non-playback record must NOT raise the baseline (the real codex state)", () => {
    // 0.151.0 router-log + 0.152.0 scoped live-probe exist; neither is
    // scheduled playback, so the first scheduled run must still verify 0.151.0.
    const r = assessRelease({ ...BASE, latest: "0.151.0" });
    expect(r.playbackBaseline).toBe("0.148.0");
    expect(r.newerAvailable).toBe(true);
    expect(r.jump).toBe("minor");
  });

  it("dist-tag behind the baseline is not newer", () => {
    const r = assessRelease({
      ...BASE,
      rollingVersion: "0.151.0",
      latest: "0.150.0",
    });
    expect(r.newerAvailable).toBe(false);
  });

  it("latest equal to the baseline is not newer (nothing to verify)", () => {
    const r = assessRelease({
      ...BASE,
      rollingVersion: "0.151.0",
      latest: "0.151.0",
    });
    expect(r.playbackBaseline).toBe("0.151.0");
    expect(r.newerAvailable).toBe(false);
  });

  it("a pinned in-range OLDER build with an empty region does not regress the baseline", () => {
    // referenceVersion is in the baseline even with an empty marker region.
    const r = assessRelease({ ...BASE, latest: "0.147.0" });
    expect(r.playbackBaseline).toBe("0.148.0");
    expect(r.newerAvailable).toBe(false);
  });
});

describe("shouldInclude (matrix inclusion)", () => {
  const NEWER = { newerAvailable: true };
  const QUIET = { newerAvailable: false };

  it("includes entries with a newer build; a quiet week is an empty matrix", () => {
    expect(shouldInclude(NEWER)).toBe(true);
    expect(shouldInclude(QUIET)).toBe(false);
  });

  it("a pinned dispatch keeps its entry even when nothing is newer", () => {
    // The human asked for that leg explicitly (--version <v>).
    expect(shouldInclude(QUIET, { pinned: true })).toBe(true);
  });

  it("a forced dispatch keeps its entry even when nothing is newer", () => {
    expect(shouldInclude(QUIET, { force: true })).toBe(true);
  });

  it("flags do not force-include an entry that already passed through newerAvailable", () => {
    // Inclusion must never depend on anything but newerAvailable plus the
    // explicit dispatch flags — no accidental widening via other truthy
    // fields on the assessment object.
    expect(shouldInclude({ newerAvailable: false, jump: "major", latest: "1.0.0" })).toBe(false);
  });
});
