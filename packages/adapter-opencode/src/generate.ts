import type { GeneratedArtifact, PluginIR, RuntimeBundle, TargetSpec } from "@hooknostic/core";

// The 1.18 loader scans `*.ts` / `*.js` only — a `.mjs` module is ignored.
const PLUGIN_PATH = ".opencode/plugins/hooknostic.js";

/**
 * Generate the OpenCode local-plugin artifact: a bundled JS module under
 * `.opencode/plugins/` copied into the target project. npm-package output
 * mode is deferred past v0.1.
 */
export function generateOpenCodeArtifacts(
  _plugin: PluginIR,
  _target: TargetSpec,
  bundle: RuntimeBundle,
): GeneratedArtifact[] {
  return [{ path: PLUGIN_PATH, contents: bundle.code }];
}
