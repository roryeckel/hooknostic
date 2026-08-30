import type { ToolInvocation, ToolKind } from "@hooknostic/sdk";

/** OpenCode tool ids are lowercase (bash, read, edit, …). */
const EXACT: Record<string, ToolKind> = {
  bash: "shell",
  shell: "shell",
  read: "file.read",
  glob: "file.read",
  grep: "file.read",
  list: "file.read",
  write: "file.write",
  edit: "file.edit",
  patch: "file.edit",
  multiedit: "file.edit",
  webfetch: "web.fetch",
  websearch: "web.search",
  task: "agent",
  agent: "agent",
  todowrite: "other",
  todoread: "other",
};

/**
 * OpenCode's `bash` tool names the command `command`, verified against
 * `fixtures/opencode/1.18/tool-before.input.json`. `shell` appears in the
 * classification map but has no capture, so it is left undefined rather than
 * assumed to match.
 */
function opencodeShell(nativeName: string, input: unknown): { command: string } | undefined {
  if (nativeName.toLowerCase() !== "bash") return undefined;
  const command = (input as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" ? { command } : undefined;
}

export function classifyOpenCodeTool(nativeName: string, input: unknown): ToolInvocation {
  const mcpMatch = /^([^_]+)_(.+)$/.exec(nativeName);
  const known = EXACT[nativeName.toLowerCase()];
  if (known !== undefined) {
    const shell = opencodeShell(nativeName, input);
    return { kind: known, nativeName, input, ...(shell !== undefined ? { shell } : {}) };
  }
  // MCP tools surface as `<server>_<tool>`; without a registry we can only
  // best-effort split, keeping the native name authoritative.
  if (mcpMatch) {
    return {
      kind: "mcp",
      nativeName,
      input,
      mcp: { server: mcpMatch[1]!, tool: mcpMatch[2]! },
    };
  }
  return { kind: "other", nativeName, input };
}
