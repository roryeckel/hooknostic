import type { AgentPluginMcpConfig } from "./types.js";

/** How one stdio server's declared command is resolved when it is launched. */
export interface McpServerCommand {
  /** The server name, as declared in `mcp.json`. */
  server: string;
  command: string;
  /** Whether the command comes from a package, direct project source, or PATH. */
  resolution: "package" | "project" | "path-lookup";
}

/**
 * How each stdio server's declared command is resolved.
 *
 * Derived, never declared, and deliberately without a registry of "known"
 * runners. A relative command is supplied by its source: either a packaged
 * component or a direct project component. A bare executable name is a PATH
 * lookup on the consumer's machine.
 *
 * This makes no claim about interpreters, dynamic libraries, daemons, or other
 * transitive runtime dependencies. Remote servers have no command to report
 * because Hooknostic does not spawn them.
 */
export function mcpServerCommands(
  config: AgentPluginMcpConfig | undefined,
  origin: "package" | "direct" = "package",
): McpServerCommand[] {
  if (config === undefined) return [];
  const entries: McpServerCommand[] = [];
  for (const [server, value] of Object.entries(config.mcpServers)) {
    if (value.type !== "stdio") continue;
    entries.push({
      server,
      command: value.command,
      resolution: value.command.startsWith("./") ? (origin === "package" ? "package" : "project") : "path-lookup",
    });
  }
  return entries.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
}

/** Every distinct declared command the launcher looks up on PATH, sorted. */
export function mcpPathCommands(entries: readonly McpServerCommand[]): string[] {
  return [
    ...new Set(entries.filter((entry) => entry.resolution === "path-lookup").map((entry) => entry.command)),
  ].sort();
}
