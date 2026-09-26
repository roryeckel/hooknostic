import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { contentsText, npmManifestCoordinate, npmPublicationProblems } from "@hooknostic/agent-plugin";
import type {
  DetectionResult,
  GeneratedArtifact,
  HarnessAdapter,
  PluginIR,
  RuntimeBundle,
  TargetSpec,
} from "@hooknostic/core";
import { detectCommandVersion, isRangeFullyCovered, resolveCapabilityMatrix } from "@hooknostic/core";
import type { CapabilityLevels } from "@hooknostic/runtime";
import type { RuntimePolicy, SupportLevel } from "@hooknostic/sdk";

import { applyOpenCode } from "./apply.js";
import { decodeOpenCode } from "./decode.js";
import {
  generateOpenCodeArtifacts,
  opencodeHookRuntimePath,
  PACKAGE_COMPONENTS_PATH,
  PACKAGE_ENTRY_PATH,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_PLUGIN_PATH,
} from "./generate.js";
import { opencodeHarness } from "./harness.js";
import { opencodeCapabilityProfiles } from "./profile.js";
import { projectComponentProfiles, projectComponents, projectIntegration } from "./project.js";
import { opencodeAgentPluginProjector } from "./project-agent-plugin.js";
import { classifyOpenCodeTool, OPENCODE_SHELL_SHAPES, opencodeShellCodec } from "./toolmap.js";
import { opencodeV2Harness } from "./v2/harness.js";
import { opencodeV2Adapter } from "./v2/index.js";
export { opencodeV2Harness } from "./v2/harness.js";
export { opencodeV2CapabilityProfiles } from "./v2/profile.js";
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
  pluginRootOffset?: string;
}): string {
  return [
    `import plugin from ${JSON.stringify(options.entryImportPath)};`,
    `import { createHooknosticHooks${options.pluginRootOffset !== undefined ? ", pluginRootFrom" : ""} } from "@hooknostic/adapter-opencode/shim";`,
    `export const HooknosticPlugin = async (input) =>`,
    `  createHooknosticHooks(plugin, {`,
    `    targetId: ${JSON.stringify(options.targetId ?? "opencode")},`,
    `    capabilities: ${JSON.stringify(options.capabilities)},`,
    ...(options.minimumCapabilityLevel !== undefined
      ? [`    minimumCapabilityLevel: ${JSON.stringify(options.minimumCapabilityLevel)},`]
      : []),
    `    policy: ${JSON.stringify(options.policy)},`,
    ...(options.harnessVersion !== undefined ? [`    harnessVersion: ${JSON.stringify(options.harnessVersion)},`] : []),
    // Resolved from the artifact's own location (ADR-0020): the offset is fixed
    // by where this adapter places the runtime relative to the package root.
    ...(options.pluginRootOffset !== undefined
      ? [`    pluginRoot: pluginRootFrom(import.meta.url, ${JSON.stringify(options.pluginRootOffset)}),`]
      : []),
    `  }, input);`,
    `export default HooknosticPlugin;`,
    "",
  ].join("\n");
}

export function opencodeV1Adapter(): HarnessAdapter {
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

    hookRuntimePath(delivery) {
      return opencodeHookRuntimePath(delivery);
    },

    shellCodec: opencodeShellCodec,
    shellShapes: OPENCODE_SHELL_SHAPES,
    classifyTool: classifyOpenCodeTool,

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
        return contentsText(artifact.contents);
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
          // The tiers and their wording live with the helper, so this path and
          // the projector cannot disagree about what npm would refuse -- and
          // the manifest is read the way core reads it to confirm an npmName.
          const coordinate = npmManifestCoordinate(manifestText);
          if (!coordinate.ok) {
            // One finding about the file, not two about the fields it does not
            // have: npm never gets as far as the name of a manifest it cannot
            // parse, and neither should the author.
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
        return decodeOpenCode(nativeEvent, invocation);
      },
      apply: applyOpenCode,
    },
  };
}

export function opencodeAdapter(): HarnessAdapter {
  const v1 = opencodeV1Adapter();
  const v2 = opencodeV2Adapter(
    () => ({ "@hooknostic/adapter-opencode/shim": resolveShimPath() }),
    v1.validateArtifacts!,
  );
  const families = [v1, v2];
  const resolveTarget: NonNullable<HarnessAdapter["resolveTarget"]> = (target) => {
    let adapter: HarnessAdapter | undefined;
    try {
      adapter = families.find((family) => isRangeFullyCovered(target.version, family.supportedHarnessVersions()));
    } catch {
      /* Invalid semver is reported through the same HN203 result. */
    }
    return adapter
      ? { adapter, diagnostics: [] }
      : {
          diagnostics: [
            {
              code: "HN203",
              severity: "error",
              target: target.id,
              message: `OpenCode target range "${target.version}" must be covered by exactly one supported family.`,
              remediation:
                "Use a supported v1 or v2 range. To build both, configure two named targets with adapter: opencode and distinct output directories.",
            },
          ],
        };
  };
  return {
    ...v2,
    harnessFamilies: [v1.harness, opencodeV2Harness],
    resolveTarget,
    supportedHarnessVersions: () => families.flatMap((f) => f.supportedHarnessVersions()),
    capabilities(target) {
      const selected = resolveTarget(target);
      return selected.adapter?.capabilities(target) ?? { profilesUsed: [], diagnostics: selected.diagnostics };
    },
  };
}
