import type { AgentPluginComponentSupport, AgentPluginMcpServer } from "@hooknostic/agent-plugin";

export const ENVIRONMENT_EXPANSION_DEVIATION = "mcp-environment-expansion";

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

/**
 * The ambient variables Copilot expands in an MCP declaration.
 *
 * Captured on 1.0.101 (.capture/copilot): `.mcp.json` and a plugin `mcp.json`
 * expanded `${USERPROFILE}`, `${NAME:-fallback}` and a set ambient variable in
 * both a remote URL query and header values, while `${PLUGIN_ROOT}` and
 * `${PLUGIN_DATA}` stayed literal. The remote probes did not exercise a
 * placeholder in a header name. Agent Plugins 1.0 says a client MUST NOT expand
 * anything in a remote url, header name or header value, so a detected
 * reference does not reach the server as written. The two package aliases are
 * excluded: Copilot leaves them literal here, which conforms.
 */
export function copilotEnvironmentReferences(server: AgentPluginMcpServer): string[] {
  const names = new Set<string>();
  const collect = (texts: readonly string[], aliasesAreDeviation: boolean) => {
    for (const text of texts) {
      for (const match of text.matchAll(REFERENCE)) {
        const name = match[1]!;
        if (aliasesAreDeviation || (name !== "PLUGIN_ROOT" && name !== "PLUGIN_DATA")) names.add(name);
      }
    }
  };
  if (server.type === "stdio") {
    // §9.2 expands the aliases in args, env and cwd only; Copilot also expands
    // them in command (captured), which the spec explicitly excludes. Ambient
    // variables are a deviation in every one of those fields.
    collect([server.command], true);
    collect(
      [...(server.args ?? []), ...Object.values(server.env ?? {}), ...(server.cwd === undefined ? [] : [server.cwd])],
      false,
    );
  } else {
    collect([server.url, ...Object.values(server.headers ?? {})], false);
  }
  return [...names].sort();
}

export function declaresEnvironmentExpansion(support: AgentPluginComponentSupport | undefined): boolean {
  return support?.deviations?.some((deviation) => deviation.id === ENVIRONMENT_EXPANSION_DEVIATION) === true;
}

export function environmentExpansionReason(name: string, references: readonly string[]): string {
  const listed = references.map((reference) => `\${${reference}}`).join(", ");
  return `server ${JSON.stringify(name)} declares ${listed} in its url or header values; Copilot expands that ambient environment variable, where Agent Plugins 1.0 requires the text to reach the client literally. The two package aliases, \${PLUGIN_ROOT} and \${PLUGIN_DATA}, stayed literal.`;
}
