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

export function classifyOpenCodeTool(nativeName: string, input: unknown): ToolInvocation {
  const mcpMatch = /^([^_]+)_(.+)$/.exec(nativeName);
  const known = EXACT[nativeName.toLowerCase()];
  if (known !== undefined) {
    return { kind: known, nativeName, input };
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
