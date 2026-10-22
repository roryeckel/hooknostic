/**
 * Real-harness smoke test for GitHub Copilot CLI. Opt-in: HOOKNOSTIC_SMOKE=1
 * or HOOKNOSTIC_SMOKE=copilot. Requires `copilot` on PATH and a BYOK provider
 * configured through COPILOT_PROVIDER_BASE_URL / COPILOT_MODEL (the owner's
 * free local endpoint); the test never reads a GitHub credential.
 *
 * The generated artifact is an Agent Plugins package loaded through
 * `--plugin-dir`, so this exercises the same package delivery a consumer
 * installs. It proves one blocking effect and one mutating effect end to end.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildPluginIR, bundleRuntime } from "@hooknostic/core";
import { block, definePlugin, hook, replaceInput } from "@hooknostic/sdk";

import { copilotHarness } from "./harness.js";
import { copilotShimEntrySource, generateCopilotArtifacts } from "./index.js";

const smokeFlag = process.env["HOOKNOSTIC_SMOKE"] ?? "";
const enabled = smokeFlag === "1" || smokeFlag.split(",").includes("copilot");
const PACKAGES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO = resolve(PACKAGES, "..");
const SMOKE_DIR = join(REPO, ".capture", "copilot-smoke");
const ALIAS = {
  "@hooknostic/sdk": join(PACKAGES, "sdk/src/index.ts"),
  "@hooknostic/runtime": join(PACKAGES, "runtime/src/index.ts"),
  "@hooknostic/adapter-copilot/shim": join(PACKAGES, "adapter-copilot/src/shim.ts"),
  "@hooknostic/adapter-copilot": join(PACKAGES, "adapter-copilot/src/index.ts"),
};

const SMOKE_ENTRY_SOURCE = `import { block, definePlugin, hook, replaceInput } from "@hooknostic/sdk";

export default definePlugin({
  name: "hooknostic-smoke",
  hooks: [
    hook("tool.before", {
      id: "smoke",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        const input = event.tool.input;
        const command = input.command ?? "";
        if (command.includes("forbidden-marker")) return block("hooknostic smoke: command blocked");
        if (command.includes("hooknostic-original") && ctx.capabilities.has("tool.before.input.replace")) {
          return replaceInput({ ...input, command: command.replace("hooknostic-original", "hooknostic-rewritten") });
        }
        return undefined;
      },
    }),
  ],
});
`;

/**
 * Resolve the CLI without a shell. A direct spawn of `copilot` on Windows
 * cannot execute the npm `.cmd` shim, and `shell: true` would concatenate the
 * prompt into separate arguments. The npm loader is a normal Node script on
 * every platform and forwards its argv verbatim to the platform binary.
 */
function resolveCopilotLauncher(): { command: string; prefix: string[] } {
  if (process.env["COPILOT_BINARY"] !== undefined) {
    return { command: process.env["COPILOT_BINARY"], prefix: [] };
  }
  const candidates: string[] = [];
  if (process.env["APPDATA"] !== undefined) {
    candidates.push(join(process.env["APPDATA"], "npm", "node_modules", "@github", "copilot", "npm-loader.js"));
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(join(root, "@github", "copilot", "npm-loader.js"));
  } catch {
    // npm may be a shim that cannot be spawned without a shell on Windows;
    // the APPDATA candidate above covers that install.
  }
  for (const loader of candidates) {
    if (existsSync(loader)) return { command: process.execPath, prefix: [loader] };
  }
  throw new Error(
    "copilot is not installed in a discoverable global location; set COPILOT_BINARY to its native executable",
  );
}

