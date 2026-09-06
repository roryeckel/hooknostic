
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
import { applyClaude } from "./apply.js";
import { decodeClaude } from "./decode.js";
import { CLAUDE_NATIVE_EVENT, generateClaudeArtifacts } from "./generate.js";
import { claudeCapabilityProfiles } from "./profile.js";
import { claudeAgentPluginProjector } from "./project-agent-plugin.js";
import { claudeShellCodec, CLAUDE_SHELL_SHAPES } from "./toolmap.js";
import { claudeHarness } from "./harness.js";
export { claudeHarness } from "./harness.js";

export { applyClaude } from "./apply.js";
export { ClaudeDecodeError, decodeClaude } from "./decode.js";
export { CLAUDE_NATIVE_EVENT, generateClaudeArtifacts } from "./generate.js";
export { claudeCapabilityProfiles } from "./profile.js";
export { claudeAgentPluginProjector, projectAgentPluginToClaude } from "./project-agent-plugin.js";
export { runClaudeCommandShim } from "./shim.js";
export type { ClaudeShimOptions } from "./shim.js";
export { classifyClaudeTool, claudeShellCodec, CLAUDE_SHELL_SHAPES } from "./toolmap.js";

function resolveShimPath(): string {
  try {
    return createRequire(import.meta.url).resolve("@hooknostic/adapter-claude/shim");
  } catch {
    // Unbundled fallback: the shim lives next to this module.
    return fileURLToPath(new URL("./shim.ts", import.meta.url));
  }
}

/**
 * Source for the generated per-target shim entry module. The build pipeline
 * bundles this (with the user's entry) into the self-contained
 * runtime/hooknostic.mjs artifact.
 */
export function claudeShimEntrySource(options: {
  entryImportPath: string;
  capabilities: CapabilityLevels;
  policy: RuntimePolicy;
  minimumCapabilityLevel?: SupportLevel;
  harnessVersion?: string;
}): string {
  return [
    `import plugin from ${JSON.stringify(options.entryImportPath)};`,
    // The /shim subpath keeps compile-time-only machinery (core, esbuild)
    // out of the generated runtime bundle.
    `import { runClaudeCommandShim } from "@hooknostic/adapter-claude/shim";`,
    `await runClaudeCommandShim(plugin, {`,
    `  capabilities: ${JSON.stringify(options.capabilities)},`,
    ...(options.minimumCapabilityLevel !== undefined
      ? [`  minimumCapabilityLevel: ${JSON.stringify(options.minimumCapabilityLevel)},`]
      : []),
    `  policy: ${JSON.stringify(options.policy)},`,
    ...(options.harnessVersion !== undefined
      ? [`  harnessVersion: ${JSON.stringify(options.harnessVersion)},`]
      : []),
    `});`,
    "",
  ].join("\n");
}

export function claudeAdapter(): HarnessAdapter {
  return {
    id: "claude",
    adapterVersion: "0.1.0", // kept equal to package.json by versions.test.ts
    harness: claudeHarness,
    agentPluginProjector: claudeAgentPluginProjector,
    // Claude spawns `node <artifact>` per hook event.
    shimExecution: "command",
    shellCodec: claudeShellCodec,
    shellShapes: CLAUDE_SHELL_SHAPES,

    supportedHarnessVersions() {
      return claudeCapabilityProfiles.map((p) => p.range);
    },

    supportedModes() {
      return ["plugin"] as const;
    },

    shimEntry(options) {
      return claudeShimEntrySource(options);
    },

    shimAliases() {
      // User projects depend only on the SDK; resolve our shim through the
      // package graph so the path survives CLI bundling.
      return { "@hooknostic/adapter-claude/shim": resolveShimPath() };
    },

    capabilities(target: TargetSpec) {
      return resolveCapabilityMatrix("claude", claudeCapabilityProfiles, target.version);
    },

    async detect(): Promise<DetectionResult> {
      return detectCommandVersion("claude", {
        notFoundDetail: "claude CLI not found on PATH",
      });
    },

    async compile(
      plugin: PluginIR,
      target: TargetSpec,
      bundle: RuntimeBundle,
      options,
    ): Promise<GeneratedArtifact[]> {
      return generateClaudeArtifacts(plugin, target, bundle, options);
    },

    async validateArtifacts(artifacts, _target) {
      const diagnostics = [];
      const hooksJson = artifacts.find((a) => a.path === "hooks/hooks.json");
      if (hooksJson) {
        try {
          const parsed = JSON.parse(
            typeof hooksJson.contents === "string"
              ? hooksJson.contents
              : new TextDecoder().decode(hooksJson.contents),
          ) as {
            hooks?: Record<string, unknown>;
          };
          const validNames = new Set(Object.values(CLAUDE_NATIVE_EVENT));
          for (const eventName of Object.keys(parsed.hooks ?? {})) {
            if (!validNames.has(eventName)) {
              diagnostics.push({
                code: "HN301" as const,
                severity: "error" as const,
                target: "claude",
                message: `generated hooks.json contains unknown native event "${eventName}".`,
              });
            }
          }
        } catch (error) {
          diagnostics.push({
            code: "HN301" as const,
            severity: "error" as const,
            target: "claude",
            message: `generated hooks.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return diagnostics;
    },

    runtime: {
      async decode(nativeEvent, invocation) {
        return decodeClaude(nativeEvent, invocation);
      },
      apply: applyClaude,
    },
  };
}
