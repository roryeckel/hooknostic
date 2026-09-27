import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { npmManifestCoordinate, npmPublicationProblems } from "@hooknostic/agent-plugin";
import type {
  DetectionResult,
  GeneratedArtifact,
  HarnessAdapter,
  PluginIR,
  RuntimeBundle,
  TargetSpec,
} from "@hooknostic/core";
import { detectCommandVersion, resolveCapabilityMatrix } from "@hooknostic/core";
import type { CapabilityLevels } from "@hooknostic/runtime";
import type { RuntimePolicy, SupportLevel } from "@hooknostic/sdk";

import { applyPi } from "./apply.js";
import { decodePi } from "./decode.js";
import { generatePiArtifacts, PACKAGE_MANIFEST_PATH, piHookRuntimePath } from "./generate.js";
import { piHarness } from "./harness.js";
import { piCapabilityProfiles } from "./profile.js";
import { projectComponentProfiles, projectComponents, projectIntegration } from "./project.js";
import { piAgentPluginProjector } from "./project-agent-plugin.js";
import { classifyPiTool, PI_SHELL_SHAPES, piShellCodec } from "./toolmap.js";

export { piHarness } from "./harness.js";
export { piCapabilityProfiles } from "./profile.js";
export { piAgentPluginProjector } from "./project-agent-plugin.js";
export { projectComponents, projectComponentProfiles, projectIntegration } from "./project.js";
export { applyPi, planPiApplication, serializePiOutput } from "./apply.js";
export type { PiApplication } from "./apply.js";
export { PiDecodeError, decodePi } from "./decode.js";
export type { PiNativeEvent } from "./decode.js";
export { generatePiArtifacts, piHookRuntimePath } from "./generate.js";
export { createHooknosticExtension } from "./shim.js";
export type { PiExtensionApi, PiShimOptions } from "./shim.js";
export { classifyPiTool, piShellCodec, PI_SHELL_SHAPES } from "./toolmap.js";

function resolveShimPath(): string {
  try {
    return createRequire(import.meta.url).resolve("@hooknostic/adapter-pi/shim");
  } catch {
    return fileURLToPath(new URL("./shim.ts", import.meta.url));
  }
}

/**
 * Shim entry source for the generated `.pi/extensions/hooknostic.js`.
 * The module's default export is the extension factory pi calls with the
 * ExtensionAPI.
 */
export function piShimEntrySource(options: {
  targetId?: string;
  entryImportPath: string;
  capabilities: CapabilityLevels;
  policy: RuntimePolicy;
  minimumCapabilityLevel?: SupportLevel;
  harnessVersion?: string;
  pluginRootOffset?: string;
}): string {
  return [
    `import plugin from ${JSON.stringify(options.entryImportPath)};`,
    `import { createHooknosticExtension${options.pluginRootOffset !== undefined ? ", pluginRootFrom" : ""} } from "@hooknostic/adapter-pi/shim";`,
    `const extension = createHooknosticExtension(plugin, {`,
    `  targetId: ${JSON.stringify(options.targetId ?? "pi")},`,
    `  capabilities: ${JSON.stringify(options.capabilities)},`,
    ...(options.minimumCapabilityLevel !== undefined
      ? [`  minimumCapabilityLevel: ${JSON.stringify(options.minimumCapabilityLevel)},`]
      : []),
    `  policy: ${JSON.stringify(options.policy)},`,
    ...(options.harnessVersion !== undefined ? [`  harnessVersion: ${JSON.stringify(options.harnessVersion)},`] : []),
    // Resolved from the artifact's own location (ADR-0020): the offset is fixed
    // by where this adapter places the runtime relative to the package root.
    ...(options.pluginRootOffset !== undefined
      ? [`  pluginRoot: pluginRootFrom(import.meta.url, ${JSON.stringify(options.pluginRootOffset)}),`]
      : []),
    `});`,
    `export default extension;`,
    "",
  ].join("\n");
}