function runCopilot(prompt: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const launcher = resolveCopilotLauncher();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      launcher.command,
      [
        ...launcher.prefix,
        "--trust-folder",
        "--allow-all-tools",
        "--disable-client-telemetry",
        "--no-auto-update",
        "--plugin-dir",
        SMOKE_DIR,
        "-p",
        prompt,
      ],
      { cwd: SMOKE_DIR, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`copilot smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 180_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
  });
}

describe.skipIf(!enabled)("Copilot real-harness smoke", () => {
  it("loads the generated package and honors a rewrite and a block", async () => {
    await rm(SMOKE_DIR, { recursive: true, force: true });
    await mkdir(SMOKE_DIR, { recursive: true });
    await rm(join(SMOKE_DIR, "hooknostic-tool.txt"), { force: true });
    await rm(join(SMOKE_DIR, "hooknostic-forbidden.txt"), { force: true });
    const { ir, diagnostics } = buildPluginIR(
      definePlugin({
        name: "hooknostic-smoke",
        hooks: [
          hook("tool.before", {
            id: "smoke",
            match: { kind: "shell" },
            capabilities: {
              "tool.before.block": "required",
              "tool.before.input.replace": "optional",
            },
            async run(event, ctx) {
              const input = event.tool.input as { command?: string };
              const command = input.command ?? "";
              if (command.includes("forbidden-marker")) return block("hooknostic smoke: command blocked");
              if (command.includes("hooknostic-original") && ctx.capabilities.has("tool.before.input.replace")) {
                return replaceInput({
                  ...input,
                  command: command.replace("hooknostic-original", "hooknostic-rewritten"),
                });
              }
              return undefined;
            },
          }),
        ],
      }),
    );
    expect(diagnostics).toEqual([]);
    const entryPath = join(SMOKE_DIR, "smoke-entry.ts");
    await writeFile(entryPath, SMOKE_ENTRY_SOURCE, "utf8");
    const target = {
      id: "copilot",
      version: copilotHarness.recommendedRange,
      delivery: "package" as const,
      output: SMOKE_DIR,
    };
    const bundle = await bundleRuntime({
      source: copilotShimEntrySource({
        entryImportPath: join(SMOKE_DIR, "smoke-entry.ts").replaceAll("\\", "/"),
        capabilities: {
          "tool.before.observe": "exact",
          "tool.before.block": "exact",
          "tool.before.input.replace": "exact",
        },
        minimumCapabilityLevel: "emulated",
        policy: { onHookError: "continue", timeoutMs: 10_000, contextCharLimit: 4_000_000, notifyCharLimit: 4_000 },
        harnessVersion: copilotHarness.referenceVersion,
      }),
      resolveDir: SMOKE_DIR,
      alias: ALIAS,
    });
    const artifacts = generateCopilotArtifacts(ir!, target, bundle, {
      runtime: { onHookError: "continue", timeoutMs: 10_000, contextCharLimit: 4_000_000, notifyCharLimit: 4_000 },
    });
    for (const artifact of artifacts) {
      const path = join(SMOKE_DIR, artifact.path);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, artifact.contents);
    }

    const rewritten = await runCopilot(
      `Run exactly this shell command: node -e "require('fs').writeFileSync('hooknostic-tool.txt','hooknostic-original')"`,
    );
    expect(rewritten.code, rewritten.stdout + rewritten.stderr).toBe(0);
    expect(
      await readFile(join(SMOKE_DIR, "hooknostic-tool.txt"), "utf8").catch(() => null),
      rewritten.stdout + rewritten.stderr,
    ).toBe("hooknostic-rewritten");

    const blocked = await runCopilot(
      `Run exactly this shell command: node -e "require('fs').writeFileSync('hooknostic-forbidden.txt','forbidden-marker')"`,
    );
    expect(blocked.code, blocked.stdout + blocked.stderr).toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("hooknostic smoke: command blocked");
    expect(
      await readFile(join(SMOKE_DIR, "hooknostic-forbidden.txt"), "utf8").catch(() => null),
      "a blocked command still created its file",
    ).toBeNull();
    // Two real CLI runs, each with its own 180s child kill timer, plus setup.
  }, 420_000);
});
