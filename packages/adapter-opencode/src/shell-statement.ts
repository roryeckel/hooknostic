import type { ShellDialect } from "@hooknostic/sdk";

/**
 * OpenCode picks its shell tool's interpreter from the host -- the `shell`
 * configuration key, then `SHELL`, then what `PATH` resolves -- and its tool
 * hooks carry nothing about the choice: one tool name ran PowerShell, Git Bash,
 * cmd and tcsh under identical hook input. What it does do is tell the model
 * which shell it runs, in a tool description a plugin also receives before the
 * call (ADR-0029). The name it stated was the interpreter that ran in every
 * captured case on 1.18.34 and 2.0.20 (`.capture/shell-dialects`).
 *
 * The statements are prose written for the model, not a contract. A wording
 * these patterns do not match yields no name, so no dialect: unknown, never a
 * guess.
 */

/** 1.x, in the `bash` tool's description: `Be aware: OS: win32, Shell: pwsh`, on a line of its own. */
const V1_STATEMENT = /^Be aware: OS: \S+, Shell: (\S+)[ \t]*\r?$/gm;

/**
 * 2.x, in the `shell` tool's description: `Commands run on Windows using pwsh.`,
 * as a sentence of its own -- at the start, or after one that ended. The same
 * words inside another sentence are an example or a quotation, not the statement.
 */
const V2_STATEMENT = /Commands run on \S+ using (\S+)\.(?=\s|$)/g;

/**
 * What must precede a 2.x statement: nothing, or the end of a sentence. Checked
 * on the text before each match rather than inside the pattern, so that one
 * statement's full stop can also open the next (consuming it would hide an
 * adjacent second statement), and without a lookbehind: this module loads
 * inside the harness's own runtime, where a literal its regex engine rejected
 * would stop the whole plugin loading.
 */
const SENTENCE_START = /(?:^|[.!?]\s+)$/;

/** One statement, or several that agree: a description naming two shells says which one runs nowhere. */
function stated(pattern: RegExp, description: unknown, precededBy?: RegExp): string | undefined {
  if (typeof description !== "string") return undefined;
  const names = new Set(
    [...description.matchAll(pattern)]
      .filter((match) => precededBy === undefined || precededBy.test(description.slice(0, match.index)))
      .map((match) => match[1]),
  );
  return names.size === 1 ? [...names][0] : undefined;
}

/** The shell name OpenCode 1.x states in its `bash` tool description, as the `tool.definition` hook delivers it. */
export function statedShellV1(description: unknown): string | undefined {
  return stated(V1_STATEMENT, description);
}

/** The shell name OpenCode 2.x states in its `shell` tool description, as the `context` hook delivers it. */
export function statedShellV2(description: unknown): string | undefined {
  return stated(V2_STATEMENT, description, SENTENCE_START);
}

/**
 * Only names a capture saw stated and then run. Anything else OpenCode can be
 * pointed at -- tcsh was captured running, and stays unlisted -- has no dialect
 * here rather than a family assumed from its name.
 */
const DIALECT_BY_STATED_SHELL: Readonly<Record<string, ShellDialect>> = {
  bash: "posix",
  zsh: "posix",
  powershell: "powershell",
  pwsh: "powershell",
  cmd: "cmd",
};

export function dialectOfStatedShell(name: unknown): ShellDialect | undefined {
  return typeof name === "string" && Object.hasOwn(DIALECT_BY_STATED_SHELL, name)
    ? DIALECT_BY_STATED_SHELL[name]
    : undefined;
}
