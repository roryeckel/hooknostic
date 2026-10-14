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

  it("never met a Bash call on the Windows host with no Git for Windows", () => {
    // `Bash` is pinned to posix on the strength of Git Bash being what runs it
    // on Windows. On a host without one, the pin holds only because no `Bash`
    // call exists there: not advertised where Claude Code started, and no
    // start at all otherwise. A call that reached a hook as `Bash` and ran
    // nothing would have no interpreter for the test above to judge, so it is
    // ruled out here, along with a re-capture that began to offer the tool.
    const path = fileURLToPath(
      new URL("../../../.capture/shell-dialects/observations-without-git.json", import.meta.url),
    );
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      host: { gitForWindows: string[]; bashOnPath: string[] };
      configurations: {
        configuration: string;
        started: boolean;
        requests?: number;
        output?: string;
        advertised?: { name: string }[];
      }[];
      cases: ObservedCase[];
    };
    expect(record.host.gitForWindows).toEqual([]);
    // The eight host configurations the validation record describes. They are
    // named here, not read back from the record, so one cut down to fewer fails.
    // The driver adds a ninth only on a host with a bash.exe on PATH, which this one had not.
    expect(record.configurations.map((entry) => entry.configuration).sort()).toEqual(
      [
        "claude-code-shell-powershell",
        "default",
        "git-bash-path-cmd",
        "git-bash-path-cmd-powershell-tool-off",
        "git-bash-path-missing",
        "git-bash-path-powershell",
        "powershell-tool-off",
        "shell-powershell",
        ...(record.host.bashOnPath.length > 0 ? ["git-bash-path-bash-on-path"] : []),
      ].sort(),
    );
    // A call is named for its tool and its configuration, which promotion enforces.
    const callsUnder = (configuration: string) =>
      record.cases.filter((candidate) =>
        Object.keys(CLAUDE_SHELL_SHAPES).some((tool) => candidate.case === `${tool.toLowerCase()}-${configuration}`),
      );
    const started = record.configurations.filter((entry) => entry.started);
    expect(started.length).toBeGreaterThan(0);
    for (const entry of started) {
      expect(
        entry.advertised!.map((tool) => tool.name),
        entry.configuration,
      ).toEqual(["PowerShell"]);
      // Its one advertised tool was then called under that configuration, and that is what a hook saw.
      expect(
        callsUnder(entry.configuration).map((call) => call.before?.tool_name),
        entry.configuration,
      ).toEqual(["PowerShell"]);
    }
    // One that did not start made no model request, so it advertised nothing and
    // called nothing. What it printed is the harness's own word that the host has
    // no Git Bash, which the driver's check for an install cannot give by itself.
    for (const entry of record.configurations.filter((candidate) => !candidate.started)) {
      expect(entry.requests, entry.configuration).toBe(0);
      expect(entry.output, entry.configuration).toContain("Git Bash was not found");
      expect(callsUnder(entry.configuration), entry.configuration).toEqual([]);
    }
    // No call is left over: none under a configuration that is not listed, none under another name.
    expect(record.cases).toHaveLength(started.length);
  });
});
