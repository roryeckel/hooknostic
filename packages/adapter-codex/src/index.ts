export const ADAPTER_CODEX_VERSION = "0.1.0";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  DetectionResult,
  GeneratedArtifact,
  HarnessAdapter,
  PluginIR,
  RuntimeBundle,
  TargetSpec,
} from "@hooknostic/core";
import { resolveCapabilityMatrix } from "@hooknostic/core";
import type { CapabilityLevels } from "@hooknostic/runtime";
import type { RuntimePolicy } from "@hooknostic/sdk";
import { applyCodex } from "./apply.js";
import { decodeCodex } from "./decode.js";
import { CODEX_NATIVE_EVENT, generateCodexArtifacts } from "./generate.js";
import { codexCapabilityProfiles } from "./profile.js";

export { applyCodex } from "./apply.js";
export { CodexDecodeError, decodeCodex } from "./decode.js";
export { CODEX_NATIVE_EVENT, generateCodexArtifacts } from "./generate.js";
export { codexCapabilityProfiles } from "./profile.js";
export { runCodexCommandShim } from "./shim.js";
export type { CodexShimOptions } from "./shim.js";
export { classifyCodexTool } from "./toolmap.js";

const execFileAsync = promisify(execFile);

/** Shim entry source for the generated per-target runtime bundle. */
export function codexShimEntrySource(options: {
  entryImportPath: string;
  capabilities: CapabilityLevels;
  policy: RuntimePolicy;
  harnessVersion?: string;
}): string {
  return [
    `import plugin from ${JSON.stringify(options.entryImportPath)};`,
    `import { runCodexCommandShim } from "@hooknostic/adapter-codex/shim";`,
    `await runCodexCommandShim(plugin, {`,
    `  capabilities: ${JSON.stringify(options.capabilities)},`,
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
    adapterVersion: ADAPTER_CODEX_VERSION,

    supportedHarnessVersions() {
      return codexCapabilityProfiles.map((p) => p.range);
    },

    capabilities(target: TargetSpec) {
      return resolveCapabilityMatrix("codex", codexCapabilityProfiles, target.version);
    },

    async detect(): Promise<DetectionResult> {
      try {
        // codex installs as an npm .ps1/.cmd wrapper on Windows; resolve via
        // shell so PATHEXT applies.
        const { stdout } = await execFileAsync("codex", ["--version"], {
          shell: process.platform === "win32",
          timeout: 15_000,
        });
        const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
        return version !== undefined
          ? { installed: true, version, detail: stdout.trim() }
          : { installed: true, detail: stdout.trim() };
      } catch {
        return { installed: false, detail: "codex CLI not found on PATH" };
      }
    },

    async compile(
      plugin: PluginIR,
      target: TargetSpec,
      bundle: RuntimeBundle,
    ): Promise<GeneratedArtifact[]> {
      return generateCodexArtifacts(plugin, target, bundle);
    },

    async validateArtifacts(artifacts, _target) {
      const diagnostics = [];
      const hooksJson = artifacts.find((a) => a.path === ".codex/hooks.json");
      if (hooksJson) {
        try {
          const parsed = JSON.parse(hooksJson.contents) as {
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
