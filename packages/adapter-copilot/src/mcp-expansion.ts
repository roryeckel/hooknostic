import type { AgentPluginComponentSupport, AgentPluginMcpServer } from "@hooknostic/agent-plugin";

export const ENVIRONMENT_EXPANSION_DEVIATION = "mcp-environment-expansion";

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

/**
 * The ambient variables Copilot expands in a remote server's declaration.
 *
 * Captured on 1.0.101 (.capture/copilot): `.mcp.json` and a plugin `mcp.json`
 * both sent `x-probe-ambient=C:\Users\…` for a `${USERPROFILE}` header, while
 * `${PLUGIN_ROOT}` stayed literal. Agent Plugins 1.0 says a client MUST NOT
 * expand anything in a remote url, header name or header value, so a package's
 * declaration with an ambient reference does not reach the server as written.
 * The two Agent Plugins aliases are excluded: Copilot leaves them literal here,
 * which conforms.
 */
export function copilotEnvironmentReferences(server: AgentPluginMcpServer): string[] {
  const names = new Set<string>();
  const texts =
    server.type === "stdio"
      ? [
          server.command,
          ...(server.args ?? []),
          ...Object.values(server.env ?? {}),
          ...(server.cwd === undefined ? [] : [server.cwd]),
        ]
      : [server.url, ...Object.values(server.headers ?? {})];
  for (const text of texts) {
    for (const match of text.matchAll(REFERENCE)) {
      const name = match[1]!;
      if (name !== "PLUGIN_ROOT" && name !== "PLUGIN_DATA") names.add(name);
    }
  }
  return [...names].sort();
}

export function declaresEnvironmentExpansion(support: AgentPluginComponentSupport | undefined): boolean {
  return support?.deviations?.some((deviation) => deviation.id === ENVIRONMENT_EXPANSION_DEVIATION) === true;
}

export function environmentExpansionReason(name: string, references: readonly string[]): string {
  const listed = references.map((reference) => `\${${reference}}`).join(", ");
  return `server ${JSON.stringify(name)} declares ${listed} in its url or headers; Copilot expands that ambient environment variable, where Agent Plugins 1.0 requires the text to reach the client literally. The two package aliases, \${PLUGIN_ROOT} and \${PLUGIN_DATA}, stayed literal.`;
}
