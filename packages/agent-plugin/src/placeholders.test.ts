import { describe, expect, it } from "vitest";

import { classifyStdioCwd, hasAmbiguousSeparator, hasUnportableCommandPath } from "./placeholders.js";

describe("classifyStdioCwd", () => {
  it.each([
    [undefined, { base: "root", relative: "." }],
    ["./", { base: "root", relative: "." }],
    ["./worker/./", { base: "root", relative: "worker" }],
    ["${PLUGIN_ROOT}/worker/..", { base: "root", relative: "." }],
    ["${PLUGIN_DATA}/state", { base: "data", relative: "state" }],
  ])("classifies %s", (cwd, expected) => {
    expect(classifyStdioCwd(cwd)).toEqual(expected);
  });

  it.each(["${PLUGIN_ROOT}/../escape", "${PLUGIN_DATA}/../escape", "../escape", "/absolute"])("refuses %s", (cwd) => {
    expect(classifyStdioCwd(cwd)).toBeUndefined();
  });

  // A backslash is one ordinary filename character on POSIX and a separator on
  // Windows, so this value passes containment where the package is built and
  // climbs out of the plugin root where it is consumed. Segments here are split
  // on "/" alone, so without the explicit refusal it survives as one segment.
  it.each(["./..\\..\\Windows", "${PLUGIN_ROOT}/..\\..\\x", "./worker\\sub"])(
    "refuses %s, whose meaning depends on the consumer's platform",
    (cwd) => {
      expect(classifyStdioCwd(cwd)).toBeUndefined();
    },
  );
});

describe("hasAmbiguousSeparator", () => {
  it("flags a backslash and nothing else", () => {
    expect(hasAmbiguousSeparator("./..\\..\\tool.exe")).toBe(true);
    expect(hasAmbiguousSeparator("./bin/serve")).toBe(false);
    expect(hasAmbiguousSeparator("node")).toBe(false);
  });
});

describe("hasUnportableCommandPath", () => {
  it("flags only a plugin-relative command", () => {
    expect(hasUnportableCommandPath("./..\\..\\tool.exe")).toBe(true);
    expect(hasUnportableCommandPath("./bin/serve")).toBe(false);
    // Not plugin-relative: a bare name carries no path semantics, and the
    // loader already forbids a separator in one. An absolute command belongs to
    // whoever wrote it -- on Windows it contains backslashes by construction,
    // and refusing it would reject every such server.
    expect(hasUnportableCommandPath("node")).toBe(false);
    expect(hasUnportableCommandPath("C:\\Program Files\\nodejs\\node.exe")).toBe(false);
  });
});