export function piAdapter(): HarnessAdapter {
  return {
    id: "pi",
    adapterVersion: "0.1.0", // kept equal to package.json by versions.test.ts
    harness: piHarness,
    projectPaths: [".pi/extensions", ".pi/skills"],
    projectIntegration,
    projectComponents,
    projectComponentProfiles,
    agentPluginProjector: piAgentPluginProjector,
    // pi imports the extension module in-process.
    shimExecution: "module",

    hookRuntimePath(delivery) {
      return piHookRuntimePath(delivery);
    },

    shellCodec: piShellCodec,
    shellShapes: PI_SHELL_SHAPES,
    classifyTool: classifyPiTool,

    supportedHarnessVersions() {
      return piCapabilityProfiles.map((p) => p.range);
    },

    supportedDeliveries() {
      return ["project", "package"] as const;
    },

    // Package delivery emits a pi package: a `pi` manifest field declaring the
    // extension, publishable under the target's npm coordinate.
    publishesNpmPackage: true,

    shimEntry(options) {
      return piShimEntrySource(options);
    },

    shimAliases() {
      return { "@hooknostic/adapter-pi/shim": resolveShimPath() };
    },

    capabilities(target: TargetSpec) {
      return resolveCapabilityMatrix("pi", piCapabilityProfiles, target.version);
    },

    async detect(): Promise<DetectionResult> {
      return detectCommandVersion("pi", {
        notFoundDetail: "pi CLI not found on PATH",
      });
    },

    async compile(plugin: PluginIR, target: TargetSpec, bundle: RuntimeBundle): Promise<GeneratedArtifact[]> {
      return generatePiArtifacts(plugin, target, bundle);
    },

    async validateArtifacts(artifacts, target) {
      const diagnostics = [];
      const read = (path: string): string | undefined => {
        const artifact = artifacts.find((candidate) => candidate.path === path);
        return artifact?.contents === undefined
          ? undefined
          : typeof artifact.contents === "string"
            ? artifact.contents
            : Buffer.from(artifact.contents).toString("utf8");
      };
      const isPackage = target.delivery === "package";
      const extensionText = read(piHookRuntimePath(target.delivery));
      if (extensionText !== undefined && !extensionText.includes("createHooknosticExtension")) {
        diagnostics.push({
          code: "HN301" as const,
          severity: "error" as const,
          target: target.id,
          message: "generated extension module does not build the hooknostic extension.",
        });
      }
      if (isPackage) {
        const manifestText = read(PACKAGE_MANIFEST_PATH);
        if (manifestText === undefined) {
          diagnostics.push({
            code: "HN301" as const,
            severity: "error" as const,
            target: target.id,
            message: `package delivery emitted no ${PACKAGE_MANIFEST_PATH}; pi would discover no resources in the package.`,
          });
        } else if (!artifacts.some((artifact) => artifact.path === "hooknostic-agent-plugin.js")) {
          // Hooks-only packages, and only those. The Agent Plugin projector
          // takes the manifest it constructs through the same checks while
          // building its plan, so reporting a projected package here would
          // double every finding it already made. This path has no projector:
          // the name comes from the plugin IR or the target's npm coordinate,
          // and a name npm refuses produces a directory that cannot be packed
          // or published.
          const coordinate = npmManifestCoordinate(manifestText);
          if (!coordinate.ok) {
            diagnostics.push({
              code: "HN301" as const,
              severity: "error" as const,
              target: target.id,
              message: `package delivery emits an npm package, and ${PACKAGE_MANIFEST_PATH} ${coordinate.error}, so npm cannot pack or publish it.`,
            });
          } else {
            for (const problem of npmPublicationProblems({
              name: coordinate.name,
              version: coordinate.version,
              npmNameDeclared: target.npmName !== undefined,
            })) {
              diagnostics.push({
                code: "HN301" as const,
                severity: problem.severity,
                target: target.id,
                message: problem.message,
              });
            }
          }
        }
      }
      return diagnostics;
    },

    runtime: {
      async decode(nativeEvent, invocation) {
        return decodePi(nativeEvent, invocation);
      },
      apply: applyPi,
    },
  };
}
