// Aliased: every runtime bundle carries this module, and a bare `resolve`
// binding here would force esbuild to rename same-named locals across the shim.
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath as urlToPath } from "node:url";

/**
 * The Agent Plugin root, found from the executing runtime artifact's own
 * location (ADR-0020).
 *
 * `moduleUrl` is the generated entry's `import.meta.url` -- after bundling,
 * the runtime artifact itself -- and `offset` is the POSIX path from that
 * file's directory to the package root, fixed at build time by the adapter
 * that placed both. This is the derivation the self-resolving MCP launcher
 * uses, so a hook and a server in one package agree on the root without
 * either consulting the harness.
 */
export function pluginRootFrom(moduleUrl: string, offset: string): string {
  return pathResolve(pathDirname(urlToPath(moduleUrl)), offset);
}
