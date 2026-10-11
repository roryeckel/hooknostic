import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadFixture } from "@hooknostic/testkit";

import { dialectOfStatedShell, statedShellV1, statedShellV2 } from "./shell-statement.js";

interface ObservedCase {
  harness: string;
  case: string;
  reported?: { statement: string | null; beforeCall: boolean };
  execution: { ancestry: { name?: string; path: string }[] };
}

/** Every promoted case in which OpenCode stated its shell, with the interpreter that then ran. */
const OBSERVED = [
  "observations",
  "observations-configured",
  "observations-linux",
  "observations-configured-linux",
  "observations-builds",
]
  .flatMap((file) => {
    const path = fileURLToPath(new URL(`../../../.capture/shell-dialects/${file}.json`, import.meta.url));
    return (JSON.parse(readFileSync(path, "utf8")) as { cases: ObservedCase[] }).cases.map((entry) => ({
      file,
      entry,
    }));
  })
  .filter(({ entry }) => entry.reported !== undefined);

/** The executable's name as the harness would state it: `C:\...\pwsh.EXE` and `/usr/bin/zsh` alike. */
function interpreterName(entry: ObservedCase): string {
  const parent = entry.execution.ancestry[1]!;
  return (parent.name ?? parent.path)
    .split(/[\\/]/)
    .at(-1)!
    .toLowerCase()
    .replace(/\.exe$/, "");
}

describe("the shell OpenCode states", () => {
  it("is read from every captured statement as the interpreter that ran", () => {
    // The parsers are held to the evidence they exist for: a pattern that
    // stops reading a statement these builds made is a regression, and one
    // that reads a different name than the interpreter is a wrong dialect.
    // Both generations, or the loop below would pass by checking nothing.
    expect([...new Set(OBSERVED.map(({ entry }) => entry.harness))].sort()).toEqual(["opencode-v1", "opencode-v2"]);
    for (const { file, entry } of OBSERVED) {
      const read = entry.harness === "opencode-v1" ? statedShellV1 : statedShellV2;
      expect(read(entry.reported!.statement), `${file} ${entry.harness} ${entry.case}`).toBe(interpreterName(entry));
      expect(entry.reported!.beforeCall, `${file} ${entry.harness} ${entry.case}`).toBe(true);
    }
  });

  it("is found inside the description the harness hands a plugin", () => {
    // 2.x: a whole captured context hook. 1.x: the statement on its own line,
    // between paragraphs, as the tool.definition hook delivered it.
    const context = loadFixture<{ event: { tools: { shell: { description: string } } } }>(
      "opencode",
      "2.0",
      "context.input.json",
    );
    expect(statedShellV2(context.event.tools.shell.description)).toBe("powershell");
    expect(
      statedShellV1("Executes a given cmd.exe command.\n\nBe aware: OS: win32, Shell: cmd\n\nAll commands run"),
    ).toBe("cmd");
    expect(statedShellV1("Executes a command.\r\n\r\nBe aware: OS: linux, Shell: zsh\r\n\r\nAll")).toBe("zsh");
  });

  it("is not read from wording that only resembles a statement", () => {
    for (const description of [
      undefined,
      42,
      "",
      "Shell: bash",
      "Note the user's notes say: Be aware: OS: linux, Shell: bash is assumed",
      "Be aware: OS: linux, Shell: bash and zsh",
    ]) {
      expect(statedShellV1(description), String(description)).toBeUndefined();
    }
    for (const description of [
      undefined,
      "",
      "Commands run using bash.",
      "Commands run on Linux using bash",
      // The same words inside another sentence are an example, not the statement.
      "Execute a shell command. For example, Commands run on Linux using cmd. Quote paths.",
      'The harness may say "Commands run on Linux using cmd." in its description.',
    ]) {
      expect(statedShellV2(description), String(description)).toBeUndefined();
    }
    // A name with a dot is read whole, so it cannot pass for the shell it starts with.
    expect(statedShellV2("Commands run on Linux using bash.real. Quote paths.")).toBe("bash.real");
  });

  it("is not read from a description that names two different shells", () => {
    // Picking the first would hand a hook one grammar on the strength of a
    // description that asserts two. Statements that agree are one statement.
    expect(statedShellV1("Be aware: OS: linux, Shell: bash\n\nBe aware: OS: linux, Shell: tcsh")).toBeUndefined();
    expect(
      statedShellV2("Commands run on Linux using zsh. Quote paths. Commands run on Linux using cmd. Thanks."),
    ).toBeUndefined();
    // Adjacent ones share a full stop: the first statement's end is the second's start.
    expect(statedShellV2("Commands run on Windows using zsh. Commands run on Windows using cmd.")).toBeUndefined();
    expect(statedShellV1("Be aware: OS: linux, Shell: bash\nBe aware: OS: linux, Shell: tcsh")).toBeUndefined();
    expect(statedShellV1("Be aware: OS: linux, Shell: zsh\n\nBe aware: OS: linux, Shell: zsh")).toBe("zsh");
    expect(statedShellV2("Commands run on Linux using zsh. Really. Commands run on Linux using zsh.")).toBe("zsh");
  });
});

describe("dialectOfStatedShell", () => {
  it("maps only the shells a capture saw stated and run", () => {
    expect(
      Object.fromEntries(
        ["bash", "zsh", "powershell", "pwsh", "cmd"].map((name) => [name, dialectOfStatedShell(name)]),
      ),
    ).toEqual({ bash: "posix", zsh: "posix", powershell: "powershell", pwsh: "powershell", cmd: "cmd" });
    // tcsh was captured running under the same tool: a real shell this adapter
    // must not hand a POSIX parser. Unknown names are unknown, whatever they resemble.
    for (const name of ["tcsh", "sh", "fish", "nu", "Bash", "bash.real", "constructor", "", undefined, 42]) {
      expect(dialectOfStatedShell(name), String(name)).toBeUndefined();
    }
  });

  it("gives every captured case the family of the interpreter that ran", () => {
    const families: Record<string, string | undefined> = {
      bash: "posix",
      zsh: "posix",
      powershell: "powershell",
      pwsh: "powershell",
      cmd: "cmd",
      tcsh: undefined,
    };
    for (const { file, entry } of OBSERVED) {
      const name = interpreterName(entry);
      expect(Object.hasOwn(families, name), `${file} ${entry.case} ran ${name}`).toBe(true);
      const read = entry.harness === "opencode-v1" ? statedShellV1 : statedShellV2;
      expect(dialectOfStatedShell(read(entry.reported!.statement)), `${file} ${entry.case}`).toBe(families[name]);
    }
  });
});
