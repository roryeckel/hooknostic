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
