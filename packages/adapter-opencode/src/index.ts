import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  packageNameProblem,
  packageVersionProblem,
  publishablePackageNameProblem,
  UNPUBLISHABLE_STILL_LOADS,
} from "@hooknostic/agent-plugin";
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

import { applyOpenCode } from "./apply.js";
import { decodeOpenCode } from "./decode.js";
import {
  generateOpenCodeArtifacts,
  PACKAGE_COMPONENTS_PATH,
  PACKAGE_ENTRY_PATH,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_PLUGIN_PATH,
} from "./generate.js";
import { opencodeHarness } from "./harness.js";
import { opencodeCapabilityProfiles } from "./profile.js";
import { projectComponentProfiles, projectComponents, projectIntegration } from "./project.js";
import { opencodeAgentPluginProjector } from "./project-agent-plugin.js";
import { OPENCODE_SHELL_SHAPES, opencodeShellCodec } from "./toolmap.js";
export { opencodeHarness } from "./harness.js";

export { applyOpenCode, planOpenCodeApplication, serializeOpenCodeOutput } from "./apply.js";
export type { OpenCodeApplication } from "./apply.js";
export { OpenCodeDecodeError, decodeOpenCode } from "./decode.js";
export type { OpenCodeNativeEvent } from "./decode.js";
export { generateOpenCodeArtifacts } from "./generate.js";
export { opencodeAgentPluginProjector } from "./project-agent-plugin.js";
export { opencodeCapabilityProfiles } from "./profile.js";
export { createHooknosticHooks } from "./shim.js";
export type { OpenCodePluginInput, OpenCodeShimOptions } from "./shim.js";
export { classifyOpenCodeTool, opencodeShellCodec, OPENCODE_SHELL_SHAPES } from "./toolmap.js";

function resolveShimPath(): string {
  try {
    return createRequire(import.meta.url).resolve("@hooknostic/adapter-opencode/shim");
  } catch {
    return fileURLToPath(new URL("./shim.ts", import.meta.url));
  }
}

/**
 * Shim entry source for the generated `.opencode/plugins/hooknostic.js`.
 * The module's exported Plugin function is what OpenCode loads in-process.
 */
export function opencodeShimEntrySource(options: {
  targetId?: string;
  entryImportPath: string;
  capabilities: CapabilityLevels;
  policy: RuntimePolicy;
  minimumCapabilityLevel?: SupportLevel;
  harnessVersion?: string;
}): string {
  return [
    `import plugin from ${JSON.stringify(options.entryImportPath)};`,
    `import { createHooknosticHooks } from "@hooknostic/adapter-opencode/shim";`,
    `export const HooknosticPlugin = async (input) =>`,
    `  createHooknosticHooks(plugin, {`,
    `    targetId: ${JSON.stringify(options.targetId ?? "opencode")},`,
    `    capabilities: ${JSON.stringify(options.capabilities)},`,
    ...(options.minimumCapabilityLevel !== undefined
      ? [`    minimumCapabilityLevel: ${JSON.stringify(options.minimumCapabilityLevel)},`]
      : []),
    `    policy: ${JSON.stringify(options.policy)},`,
    ...(options.harnessVersion !== undefined ? [`    harnessVersion: ${JSON.stringify(options.harnessVersion)},`] : []),
    `  }, input);`,
    `export default HooknosticPlugin;`,
    "",
  ].join("\n");
}

