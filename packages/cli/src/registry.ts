import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { claudeAdapter } from "@hooknostic/adapter-claude";
import { codexAdapter } from "@hooknostic/adapter-codex";
import { opencodeAdapter } from "@hooknostic/adapter-opencode";
import { piAdapter } from "@hooknostic/adapter-pi";
import type { AdapterRegistry, HarnessAdapter } from "@hooknostic/core";

/**
 * The published CLI ships each adapter's runtime shim prebundled next to this
 * module (`dist/shims/<id>.mjs`, see scripts/bundle.mjs) because the adapter
 * packages themselves are not published. When that file exists, route the
 * adapter's shim specifier to it; in the monorepo (running from src/) the
 * adapter resolves its own shim source through the workspace.
 */
function withShippedShim(adapter: HarnessAdapter): HarnessAdapter {
  const shipped = fileURLToPath(new URL(`./shims/${adapter.id}.mjs`, import.meta.url));
  if (!existsSync(shipped)) return adapter;
  return {
    ...adapter,
    ...(adapter.resolveTarget
      ? {
          resolveTarget: (target: Parameters<NonNullable<HarnessAdapter["resolveTarget"]>>[0]) => {
            const result = adapter.resolveTarget!(target);
            return { ...result, ...(result.adapter ? { adapter: withShippedShim(result.adapter) } : {}) };
          },
        }
      : {}),
    shimAliases: () => ({
      ...adapter.shimAliases?.(),
      [`@hooknostic/adapter-${adapter.id}/shim`]: shipped,
    }),
  };
}

/**
 * The adapters bundled with the CLI; target ids in hooknostic.config.ts key
 * into this registry.
 */
export function defaultAdapterRegistry(): AdapterRegistry {
  return {
    claude: withShippedShim(claudeAdapter()),
    codex: withShippedShim(codexAdapter()),
    opencode: withShippedShim(opencodeAdapter()),
    pi: withShippedShim(piAdapter()),
  };
}
