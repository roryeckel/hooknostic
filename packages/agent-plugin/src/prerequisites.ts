import type { AgentPluginMcpConfig } from "./types.js";

/** What one stdio server needs from the machine it is finally launched on. */
export interface McpServerPrerequisites {
  /** The server name, as declared in `mcp.json`. */
  server: string;
  command: string;
  /** The command is a file the package ships, so nothing is resolved on PATH. */
  contained: boolean;
  /** Bare executables that must resolve on the consumer's PATH. */
  requires: readonly string[];
}

/**
 * What each stdio server needs from the consumer's machine.
 *
 * Derived, never declared, and deliberately without a registry of "known"
 * runners. The loader admits exactly two command shapes: a `./` path contained
 * in the package, which the package itself supplies; and a bare executable
 * name, which is a PATH lookup on the consumer's machine. That is the whole
 * classification, and it is the same answer for `node`, `python3`, `uvx`,
 * `docker` and `php` -- which is the point. A blessed list would be wrong the
 * first time somebody shipped a server this project had not heard of.
 *
 * Remote servers have no prerequisite to report: nothing is spawned.
 *
 * The Node that runs the generated launcher is not included. It is a property
 * of the projection rather than the package -- every target adds it, and the
 * adapters already say so in their own rationales.
 */
export function mcpPrerequisites(config: AgentPluginMcpConfig | undefined): McpServerPrerequisites[] {
  if (config === undefined) return [];
  const entries: McpServerPrerequisites[] = [];
  for (const [server, value] of Object.entries(config.mcpServers)) {
    if (value.type !== "stdio") continue;
    const contained = value.command.startsWith("./");
    entries.push({
      server,
      command: value.command,
      contained,
      requires: contained ? [] : [value.command],
    });
  }
  return entries.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
}

/** Every distinct executable a package's servers look up on PATH, sorted. */
export function mcpRequiredCommands(entries: readonly McpServerPrerequisites[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.requires))].sort();
}
