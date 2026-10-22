import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { contentsText, isJsonObject } from "@hooknostic/agent-plugin";
import type {
  DetectionResult,
  GeneratedArtifact,
  HarnessAdapter,
  McpIdentitySupport,
  PluginIR,
  RuntimeBundle,
  ShellDialectSupport,
  TargetSpec,
} from "@hooknostic/core";
import { detectCommandVersion, resolveCapabilityMatrix } from "@hooknostic/core";
import type { CapabilityLevels } from "@hooknostic/runtime";
import type { RuntimePolicy, SupportLevel } from "@hooknostic/sdk";

import { applyCopilot } from "./apply.js";
import { decodeCopilot } from "./decode.js";
import { copilotHookRuntimePath, copilotHooksPath, generateCopilotArtifacts } from "./generate.js";
import { copilotHarness } from "./harness.js";
import { copilotHookEntryProblem } from "./hook-entries.js";
import { copilotCapabilityProfiles } from "./profile.js";
import { projectComponentProfiles, projectComponents, projectIntegration } from "./project.js";
import { copilotAgentPluginProjector } from "./project-agent-plugin.js";
import { copilotSkillPolicy } from "./skill-policy.js";
import {
  classifyCopilotTool,
  COPILOT_FILE_SHAPES,
  COPILOT_SHELL_SHAPES,
  copilotFileCodec,
  copilotShellCodec,
} from "./toolmap.js";

export { copilotHarness } from "./harness.js";
export { copilotHookEntryProblem } from "./hook-entries.js";
export { copilotCapabilityProfiles } from "./profile.js";
export { copilotAgentPluginProjector, nativeCopilotAgentPluginProjector } from "./project-agent-plugin.js";
export { projectComponents, projectComponentProfiles, projectIntegration } from "./project.js";
export { applyCopilot } from "./apply.js";
export { CopilotDecodeError, decodeCopilot } from "./decode.js";
export { copilotHookRuntimePath, copilotHooksPath, generateCopilotArtifacts } from "./generate.js";
export { runCopilotCommandShim } from "./shim.js";
export type { CopilotShimOptions } from "./shim.js";
export {
  classifyCopilotTool,
  COPILOT_FILE_SHAPES,
  COPILOT_SHELL_SHAPES,
  copilotFileCodec,
  copilotShellCodec,
} from "./toolmap.js";

const COPILOT_MCP_IDENTITY: McpIdentitySupport = {
  source: "none",
  rationale:
    "Copilot names an MCP tool <server>-<tool> (probe-probe_echo; the built-in github-mcp-server-get_file_contents), but both segments may contain hyphens and no hook payload states the split. The adapter therefore never parses one and tool.mcp stays absent; hooks fall back to the native name and input (ADR-0032).",
  evidence: ".capture/copilot/README.md",
};

const COPILOT_SHELL_DIALECT: ShellDialectSupport = {
  source: "tool",
  rationale:
    "Set on every shell view: the runtime bash tool is posix and powershell is powershell. The Linux bash tool ran /usr/bin/bash, the macOS bash tool ran /bin/bash, and the Windows powershell tool ran Windows PowerShell 5.1 and was the only shell tool advertised there. A PascalCase payload's Bash name is the Claude alias for BOTH runtime tools, so its entry carries the command and no dialect. macOS was captured on 1.0.101.",
  evidence: ".capture/shell-dialects",
};

function resolveShimPath(): string {
  try {
    return createRequire(import.meta.url).resolve("@hooknostic/adapter-copilot/shim");
  } catch {
    return fileURLToPath(new URL("./shim.ts", import.meta.url));
  }
}

/**
 * Source for the generated per-target shim entry module. The build pipeline
 * bundles this (with the user's entry) into the self-contained
 * runtime/hooknostic.mjs artifact.
 */
export function copilotShimEntrySource(options: {
  targetId?: string;
  entryImportPath: string;
  capabilities: CapabilityLevels;
  policy: RuntimePolicy;
  minimumCapabilityLevel?: SupportLevel;
  harnessVersion?: string;
  pluginRootOffset?: string;
}): string {
  return [
    `import { runCopilotCommandShim${options.pluginRootOffset !== undefined ? ", pluginRootFrom" : ""} } from "@hooknostic/adapter-copilot/shim";`,
    // Loaded lazily so the shim claims stdout before plugin modules evaluate.
    `await runCopilotCommandShim(() => import(${JSON.stringify(options.entryImportPath)}), {`,
    `  targetId: ${JSON.stringify(options.targetId ?? "copilot")},`,
    `  capabilities: ${JSON.stringify(options.capabilities)},`,
    ...(options.minimumCapabilityLevel !== undefined
      ? [`  minimumCapabilityLevel: ${JSON.stringify(options.minimumCapabilityLevel)},`]
      : []),
    `  policy: ${JSON.stringify(options.policy)},`,
    ...(options.harnessVersion !== undefined ? [`  harnessVersion: ${JSON.stringify(options.harnessVersion)},`] : []),
    ...(options.pluginRootOffset !== undefined
      ? [`  pluginRoot: pluginRootFrom(import.meta.url, ${JSON.stringify(options.pluginRootOffset)}),`]
      : []),
    `});`,
    "",
  ].join("\n");
}

