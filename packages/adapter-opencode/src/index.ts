export const ADAPTER_OPENCODE_VERSION = "0.1.0";

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
import type { RuntimePolicy, SupportLevel } from "@hooknostic/sdk";
import { applyOpenCode } from "./apply.js";
import { decodeOpenCode } from "./decode.js";
import { generateOpenCodeArtifacts } from "./generate.js";
import { opencodeCapabilityProfiles } from "./profile.js";

export {
  applyOpenCode,
  planOpenCodeApplication,
  serializeOpenCodeOutput,
} from "./apply.js";
export type { OpenCodeApplication } from "./apply.js";
export { OpenCodeDecodeError, decodeOpenCode } from "./decode.js";
export type { OpenCodeNativeEvent } from "./decode.js";
export { generateOpenCodeArtifacts } from "./generate.js";
export { opencodeCapabilityProfiles } from "./profile.js";
export { createHooknosticHooks } from "./shim.js";
export type { OpenCodePluginInput, OpenCodeShimOptions } from "./shim.js";
export { classifyOpenCodeTool, opencodeShellCodec, OPENCODE_SHELL_SHAPES } from "./toolmap.js";

const execFileAsync = promisify(execFile);

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
    `    capabilities: ${JSON.stringify(options.capabilities)},`,
    ...(options.minimumCapabilityLevel !== undefined
      ? [`    minimumCapabilityLevel: ${JSON.stringify(options.minimumCapabilityLevel)},`]
      : []),
    `    policy: ${JSON.stringify(options.policy)},`,
    ...(options.harnessVersion !== undefined
      ? [`    harnessVersion: ${JSON.stringify(options.harnessVersion)},`]
      : []),
    `  }, input);`,
    `export default HooknosticPlugin;`,
    "",
  ].join("\n");
}

export function opencodeAdapter(): HarnessAdapter {
  return {
    id: "opencode",
    adapterVersion: ADAPTER_OPENCODE_VERSION,
    // OpenCode imports the plugin module in-process.
    shimExecution: "module",

    supportedHarnessVersions() {
      return opencodeCapabilityProfiles.map((p) => p.range);
    },

    supportedModes() {
      return ["local"] as const;
    },

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
      try {
        const { stdout } = await execFileAsync("opencode", ["--version"], {
          shell: process.platform === "win32",
          timeout: 15_000,
        });
        const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
        return version !== undefined
          ? { installed: true, version, detail: stdout.trim() }
          : { installed: true, detail: stdout.trim() };
      } catch {
        return { installed: false, detail: "opencode CLI not found on PATH" };
      }
    },

    async compile(
      plugin: PluginIR,
      target: TargetSpec,
      bundle: RuntimeBundle,
    ): Promise<GeneratedArtifact[]> {
      return generateOpenCodeArtifacts(plugin, target, bundle);
    },

    async validateArtifacts(artifacts, _target) {
      const diagnostics = [];
      const module = artifacts.find((a) => a.path === ".opencode/plugins/hooknostic.js");
      if (module && !module.contents.includes("HooknosticPlugin")) {
        diagnostics.push({
          code: "HN301" as const,
          severity: "error" as const,
          target: "opencode",
          message: "generated plugin module does not export HooknosticPlugin.",
        });
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
