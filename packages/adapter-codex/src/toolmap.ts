import type { ToolInvocation, ToolKind } from "@hooknostic/sdk";

/**
 * Codex tool-name classification (0.148.0): shell paths surface as `Bash` /
 * `exec_command`; `apply_patch` is the edit path; local function tools like
 * `update_plan` stay "other"; `spawn_agent` is the subagent tool; MCP tools
 * follow the `mcp__<server>__<tool>` convention.
 */
const EXACT: Record<string, ToolKind> = {
  Bash: "shell",
  exec_command: "shell",
  shell: "shell",
  apply_patch: "file.edit",
  Edit: "file.edit",
  Write: "file.write",
  Read: "file.read",
  view_image: "file.read",
  web_search: "web.search",
  WebSearch: "web.search",
  spawn_agent: "agent",
  Agent: "agent",
  update_plan: "other",
};

export function classifyCodexTool(nativeName: string, input: unknown): ToolInvocation {
  const mcpMatch = /^mcp__(.+)__([^_].*)$/.exec(nativeName);
  if (mcpMatch) {
    return {
      kind: "mcp",
      nativeName,
      input,
      mcp: { server: mcpMatch[1]!, tool: mcpMatch[2]! },
    };
  }
  return { kind: EXACT[nativeName] ?? "other", nativeName, input };
}
