import type { FileShapes, ShellShapes, ToolInvocation, ToolKind } from "@hooknostic/sdk";
import { fileCodec, shellCodec } from "@hooknostic/sdk";

/**
 * Best-effort classification of Claude Code tool names into normalized
 * categories. Unknown tools are "other"; the native name always survives.
 * MCP tools follow `mcp__<server>__<tool>` (plugin-bundled servers appear as
 * `mcp__plugin_<plugin>_<server>__<tool>` and keep the composite server id).
 */
export const CLAUDE_TOOL_KINDS: Record<string, ToolKind> = {
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

/**
 * Claude's file tools name their one target `file_path`; NotebookEdit names it
 * `notebook_path`. Each entry is capture-backed: pre-tool-read (2.1.238) and
 * pre-tool-{write,edit,notebookedit} (2.1.283). MultiEdit was not advertised on
 * 2.1.283 and Glob/Grep target a pattern, not a file -- all absent (ADR-0026).
 */
export const CLAUDE_FILE_SHAPES: FileShapes = {
  Read: { pathKey: "file_path" },
  Write: { pathKey: "file_path" },
  Edit: { pathKey: "file_path" },
  NotebookEdit: { pathKey: "notebook_path" },
};

export const claudeFileCodec = fileCodec(CLAUDE_FILE_SHAPES);

export const CLAUDE_MCP_TOOL = /^mcp__(.+)__([^_].*)$/;

export function classifyClaudeTool(nativeName: string, input: unknown): ToolInvocation {
  const mcpMatch = CLAUDE_MCP_TOOL.exec(nativeName);
  if (mcpMatch) {
    return {
      kind: "mcp",
      nativeName,
      input,
      mcp: { server: mcpMatch[1]!, tool: mcpMatch[2]! },
    };
  }
  const shell = claudeShellCodec.classify(nativeName, input);
  const file = claudeFileCodec.classify(nativeName, input);
  return {
    kind: (Object.hasOwn(CLAUDE_TOOL_KINDS, nativeName) ? CLAUDE_TOOL_KINDS[nativeName] : undefined) ?? "other",
    nativeName,
    input,
    ...(shell !== undefined ? { shell } : {}),
    ...(file !== undefined ? { file } : {}),
  };
}