export function opencodeAdapter(): HarnessAdapter {
  return {
    id: "opencode",
    adapterVersion: "0.1.0", // kept equal to package.json by versions.test.ts
    harness: opencodeHarness,
    projectPaths: [".opencode/plugins", ".agents/skills", "opencode.json", "opencode.jsonc"],
    projectIntegration,
    projectComponents,
    projectComponentProfiles,
    projectMcpOptions: { startupTimeoutMs: true },
    agentPluginProjector: opencodeAgentPluginProjector,
    // OpenCode imports the plugin module in-process.
    shimExecution: "module",
    shellCodec: opencodeShellCodec,
    shellShapes: OPENCODE_SHELL_SHAPES,

    supportedHarnessVersions() {
      return opencodeCapabilityProfiles.map((p) => p.range);
    },

    supportedDeliveries() {
      return ["project", "package"] as const;
    },

    // Package delivery emits an npm package: a manifest, an entry, and the
    // hook module beside it, publishable under the target's coordinate.
    publishesNpmPackage: true,

    shimEntry(options) {
      return opencodeShimEntrySource(options);
    },

    shimAliases() {
      return { "@hooknostic/adapter-opencode/shim": resolveShimPath() };
    },

    capabilities(target: TargetSpec) {
      return resolveCapabilityMatrix("opencode", opencodeCapabilityProfiles, target.version);
    },

    async detect(): Promise<DetectionResult> {
      return detectCommandVersion("opencode", {
        notFoundDetail: "opencode CLI not found on PATH",
      });
    },

    async compile(plugin: PluginIR, target: TargetSpec, bundle: RuntimeBundle): Promise<GeneratedArtifact[]> {
      return generateOpenCodeArtifacts(plugin, target, bundle);
    },

    async validateArtifacts(artifacts, target) {
      const diagnostics = [];
      const read = (path: string): string | undefined => {
        const artifact = artifacts.find((candidate) => candidate.path === path);
        if (artifact === undefined) return undefined;
        return typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
      };
      // Package delivery moves the hook module to the package root. Validating
      // the project path unconditionally would silently pass every package.
      const isPackage = target.delivery === "package";
      const modulePath = isPackage ? PACKAGE_PLUGIN_PATH : ".opencode/plugins/hooknostic.js";
      const moduleText = read(modulePath);
      if (moduleText !== undefined && !moduleText.includes("HooknosticPlugin")) {
        diagnostics.push({
          code: "HN301" as const,
          severity: "error" as const,
          target: target.id,
          message: "generated plugin module does not export HooknosticPlugin.",
        });
      }
      if (isPackage) {
        const entry = read(PACKAGE_ENTRY_PATH);
        if (entry === undefined) {
          diagnostics.push({
            code: "HN301" as const,
            severity: "error" as const,
            target: target.id,
            message: `package delivery emitted no ${PACKAGE_ENTRY_PATH}; OpenCode would have no module to load.`,
          });
        } else if (entry.includes(`./${PACKAGE_PLUGIN_PATH}`) && moduleText === undefined) {
          // A config may declare components without an entry, in which case no
          // hook module is generated. An import of a module the output does not
          // contain fails the WHOLE plugin at load, taking the package's skills
          // and MCP servers down with a hook module nobody asked for.
          diagnostics.push({
            code: "HN301" as const,
            severity: "error" as const,
            target: target.id,
            message: `${PACKAGE_ENTRY_PATH} re-exports ${PACKAGE_PLUGIN_PATH}, which the output does not contain.`,
          });
        }
        const manifestText = read(PACKAGE_MANIFEST_PATH);
        if (manifestText === undefined) {
          diagnostics.push({
            code: "HN301" as const,
            severity: "error" as const,
            target: target.id,
            message: `package delivery emitted no ${PACKAGE_MANIFEST_PATH}; the output is not a loadable package.`,
          });
        } else if (!artifacts.some((artifact) => artifact.path === PACKAGE_COMPONENTS_PATH)) {
          // Hooks-only packages, and only those. The Agent Plugin projector
          // takes the manifest it constructs through the same two checks while
          // building its plan, so reporting a projected package here would
          // double every finding it already made -- and a projected warning
          // does not stop the build, so both would reach the author. This path
          // has no projector: the name comes from `PluginSpec.name`, which is
          // only `string().min(1)`, or from the target's npm coordinate, and a
          // name npm refuses produces a directory that cannot be packed or
          // published.
          let name: unknown;
          let version: unknown;
          try {
            const manifest = JSON.parse(manifestText) as { name?: unknown; version?: unknown };
            name = manifest.name;
            version = manifest.version;
          } catch {
            name = undefined;
            version = undefined;
          }
          const problem = typeof name === "string" ? publishablePackageNameProblem(name) : "manifest declares no name";
          if (problem !== undefined) {
            // The same two tiers, and the same exception, the projected path
            // applies: npm refusing to install the name at all is fatal, npm
            // refusing to publish it costs publication only -- except when the
            // name came from an explicit `npmName`, which exists for no purpose
            // other than publishing, so a coordinate that cannot be published
            // is a defeated declaration rather than a survivable one.
            const publicationOnly =
              typeof name === "string" && packageNameProblem(name) === undefined && target.npmName === undefined;
            diagnostics.push({
              code: "HN301" as const,
              severity: publicationOnly ? ("warn" as const) : ("error" as const),
              target: target.id,
              message:
                // Which of the two declarations supplied it, because naming the
                // generated manifest would send the author to the wrong file.
                `package delivery emits an npm package, and ${
                  typeof name === "string" ? `${target.npmName === undefined ? "manifest name" : "npmName"} ` : ""
                }${JSON.stringify(name)} is not a valid npm package name: ${problem}.` +
                (publicationOnly ? ` ${UNPUBLISHABLE_STILL_LOADS}` : ""),
            });
          }
          const versionProblem =
            typeof version === "string" ? packageVersionProblem(version) : "the manifest declares no version";
          if (versionProblem !== undefined) {
            diagnostics.push({
              code: "HN301" as const,
              severity: "warn" as const,
              target: target.id,
              message: `package delivery emits an npm package and ${
                typeof version === "string"
                  ? `the manifest version ${JSON.stringify(version)} is ${versionProblem}`
                  : versionProblem
              }, so the result loads from a local path but cannot be published.`,
            });
          }
        }
      }
      return diagnostics;
    },

    runtime: {
      async decode(nativeEvent, invocation) {
        return decodeOpenCode(nativeEvent, invocation);
      },
      apply: applyOpenCode,
    },
  };
}
