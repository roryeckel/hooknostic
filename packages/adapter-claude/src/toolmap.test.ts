import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ShellDialect } from "@hooknostic/sdk";

import { CLAUDE_SHELL_SHAPES } from "./toolmap.js";

interface ObservedCase {
  harness: string;
  case: string;
  before: { tool_name: string } | null;
  /** Absent where a call reached the hook and ran nothing. */
  execution: { ancestry: { name?: string; path: string }[] } | null;
}

/** Every promoted comparison that drove Claude Code (`.capture/shell-dialects`). */
const COMPARISONS = [
  "observations",
  "observations-macos",
  "observations-linux",
  "observations-configured",
  "observations-configured-linux",
  "observations-builds",
  "observations-without-git",
];

const OBSERVED = COMPARISONS.flatMap((file) => {
  const path = fileURLToPath(new URL(`../../../.capture/shell-dialects/${file}.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { cases: ObservedCase[] }).cases
    .filter((entry) => entry.harness === "claude")
    .map((entry) => ({ file, entry }));
});

/** The grammar family of each interpreter these captures saw run. Anything else has none here. */
const FAMILY: Record<string, ShellDialect> = {
  bash: "posix",
  zsh: "posix",
  powershell: "powershell",
  pwsh: "powershell",
};

/** The executable's name: `C:\...\bash.exe` and `/usr/bin/zsh` alike. */
function interpreterName(entry: ObservedCase): string {
  const parent = entry.execution!.ancestry[1]!;
  return (parent.name ?? parent.path)
    .split(/[\\/]/)
    .at(-1)!
    .toLowerCase()
    .replace(/\.exe$/, "");
}

describe("the dialect each Claude Code shell tool pins", () => {
  it("is the family of the interpreter that ran in every captured call", () => {
    // The table pins a dialect by tool name alone (ADR-0029), so it is held to
    // every call a capture saw: a call that reached a hook under one of these
    // names and ran an interpreter of another family is a wrong dialect, on
    // whatever host and under whatever configuration that was.
    const ran = OBSERVED.filter(({ entry }) => entry.execution !== null);
    for (const { file, entry } of ran) {
      const tool = entry.before?.tool_name;
      const label = `${file} ${entry.case}`;
      expect(tool, `${label}: an interpreter ran, so a hook saw the call`).toBeDefined();
      expect(Object.hasOwn(CLAUDE_SHELL_SHAPES, tool!), `${label}: ${tool} is a pinned shell tool`).toBe(true);
      expect(FAMILY[interpreterName(entry)], `${label}: ${tool} ran ${interpreterName(entry)}`).toBe(
        CLAUDE_SHELL_SHAPES[tool!]!.dialect,
      );
    }
    // Each comparison still contributes, and each pinned tool was seen running:
    // a re-promotion that lost one would otherwise leave this checking less.
    expect([...new Set(ran.map(({ file }) => file))].sort()).toEqual([...COMPARISONS].sort());
    expect([...new Set(ran.map(({ entry }) => entry.before!.tool_name))].sort()).toEqual(
      Object.keys(CLAUDE_SHELL_SHAPES).sort(),
    );
  });
});
