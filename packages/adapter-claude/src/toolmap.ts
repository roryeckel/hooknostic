import type { ShellShapes, ToolInvocation, ToolKind } from "@hooknostic/sdk";
import { shellCodec } from "@hooknostic/sdk";

/**
 * Best-effort classification of Claude Code tool names into normalized
 * categories. Unknown tools are "other"; the native name always survives.
 * MCP tools follow `mcp__<server>__<tool>` (plugin-bundled servers appear as
 * `mcp__plugin_<plugin>_<server>__<tool>` and keep the composite server id).
 */
const EXACT: Record<string, ToolKind> = {
  Bash: "shell",
  PowerShell: "shell",
  BashOutput: "other",
  Read: "file.read",
  Glob: "file.read",
  Grep: "file.read",
  Write: "file.write",
  Edit: "file.edit",
  MultiEdit: "file.edit",
  NotebookEdit: "file.edit",
  WebFetch: "web.fetch",
  WebSearch: "web.search",
  Task: "agent",
  Agent: "agent",
};

/**
 * Claude's shell tools name the command `command`. Both entries are
 * capture-backed: `fixtures/claude/2.1/pre-tool-bash.input.json` and
 * `pre-tool-powershell.input.json` (the latter captured 2.1.250 -- it had
 * rested on inference). Anything else shell-kind is absent from the table, so
 * both codec directions decline rather than guess. Neither tool has a working-directory
 * key.
 */
export const CLAUDE_SHELL_SHAPES: ShellShapes = {
  Bash: { commandKey: "command" },
  PowerShell: { commandKey: "command" },
};

export const claudeShellCodec = shellCodec(CLAUDE_SHELL_SHAPES);

export function classifyClaudeTool(nativeName: string, input: unknown): ToolInvocation {
  const mcpMatch = /^mcp__(.+)__([^_].*)$/.exec(nativeName);
  if (mcpMatch) {
    return {
      kind: "mcp",
      nativeName,
      input,
      mcp: { server: mcpMatch[1]!, tool: mcpMatch[2]! },
    };
  }
  const shell = claudeShellCodec.classify(nativeName, input);
  return {
    kind: EXACT[nativeName] ?? "other",
    nativeName,
    input,
    ...(shell !== undefined ? { shell } : {}),
  };
}
