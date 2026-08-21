import type { AdapterRegistry } from "@hooknostic/core";

/**
 * The adapters bundled with the CLI. Populated as native adapters land
 * (claude, codex, opencode); target ids in hooknostic.config.ts key into
 * this registry.
 */
export function defaultAdapterRegistry(): AdapterRegistry {
  return {};
}
