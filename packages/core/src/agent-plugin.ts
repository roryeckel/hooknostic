import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "./diagnostics.js";

export interface AgentPluginMetadata {
  name?: string;
  version?: string;
  description?: string;
}

/**
 * Read reusable metadata from an Agent Plugins 1.0 `plugin.json` when one is
 * present (ADR-0004). Hooknostic consumes the manifest — it never mutates it
 * and never adds root-level fields. Per spec §5.2, unknown top-level fields
 * are reported and ignored, not fatal.
 */
export async function readAgentPluginMetadata(
  root: string,
): Promise<{ metadata?: AgentPluginMetadata; present: boolean; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const manifestPath = join(root, "plugin.json");

  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    // Standalone mode is first-class: no plugin.json is not an error.
    return { present: false, diagnostics };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    diagnostics.push({
      code: "HN501",
      severity: "error",
      message: `agentPlugin.root points at an invalid plugin.json: ${error instanceof Error ? error.message : String(error)}`,
      location: { file: manifestPath },
    });
    return { present: true, diagnostics };
  }

  if (typeof parsed !== "object" || parsed === null) {
    diagnostics.push({
      code: "HN501",
      severity: "error",
      message: "plugin.json must be a JSON object.",
      location: { file: manifestPath },
    });
    return { present: true, diagnostics };
  }

  const manifest = parsed as Record<string, unknown>;
  const KNOWN = new Set([
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ]);
  for (const key of Object.keys(manifest)) {
    if (!KNOWN.has(key)) {
      diagnostics.push({
        code: "HN501",
        severity: "info",
        message: `plugin.json contains unknown top-level field "${key}" (reported and ignored per Agent Plugins 1.0 §5.2).`,
        location: { file: manifestPath },
      });
    }
  }

  const metadata: AgentPluginMetadata = {};
  if (typeof manifest["name"] === "string") metadata.name = manifest["name"];
  if (typeof manifest["version"] === "string") metadata.version = manifest["version"];
  if (typeof manifest["description"] === "string") {
    metadata.description = manifest["description"];
  }
  return { metadata, present: true, diagnostics };
}

/**
 * Agent Plugins client-extension namespaces Hooknostic can emit into. Only
 * Claude Code's is generated in v0.1: Codex 0.148 does not load plugin hooks
 * at all (plugin_hooks removed), and OpenCode has no published reverse-DNS
 * namespace convention yet.
 */
export const AGENT_PLUGIN_NAMESPACES = {
  claude: "com.anthropic.claude-code",
} as const;
