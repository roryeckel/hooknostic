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

/**
 * Codex's shell tools disagree about the key: `Bash` uses `command`,
 * `exec_command` uses `cmd` and carries `workdir` (captured on codex-cli
 * 0.151.0 -- see `.capture/codex-tools/README.md`). `shell` as a tool NAME was
 * never observed and its shape is unknown, so it is deliberately left
 * undefined: a hook falls back to `input` rather than being handed a guess.
 */
function codexShell(
  nativeName: string,
  input: unknown,
): { command: string; cwd?: string } | undefined {
  const args = input as { command?: unknown; cmd?: unknown; workdir?: unknown } | null | undefined;
  const command = nativeName === "Bash" ? args?.command : nativeName === "exec_command" ? args?.cmd : undefined;
  if (typeof command !== "string") return undefined;
  return typeof args?.workdir === "string" ? { command, cwd: args.workdir } : { command };
}

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
  const shell = codexShell(nativeName, input);
  return {
    kind: EXACT[nativeName] ?? "other",
    nativeName,
    input,
    ...(shell !== undefined ? { shell } : {}),
  };
}
