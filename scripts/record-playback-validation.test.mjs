import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isMainModule, rewriteRollingRecord, ROLLING_WHAT } from "./record-playback-validation.mjs";

const BEGIN = "// scheduled-playback:begin";
const END = "// scheduled-playback:end";

describe("isMainModule", () => {
  it("recognizes an absolute script path on the current platform", () => {
    const scriptPath = resolve("scripts/record-playback-validation.mjs");
    expect(isMainModule(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    expect(isMainModule(pathToFileURL(scriptPath).href, resolve("other.mjs"))).toBe(false);
  });
});

// A minimal stand-in for the real profile source: prior records above the
// markers, empty marker region, trailing content after the array.
const EMPTY_REGION = [
  'import type { CapabilityProfile } from "@hooknostic/core";',
  "",
  "export const fakeCapabilityProfiles: CapabilityProfile[] = [",
  "  {",
  '    range: ">=1.0 <2",',
  "    source: {",
  '      date: "2026-08-29",',
  "      validatedOn: [",
  "        {",
  '          version: "1.18.18",',
  '          date: "2026-08-20",',
  '          method: "captured",',
  '          artifact: "fixtures/fake/1.18",',
  '          what: "hook payload fixtures",',
  "        },",
  "        // scheduled-playback: at most one rolling live-probe record, rewritten",
  "        // in place by scripts/record-playback-validation.mjs (harness-watch workflow).",
  "        // Git history is the audit trail; see ADR-0009 and",
  "        // .capture/harness-playback/README.md. Keep field order stable.",
  "        " + BEGIN,
  "        " + END,
  "      ],",
  '      notes: ["https://fake.example/docs"],',
  "    },",
  "    matrix: {},",
  "  },",
  "];",
  "",
].join("\n");

describe("rewriteRollingRecord", () => {
  it("inserts the record into an empty marker region", () => {
    const next = rewriteRollingRecord(EMPTY_REGION, {
      version: "1.18.30",
      date: "2026-09-09",
    });
    expect(next).toContain('version: "1.18.30"');
    expect(next).toContain('date: "2026-09-09"');
    expect(next).toContain('method: "live-probe"');
    expect(next).toContain('artifact: ".capture/harness-playback"');
    expect(next).toContain(ROLLING_WHAT);
    // Exactly one record between the markers.
    const between = next.slice(next.indexOf(BEGIN), next.indexOf(END));
    expect(between.match(/version:/g)).toHaveLength(1);
  });

  it("replaces an existing rolling record in place, version and date only", () => {
    const withRecord = rewriteRollingRecord(EMPTY_REGION, {
      version: "1.18.30",
      date: "2026-09-09",
    });
    const replaced = rewriteRollingRecord(withRecord, {
      version: "1.18.31",
      date: "2026-09-16",
    });
    expect(replaced).not.toContain("1.18.30");
    expect(replaced).toContain('version: "1.18.31"');
    expect(replaced).toContain('date: "2026-09-16"');
    const between = replaced.slice(replaced.indexOf(BEGIN), replaced.indexOf(END));
    expect(between.match(/version:/g)).toHaveLength(1);
  });

  it("is byte-identical outside the marker region", () => {
    const withRecord = rewriteRollingRecord(EMPTY_REGION, {
      version: "1.18.30",
      date: "2026-09-09",
    });
    const replaced = rewriteRollingRecord(withRecord, {
      version: "1.18.31",
      date: "2026-09-16",
    });
    const before = (s) => s.slice(0, s.indexOf(BEGIN));
    const after = (s) => s.slice(s.indexOf(END) + END.length);
    expect(before(replaced)).toBe(before(withRecord));
    expect(after(replaced)).toBe(after(withRecord));
    // The prior human records above the markers are untouched.
    expect(replaced).toContain('version: "1.18.18"');
    expect(replaced).toContain('what: "hook payload fixtures"');
    // Comment block between markers survives.
    expect(replaced).toContain("at most one rolling live-probe record");
  });

  it("throws on missing markers and on duplicated markers", () => {
    const noMarkers = EMPTY_REGION.split("\n")
      .filter((line) => !line.includes(BEGIN) && !line.includes(END))
      .join("\n");
    expect(() => rewriteRollingRecord(noMarkers, { version: "1.18.30", date: "2026-09-09" })).toThrow();
    const duplicated = EMPTY_REGION.replace(
      "      ],",
      `        ${BEGIN}\n        ${END}\n      ],\n      // stray ${BEGIN} ${END}`,
    );
    expect(() => rewriteRollingRecord(duplicated, { version: "1.18.30", date: "2026-09-09" })).toThrow();
  });

  it("keeps CRLF files CRLF", () => {
    const crlf = EMPTY_REGION.replace(/\n/g, "\r\n");
    const next = rewriteRollingRecord(crlf, {
      version: "1.18.30",
      date: "2026-09-09",
    });
    expect(next).toContain("\r\n");
    expect(next).not.toContain("});\r\n\r\n        }");
    const between = next.slice(next.indexOf(BEGIN), next.indexOf(END));
    expect(between).toContain('version: "1.18.30",\r\n');
    expect(between.match(/\r\n/g).length).toBeGreaterThan(8);
  });
});
