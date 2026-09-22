import {
  type AgentPluginComponentSupport,
  type AgentPluginMcpServer,
  PLUGIN_DATA_PLACEHOLDER,
  PLUGIN_ROOT_PLACEHOLDER,
} from "@hooknostic/agent-plugin";

/**
 * Claude's `.mcp.json` substitutes set environment variables into MCP
 * configuration text, which Agent Plugins 1.0 requires to stay literal
 * (ADR-0019). Declared on the package and project profiles; this is the id both
 * report.
 */
export const ENVIRONMENT_EXPANSION_DEVIATION = "mcp-environment-expansion";

// Both forms are captured on both routes (`.capture/agent-plugin-mcp-placeholders`,
// `.capture/claude-project-mcp-environment`): a set `${NAME}` becomes its value,
// and `${NAME:-default}` becomes the value or the default. Header NAMES are not
// scanned: Claude keeps them literal and refuses the brace as an invalid name,
// which is what the specification asks of it.
const CLAUDE_EXPANDED_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/g;

/**
 * Package text Claude would expand although the specification keeps it literal,
 * in the form a projection hands Claude.
 *
 * On a stdio server the projection translates `${PLUGIN_ROOT}` and
 * `${PLUGIN_DATA}` in args, env values and cwd to Claude's own variables, which
 * is the specification's expansion done by Claude, so those two are not
 * reported there. Everywhere else they count like any other name: the
 * specification expands nothing in `command`, a remote url, or a header.
 */
export function claudeExpandedReferences(server: AgentPluginMcpServer): string[] {
  const translatable =
    server.type === "stdio"
      ? [...(server.args ?? []), ...Object.values(server.env ?? {}), ...(server.cwd === undefined ? [] : [server.cwd])]
      : [];
  const literal = server.type === "stdio" ? [server.command] : [server.url, ...Object.values(server.headers ?? {})];
  const references = new Set<string>();
  for (const [text, translated] of [
    ...translatable.map((text) => [text, true] as const),
    ...literal.map((text) => [text, false] as const),
  ]) {
    for (const [reference] of text.matchAll(CLAUDE_EXPANDED_REFERENCE)) {
      if (translated && (reference === PLUGIN_ROOT_PLACEHOLDER || reference === PLUGIN_DATA_PLACEHOLDER)) continue;
      references.add(reference);
    }
  }
  return [...references];
}

/** Whether the resolved cell declares Claude's expansion for this component. */
export function declaresEnvironmentExpansion(cell: AgentPluginComponentSupport | undefined): boolean {
  return cell?.deviations?.some((deviation) => deviation.id === ENVIRONMENT_EXPANSION_DEVIATION) ?? false;
}

export function environmentExpansionReason(name: string, references: readonly string[]): string {
  return `MCP server ${JSON.stringify(name)} contains ${references.join(", ")}, which Agent Plugins 1.0 requires to remain literal; Claude substitutes a set environment variable into it, so the server may receive that value instead.`;
}
