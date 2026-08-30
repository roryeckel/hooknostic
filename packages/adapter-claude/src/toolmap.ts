import type { ToolInvocation, ToolKind } from "@hooknostic/sdk";

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
 * Claude's shell tools name the command `command`. Verified against
 * `fixtures/claude/2.1/pre-tool-bash.input.json`; `PowerShell` uses the same
 * key. Anything else shell-kind is left undefined rather than guessed.
 */
function claudeShell(nativeName: string, input: unknown): { command: string } | undefined {
  if (nativeName !== "Bash" && nativeName !== "PowerShell") return undefined;
  const command = (input as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" ? { command } : undefined;
}

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
  const shell = claudeShell(nativeName, input);
  return {
    kind: EXACT[nativeName] ?? "other",
    nativeName,
    input,
    ...(shell !== undefined ? { shell } : {}),
  };
}