export function copilotAdapter(): HarnessAdapter {
  return {
    id: "copilot",
    adapterVersion: "0.9.0", // kept equal to package.json by versions.test.ts
    harness: copilotHarness,
    projectPaths: [".github/hooks", ".mcp.json", ".github/mcp.json", ".github/copilot/settings.json", ".agents/skills"],
    // Copilot reads only the root .mcp.json when it exists, and a repository's
    // .github/copilot/settings.json disabledMcpServers keeps a named server in
    // it from starting while Claude ignores that file (1.0.101,
    // foreign-components-probe.sh).
    sharedProjectMcp: {
      file: ".mcp.json",
      disable: { path: ".github/copilot/settings.json", key: ["disabledMcpServers"] },
    },
    projectIntegration,
    projectComponents,
    projectComponentProfiles,
    skillInvocationPolicy: {
      destination: ".agents/skills",
      discoveryDirectories: [".github/skills", ".claude/skills"],
      projectFiles: copilotSkillPolicy,
    },
    agentPluginProjector: copilotAgentPluginProjector,
    // Copilot spawns `node <artifact> <nativeEvent>` per hook event.
    shimExecution: "command",

    hookRuntimePath() {
      return copilotHookRuntimePath();
    },

    shellCodec: copilotShellCodec,
    shellShapes: COPILOT_SHELL_SHAPES,
    fileCodec: copilotFileCodec,
    fileShapes: COPILOT_FILE_SHAPES,
    classifyTool: (nativeName, input) => classifyCopilotTool(nativeName, input),
    shellDialect: COPILOT_SHELL_DIALECT,
    mcpIdentity: COPILOT_MCP_IDENTITY,

    supportedHarnessVersions() {
      return copilotCapabilityProfiles.map((profile) => profile.range);
    },

    supportedDeliveries() {
      return ["package", "project"] as const;
    },

    shimEntry(options) {
      return copilotShimEntrySource(options);
    },

    shimAliases() {
      return { "@hooknostic/adapter-copilot/shim": resolveShimPath() };
    },

    capabilities(target: TargetSpec) {
      return resolveCapabilityMatrix("copilot", copilotCapabilityProfiles, target.version);
    },

    async detect(): Promise<DetectionResult> {
      // A bare --version auto-updates: 1.0.101 downloaded and then reported
      // 1.0.102, so doctor would replace the build it was asked to report
      // (.capture/copilot/README.md).
      return detectCommandVersion("copilot", {
        args: ["--version", "--no-auto-update"],
        notFoundDetail: "copilot CLI not found on PATH",
      });
    },

    async compile(plugin: PluginIR, target: TargetSpec, bundle: RuntimeBundle, options): Promise<GeneratedArtifact[]> {
      return generateCopilotArtifacts(plugin, target, bundle, options);
    },

    async validateArtifacts(artifacts, target) {
      const diagnostics = [];
      const hookPath = copilotHooksPath(target.delivery);
      const hooksJson = artifacts.find((artifact) => artifact.path === hookPath);
      // A components-only package (skills and/or MCP, no portable hooks) has no
      // hooks document, which is valid: there is simply nothing for Copilot to
      // run. Validate the document when one exists.
      if (hooksJson !== undefined) {
        try {
          const parsed = JSON.parse(contentsText(hooksJson.contents)) as unknown;
          if (!isJsonObject(parsed) || parsed["version"] !== 1 || !isJsonObject(parsed["hooks"])) {
            throw new Error("document must have version 1 and an object hooks field");
          }
          for (const [eventName, entries] of Object.entries(parsed["hooks"])) {
            if (!Array.isArray(entries)) throw new Error(`hooks.${eventName} must be an array`);
            for (const [index, entry] of entries.entries()) {
              const problem = copilotHookEntryProblem(eventName, entry);
              if (problem !== undefined) throw new Error(`hooks.${eventName}[${index}]: ${problem}`);
            }
          }
        } catch (error) {
          diagnostics.push({
            code: "HN301" as const,
            severity: "error" as const,
            target: target.id,
            message: `generated ${hookPath} is invalid: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      if (target.delivery === "package") {
        const manifest = artifacts.find((artifact) => artifact.path === "plugin.json");
        try {
          if (manifest === undefined) throw new Error("plugin.json is missing");
          const parsed = JSON.parse(contentsText(manifest.contents)) as unknown;
          if (!isJsonObject(parsed) || typeof parsed["name"] !== "string" || parsed["name"] === "") {
            throw new Error("plugin.json must name the plugin");
          }
          const name = parsed["name"];
          // Agent Plugins 1.0 §5.5: 1-64 lowercase alphanumerics/hyphens/periods,
          // alphanumeric at both ends, and no consecutive separators. A package
          // Copilot rejects at load is not a successful build.
          if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(name) || name.includes("--") || name.includes("..")) {
            throw new Error(`plugin.json name ${JSON.stringify(name)} is not a valid Agent Plugins name`);
          }
          if (typeof parsed["$schema"] !== "string") throw new Error("plugin.json has no $schema");
        } catch (error) {
          diagnostics.push({
            code: "HN301" as const,
            severity: "error" as const,
            target: target.id,
            message: `generated plugin.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return diagnostics;
    },

    runtime: {
      async decode(nativeEvent, invocation, nativeEventName?: string) {
        return decodeCopilot(nativeEvent, invocation, nativeEventName);
      },
      apply: applyCopilot,
    },
  };
}
