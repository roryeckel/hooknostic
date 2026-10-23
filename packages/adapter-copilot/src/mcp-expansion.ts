import type { AgentPluginComponentSupport, AgentPluginMcpServer } from "@hooknostic/agent-plugin";

export const ENVIRONMENT_EXPANSION_DEVIATION = "mcp-environment-expansion";

/** `${NAME}`, `${NAME:-fallback}` and bare `$NAME`: every form 1.0.101 expanded. */
const REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*/g;

/** The two exact placeholders Agent Plugins 1.0 §9.2 defines. */
const PACKAGE_ALIASES = new Set(["${PLUGIN_ROOT}", "${PLUGIN_DATA}"]);
const BARE_ALIASES = new Set(["$PLUGIN_ROOT", "$PLUGIN_DATA"]);

/**
 * The references Copilot expands in an MCP declaration, as written.
 *
 * Captured on 1.0.101 (.capture/copilot): `${NAME}`, `${NAME:-fallback}` and
 * bare `$NAME` all expand, embedded or whole, in a stdio command, args, env
 * values and an alias-rooted cwd, and in a remote url and header values. A
 * bare reference to an unset variable stays literal, `%NAME%` stays literal,
 * and header names are never expanded (so they are not scanned).
 *
 * Agent Plugins 1.0 expands only the exact `${PLUGIN_ROOT}` and
 * `${PLUGIN_DATA}`, only in stdio args, env and cwd, and requires all other
 * placeholder-like text to reach the client literally. Those exact aliases in
 * those fields are therefore conforming and excluded; everything else found
 * is a deviation. On the plugin route Copilot also expands the aliases in a
 * stdio command and in their bare and fallback spellings. On a remote server
 * the exact and bare aliases stayed literal, which conforms, but
 * `${PLUGIN_ROOT:-fallback}` was replaced by its fallback.
 */
export function copilotEnvironmentReferences(server: AgentPluginMcpServer): string[] {
  const references = new Set<string>();
  const collect = (texts: readonly string[], conforming: ReadonlySet<string>) => {
    for (const text of texts) {
      for (const [reference] of text.matchAll(REFERENCE)) {
        if (!conforming.has(reference)) references.add(reference);
      }
    }
  };
  if (server.type === "stdio") {
    collect([server.command], new Set());
    collect(
      [...(server.args ?? []), ...Object.values(server.env ?? {}), ...(server.cwd === undefined ? [] : [server.cwd])],
      PACKAGE_ALIASES,
    );
  } else {
    collect([server.url, ...Object.values(server.headers ?? {})], new Set([...PACKAGE_ALIASES, ...BARE_ALIASES]));
  }
  return [...references].sort();
}

export function declaresEnvironmentExpansion(support: AgentPluginComponentSupport | undefined): boolean {
  return support?.deviations?.some((deviation) => deviation.id === ENVIRONMENT_EXPANSION_DEVIATION) === true;
}

export function environmentExpansionReason(name: string, references: readonly string[]): string {
  return `server ${JSON.stringify(name)} declares ${references.join(", ")} in its url or header values; Copilot expands that ambient environment reference, where Agent Plugins 1.0 requires the text to reach the client literally. The exact package aliases, \${PLUGIN_ROOT} and \${PLUGIN_DATA}, stayed literal.`;
}
