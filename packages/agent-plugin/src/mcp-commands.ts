import type { AgentPluginMcpConfig } from "./types.js";

/** How one stdio server's declared command is resolved when it is launched. */
export interface McpServerCommand {
  /** The server name, as declared in `mcp.json`. */
  server: string;
  command: string;
  /** Whether the package ships the command or the launcher looks it up on PATH. */
  resolution: "package" | "path-lookup";
}

/**
 * How each stdio server's declared command is resolved.
 *
 * Derived, never declared, and deliberately without a registry of "known"
 * runners. The loader admits exactly two command shapes: a `./` path contained
 * in the package, which the package itself supplies; and a bare executable
 * name, which is a PATH lookup on the consumer's machine.
 *
 * This makes no claim about interpreters, dynamic libraries, daemons, or other
 * transitive runtime dependencies. Remote servers have no command to report
 * because Hooknostic does not spawn them.
 */
export function mcpServerCommands(config: AgentPluginMcpConfig | undefined): McpServerCommand[] {
  if (config === undefined) return [];
  const entries: McpServerCommand[] = [];
  for (const [server, value] of Object.entries(config.mcpServers)) {
    if (value.type !== "stdio") continue;
    entries.push({
      server,
      command: value.command,
      resolution: value.command.startsWith("./") ? "package" : "path-lookup",
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
