/**
 * Best-effort normalized classification of a tool invocation. The category
 * exists for portable matching; the native tool name and raw event remain
 * available so a plugin can intentionally use harness-specific behavior.
 */
export const TOOL_KINDS = [
  "shell",
  "file.read",
  "file.write",
  "file.edit",
  "web.fetch",
  "web.search",
  "agent",
  "mcp",
  "other",
] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

export interface ToolInvocation {
  kind: ToolKind;

  /** The harness's own name for the tool (escape hatch; never normalized away). */
  nativeName: string;

  /** The tool input exactly as the harness reports it. */
  input: unknown;

  /** Present when the tool is an MCP tool and the harness exposes the split. */
  mcp?: {
    server?: string;
    tool?: string;
  };

  /**
   * The shell invocation, normalized, when the adapter knows this tool's
   * argument shape.
   *
   * `kind` is portable but `input` is not: Claude's `Bash` names the command
   * `command`, Codex's `exec_command` names it `cmd` (captured on 0.151.0 --
   * see `.capture/codex-tools/README.md`). A guard matching `kind: "shell"` and
   * reading `input.command` therefore compiles, checks and matches everywhere
   * while silently permitting a whole harness's shell calls.
   *
   * Deliberately optional, and its absence is informative: where a shell-kind
   * tool's argument shape has not been captured, the adapter leaves this
   * undefined rather than guessing, and a hook should fall back to `input`.
   * `input` always stays the verbatim payload -- this is derived from it, never
   * a replacement for it.
   */
  shell?: {
    command: string;
    cwd?: string;
  };
}

/** Declarative matcher applied to tool-scoped events before handlers run. */
export interface ToolMatch {
  /** Match one or more normalized categories. */
  kind?: ToolKind | ToolKind[];
  /** Match exact native tool name(s). */
  nativeName?: string | string[];
}

export function matchesTool(match: ToolMatch | undefined, tool: ToolInvocation): boolean {
  if (!match) return true;
  if (match.kind !== undefined) {
    const kinds = Array.isArray(match.kind) ? match.kind : [match.kind];
    if (!kinds.includes(tool.kind)) return false;
  }
  if (match.nativeName !== undefined) {
    const names = Array.isArray(match.nativeName) ? match.nativeName : [match.nativeName];
    if (!names.includes(tool.nativeName)) return false;
  }
  return true;
}
