import type { GeneratedArtifact, PluginIR, RuntimeBundle, TargetSpec } from "@hooknostic/core";

// pi's loader scans `*.ts` / `*.js` only in `.pi/extensions/` (and one level
// of subdirectories) — a `.mjs` module is not discovered (loader.js source,
// 0.84.4). The bundled runtime is plain ESM JavaScript emitted as `.js`.
const PROJECT_EXTENSION_PATH = ".pi/extensions/hooknostic.js";

/**
 * Package delivery puts the extension module at the package root, declared
 * via the `pi` manifest's `extensions` field. Nothing scans a package's
 * interior beyond what the manifest names.
 */
export const PACKAGE_EXTENSION_PATH = "hooknostic.js";

/** Where the hook runtime lands for a delivery; `generatePiArtifacts` picks the same way. */
export function piHookRuntimePath(delivery: TargetSpec["delivery"]): string {
  return delivery === "package" ? PACKAGE_EXTENSION_PATH : PROJECT_EXTENSION_PATH;
}

export const PACKAGE_MANIFEST_PATH = "package.json";

/**
 * The npm-style manifest for a hooks-only pi package. pi's package reader
 * (`readPiManifest`) only looks at the `pi` field for resource declarations;
 * `name`/`version` are conventional npm identity. A package target whose
 * projector runs (Agent Plugin components) replaces this file.
 */
export function hooksOnlyManifest(plugin: PluginIR, npmName?: string): string {
  const document = {
    name: npmName ?? plugin.name,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
    ...(plugin.description === undefined ? {} : { description: plugin.description }),
    type: "module" as const,
    pi: {
      extensions: [`./${PACKAGE_EXTENSION_PATH}`],
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Generate the pi hook artifacts.
 *
 * Project delivery writes a module into `.pi/extensions/`, which pi scans.
 * Package delivery emits a pi package on its own — manifest included —
 * because the Agent Plugin projector runs only when the config declares
 * `components.root`. When it does run it owns the manifest, adding skills to
 * the `pi` declaration alongside the extension.
 */
export function generatePiArtifacts(plugin: PluginIR, target: TargetSpec, bundle: RuntimeBundle): GeneratedArtifact[] {
  if (target.delivery !== "package") return [{ path: PROJECT_EXTENSION_PATH, contents: bundle.code }];
  return [
    { path: PACKAGE_EXTENSION_PATH, contents: bundle.code },
    { path: PACKAGE_MANIFEST_PATH, contents: hooksOnlyManifest(plugin, target.npmName) },
  ];
}
