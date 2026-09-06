
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
import { applyCodex } from "./apply.js";
import { decodeCodex } from "./decode.js";
import { CODEX_NATIVE_EVENT, generateCodexArtifacts } from "./generate.js";
import { codexCapabilityProfiles } from "./profile.js";
import { codexShellCodec, CODEX_SHELL_SHAPES } from "./toolmap.js";
import { codexHarness } from "./harness.js";
export { codexHarness } from "./harness.js";

export { applyCodex } from "./apply.js";
export { CodexDecodeError, decodeCodex } from "./decode.js";
export { CODEX_NATIVE_EVENT, generateCodexArtifacts } from "./generate.js";
export { codexCapabilityProfiles } from "./profile.js";
export { runCodexCommandShim } from "./shim.js";
export type { CodexShimOptions } from "./shim.js";
export { classifyCodexTool, codexShellCodec, CODEX_SHELL_SHAPES } from "./toolmap.js";

function resolveShimPath(): string {
  try {
    return createRequire(import.meta.url).resolve("@hooknostic/adapter-codex/shim");
  } catch {
    return fileURLToPath(new URL("./shim.ts", import.meta.url));
  }
}

/** Shim entry source for the generated per-target runtime bundle. */
export function codexShimEntrySource(options: {
  entryImportPath: string;
  capabilities: CapabilityLevels;
  policy: RuntimePolicy;
  minimumCapabilityLevel?: SupportLevel;
  harnessVersion?: string;
}): string {
  return [
    `import plugin from ${JSON.stringify(options.entryImportPath)};`,
    `import { runCodexCommandShim } from "@hooknostic/adapter-codex/shim";`,
    `await runCodexCommandShim(plugin, {`,
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

export function codexAdapter(): HarnessAdapter {
  return {
    id: "codex",
    adapterVersion: "0.1.0", // kept equal to package.json by versions.test.ts
    harness: codexHarness,
    // Codex spawns `node <artifact>` per hook event.
    shimExecution: "command",
    shellCodec: codexShellCodec,
    shellShapes: CODEX_SHELL_SHAPES,

    supportedHarnessVersions() {
      return codexCapabilityProfiles.map((p) => p.range);
    },

    supportedModes() {
      return ["local"] as const;
    },

    shimEntry(options) {
      return codexShimEntrySource(options);
    },

    shimAliases() {
      return { "@hooknostic/adapter-codex/shim": resolveShimPath() };
    },

    capabilities(target: TargetSpec) {
      return resolveCapabilityMatrix("codex", codexCapabilityProfiles, target.version);
    },

    async detect(): Promise<DetectionResult> {
      return detectCommandVersion("codex", {
        notFoundDetail: "codex CLI not found on PATH",
      });
    },

    async compile(
      plugin: PluginIR,
      target: TargetSpec,
      bundle: RuntimeBundle,
      options,
    ): Promise<GeneratedArtifact[]> {
      return generateCodexArtifacts(plugin, target, bundle, options);
    },

    async validateArtifacts(artifacts, _target) {
      const diagnostics = [];
      const hooksJson = artifacts.find((a) => a.path === ".codex/hooks.json");
      if (hooksJson) {
        try {
          const parsed = JSON.parse(
            typeof hooksJson.contents === "string"
              ? hooksJson.contents
              : new TextDecoder().decode(hooksJson.contents),
          ) as {
            hooks?: Record<string, unknown>;
          };
          const validNames = new Set(Object.values(CODEX_NATIVE_EVENT));
          for (const eventName of Object.keys(parsed.hooks ?? {})) {
            if (!validNames.has(eventName)) {
              diagnostics.push({
                code: "HN301" as const,
                severity: "error" as const,
                target: "codex",
                message: `generated hooks.json contains unknown native event "${eventName}".`,
              });
            }
          }
        } catch (error) {
          diagnostics.push({
            code: "HN301" as const,
            severity: "error" as const,
            target: "codex",
            message: `generated hooks.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return diagnostics;
    },

    runtime: {
      async decode(nativeEvent, invocation) {
        return decodeCodex(nativeEvent, invocation);
      },
      apply: applyCodex,
    },
  };
}
