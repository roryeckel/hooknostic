import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { npmManifestCoordinate, npmPublicationProblems } from "@hooknostic/agent-plugin";
import type {
  DetectionResult,
  GeneratedArtifact,
  HarnessAdapter,
  McpIdentitySupport,
  PluginIR,
  RuntimeBundle,
  TargetSpec,
} from "@hooknostic/core";
import { detectCommandVersion, mcpIdentityApplies, resolveCapabilityMatrix } from "@hooknostic/core";
import type { CapabilityLevels } from "@hooknostic/runtime";
import type { RuntimePolicy, SupportLevel } from "@hooknostic/sdk";

import { applyPi } from "./apply.js";
import { decodePi } from "./decode.js";
import { generatePiArtifacts, PACKAGE_MANIFEST_PATH, piHookRuntimePath } from "./generate.js";
import { piHarness } from "./harness.js";
import { PI_RANGE, piCapabilityProfiles } from "./profile.js";
import { projectComponentProfiles, projectComponents, projectIntegration } from "./project.js";
import { piAgentPluginProjector } from "./project-agent-plugin.js";
import { piSkillPolicy } from "./skill-policy.js";
import { classifyPiTool, PI_FILE_SHAPES, PI_SHELL_SHAPES, piFileCodec, piShellCodec } from "./toolmap.js";
import { validatePiEffect } from "./validate.js";

export { piHarness } from "./harness.js";
export { piCapabilityProfiles } from "./profile.js";
export { piAgentPluginProjector } from "./project-agent-plugin.js";
export { projectComponents, projectComponentProfiles, projectIntegration } from "./project.js";
export { applyPi, planPiApplication, serializePiOutput } from "./apply.js";
export type { PiApplication } from "./apply.js";
export { PiDecodeError, decodePi } from "./decode.js";
export type { PiDecodeOptions, PiEnrichment, PiNativeEvent } from "./decode.js";
export { generatePiArtifacts, piHookRuntimePath } from "./generate.js";
export { createHooknosticExtension } from "./shim.js";
export type { PiExtensionApi, PiShimOptions } from "./shim.js";
export { classifyPiTool, piShellCodec, PI_SHELL_SHAPES, piFileCodec, PI_FILE_SHAPES } from "./toolmap.js";

/**
 * Where a pi MCP tool's server and tool come from (ADR-0032). Its range is the
 * one line whose native MCP channel both makes `mcp__` tools MCP calls and
 * states their split: `piNativeMcp` reads it, so the shim and `classifyTool`
 * apply the split exactly where inspect, dispatch, and the contract suite say
 * pi states it.
 */
export const piMcpIdentity: McpIdentitySupport = {
  source: "statement",
  events: ["tool.after", "tool.error"],
  // pi 0.84 has no native MCP channel. Captured on 1.3.0; 1.0.0 to 1.2.0
  // build the same details (schema-derived, profile.ts).
  range: PI_RANGE,
  rationale:
    "pi names MCP tools mcp__<server>__<tool> but sanitizes every non-identifier character and hashes a long or " +
    "colliding name, so the split is never parsed from it. The result of a tool pi's MCP extension registered states " +
    "the server and tool in its details, as pi registered them, including a server's error result; a JSON-RPC failure " +
    "leaves details empty, so that tool.error carries kind mcp without the split, and a tool_call states nothing, so " +
    "tool.before never has it. Another extension can register an mcp__ name, even a native tool's, and its details " +
    "are its own: the generated extension reads each result's tool source from pi.getAllTools() and takes the split " +
    `only from builtin:mcp. Outside ${PI_RANGE} an mcp__ tool is another extension's and classifies as other.`,
  evidence: ".capture/pi-mcp/README.md",
};

/**
 * Whether a target range (or one build) is within pi's 1.x line, whose native
 * MCP channel makes `mcp__` tools MCP calls (ADR-0032). The generated shim and
 * `classifyTool` both decide by it, so dispatch builds what the shim decodes.
 */
export function piNativeMcp(range: string): boolean {
  return mcpIdentityApplies(piMcpIdentity, range);
}

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
  nativeMcp?: boolean;
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
    // Only a target outside the 1.x line states it; the shim defaults to 1.x.
    ...(options.nativeMcp === false ? [`  nativeMcp: false,`] : []),
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
    adapterVersion: "0.9.0", // kept equal to package.json by versions.test.ts
    harness: piHarness,
    projectPaths: [".pi/extensions", ".pi/skills"],
    projectIntegration,
    projectComponents,
    projectComponentProfiles,
    skillInvocationPolicy: {
      destination: ".pi/skills",
      discoveryDirectories: [".agents/skills"],
      projectFiles: piSkillPolicy,
    },
    agentPluginProjector: piAgentPluginProjector,
    // pi imports the extension module in-process.
    shimExecution: "module",

    hookRuntimePath(delivery) {
      return piHookRuntimePath(delivery);
    },

    shellCodec: piShellCodec,
    shellShapes: PI_SHELL_SHAPES,
    fileCodec: piFileCodec,
    fileShapes: PI_FILE_SHAPES,
    classifyTool: (nativeName, input, reported, range) =>
      classifyPiTool(nativeName, input, reported, range === undefined || piNativeMcp(range)),
    shellDialect: {
      source: "tool",
      rationale:
        "powershell runs Windows PowerShell or pwsh, both in the powershell family. bash remains unknown: " +
        "the same command input ran Bash, PowerShell, dash, zsh, fish and tcsh through shellPath, " +
        "and Pi's tool description and prompt snippet do not state the selected interpreter.",
      evidence: ".capture/pi/FEATURES.md",
    },
    mcpIdentity: piMcpIdentity,

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
      const { targetRange, ...entry } = options;
      return piShimEntrySource({
        ...entry,
        ...(targetRange === undefined ? {} : { nativeMcp: piNativeMcp(targetRange) }),
      });
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
      validateEffect: validatePiEffect,
    },
  };
}
