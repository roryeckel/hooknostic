import type { AdapterRegistry } from "@hooknostic/core";
import { claudeAdapter } from "@hooknostic/adapter-claude";
import { codexAdapter } from "@hooknostic/adapter-codex";
import { opencodeAdapter } from "@hooknostic/adapter-opencode";

/**
 * The adapters bundled with the CLI; target ids in hooknostic.config.ts key
 * into this registry.
 */
export function defaultAdapterRegistry(): AdapterRegistry {
  return {
    claude: claudeAdapter(),
    codex: codexAdapter(),
    opencode: opencodeAdapter(),
  };
}
