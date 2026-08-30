import type { ShellShapes, ToolInvocation, ToolKind } from "@hooknostic/sdk";
import { shellCodec } from "@hooknostic/sdk";

/**
 * Codex tool-name classification (names observed on 0.148.0; the
 * `exec_command` argument shape below on 0.151.0): shell paths surface as `Bash` /
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
 * `exec_command` uses `cmd` and carries `workdir`. At the hook boundary,
 * 0.151.0 translates `exec_command` calls into `Bash`/`command` payloads (and
 * drops `workdir`), so the `exec_command` entry is defensive coverage for a
 * version or surface that passes the router shape through -- its provenance is
 * the router debug log, not a captured hook payload. See
 * `.capture/codex-tools/README.md`. `shell` as a tool NAME was never observed
 * and its shape is unknown, so it is deliberately absent: a hook falls back to
 * `input` rather than being handed a guess.
 */
export const CODEX_SHELL_SHAPES: ShellShapes = {
  Bash: { commandKey: "command" },
  exec_command: { commandKey: "cmd", cwdKey: "workdir" },
};

export const codexShellCodec = shellCodec(CODEX_SHELL_SHAPES);

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
  const shell = codexShellCodec.classify(nativeName, input);
  return {
    kind: (Object.hasOwn(EXACT, nativeName) ? EXACT[nativeName] : undefined) ?? "other",
    nativeName,
    input,
    ...(shell !== undefined ? { shell } : {}),
  };
}
