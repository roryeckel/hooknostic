import type { HarnessAdapter, ShimEntryOptions } from "@hooknostic/core";
import { detectCommandVersion, resolveCapabilityMatrix } from "@hooknostic/core";

import { generateOpenCodeArtifacts, opencodeHookRuntimePath } from "../generate.js";
import { planOpenCodeV2Application } from "./apply.js";
import { decodeOpenCodeV2 } from "./decode.js";
import { opencodeV2Harness } from "./harness.js";
import { opencodeV2CapabilityProfiles } from "./profile.js";
import {
  opencodeV2Projector,
  opencodeV2ProjectProfiles,
  projectOpenCodeV2Components,
  projectOpenCodeV2Integration,
} from "./project.js";
import {
  classifyOpenCodeV2Tool,
  OPENCODE_V2_FILE_SHAPES,
  OPENCODE_V2_SHELL_SHAPES,
  opencodeV2FileCodec,
  opencodeV2ShellCodec,
} from "./toolmap.js";

export function opencodeV2ShimEntrySource(options: ShimEntryOptions): string {
  return [
    `import plugin from ${JSON.stringify(options.entryImportPath)};`,
    `import { setupOpenCodeV2${options.pluginRootOffset !== undefined ? ", pluginRootFrom" : ""} } from "@hooknostic/adapter-opencode/shim";`,
    `const options = ${JSON.stringify({ targetId: options.targetId, capabilities: options.capabilities, policy: options.policy, minimumCapabilityLevel: options.minimumCapabilityLevel, harnessVersion: options.harnessVersion })};`,
    ...(options.pluginRootOffset !== undefined
      ? [`options.pluginRoot = pluginRootFrom(import.meta.url, ${JSON.stringify(options.pluginRootOffset)});`]
      : []),
    `export const HooknosticPlugin = { id: "hooknostic." + plugin.name + ${JSON.stringify(`.${options.targetId ?? "opencode"}`)}, setup: ctx => setupOpenCodeV2(plugin, options, ctx) };`,
    "export default HooknosticPlugin;",
    "",
  ].join("\n");
}

export function opencodeV2Adapter(
  shimAliases: () => Record<string, string>,
  validateArtifacts: NonNullable<HarnessAdapter["validateArtifacts"]>,
): HarnessAdapter {
  return {
    id: "opencode",
    adapterVersion: "0.1.0",
    harness: opencodeV2Harness,
    projectPaths: [".opencode/plugins", ".agents/skills", "opencode.json", "opencode.jsonc"],
    projectIntegration: projectOpenCodeV2Integration,
    projectComponents: projectOpenCodeV2Components,
    projectComponentProfiles: opencodeV2ProjectProfiles,
    agentPluginProjector: opencodeV2Projector,
    projectMcpOptions: { startupTimeoutMs: true },
    shimExecution: "module",
    publishesNpmPackage: true,
    hookRuntimePath: opencodeHookRuntimePath,
    shimEntry: opencodeV2ShimEntrySource,
    shimAliases,
    validateArtifacts,
    shellCodec: opencodeV2ShellCodec,
    shellShapes: OPENCODE_V2_SHELL_SHAPES,
    fileCodec: opencodeV2FileCodec,
    fileShapes: OPENCODE_V2_FILE_SHAPES,
    classifyTool: classifyOpenCodeV2Tool,
    supportedHarnessVersions: () => opencodeV2CapabilityProfiles.map((p) => p.range),
    supportedDeliveries: () => ["project", "package"],
    capabilities: (target) => resolveCapabilityMatrix("opencode", opencodeV2CapabilityProfiles, target.version),
    detect: () => detectCommandVersion("opencode"),
    async compile(plugin, target, bundle) {
      const artifacts = generateOpenCodeArtifacts(plugin, target, bundle);
      const entry = artifacts.find((a) => a.path === "index.js");
      if (entry) entry.contents = 'export { default } from "./hooknostic.js";\n';
      return artifacts;
    },
    runtime: {
      decode: async (raw, invocation) => decodeOpenCodeV2(raw, invocation),
      apply: async (result) => ({ body: planOpenCodeV2Application(result) }),
    },
  };
}
