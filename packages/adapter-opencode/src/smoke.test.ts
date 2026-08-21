/**
 * Real-harness smoke test for OpenCode. Opt-in: HOOKNOSTIC_SMOKE=1 or
 * HOOKNOSTIC_SMOKE=opencode. Requires the `opencode` CLI on PATH with a
 * provider configured for ollama-cloud/deepseek-v4-flash.
 *
 * Generates the bundled `.opencode/plugins/hooknostic.mjs` local plugin into
 * a scratch project and drives a real `opencode run` session.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleRuntime, buildPluginIR } from "@hooknostic/core";
import { definePlugin, hook } from "@hooknostic/sdk";
import {
  generateOpenCodeArtifacts,
  opencodeCapabilityProfiles,
  opencodeShimEntrySource,
} from "./index.js";

const smokeFlag = process.env["HOOKNOSTIC_SMOKE"] ?? "";
const enabled = smokeFlag === "1" || smokeFlag.split(",").includes("opencode");

const PACKAGES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO = resolve(PACKAGES, "..");
const SMOKE_DIR = join(REPO, ".capture", "opencode-smoke");
const MODEL = "ollama-cloud/deepseek-v4-flash";
const ALIAS = {
  "@hooknostic/sdk": join(PACKAGES, "sdk/src/index.ts"),
  "@hooknostic/runtime": join(PACKAGES, "runtime/src/index.ts"),
  "@hooknostic/adapter-opencode/shim": join(PACKAGES, "adapter-opencode/src/shim.ts"),
};

const HOOKS_SOURCE = `
import { definePlugin, hook, block, replaceInput } from "@hooknostic/sdk";

export default definePlugin({
  name: "smoke",
  hooks: [
    hook("tool.before", {
      id: "smoke-guard",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        const { command = "" } = event.tool.input as { command?: string };
        if (command.includes("forbidden-marker")) {
          return block("hooknostic smoke: this command is blocked");
        }
        if (
          ctx.capabilities.has("tool.before.input.replace") &&
          command.includes("hooknostic-original")
        ) {
          return replaceInput({
            ...(event.tool.input as object),
            command: command.replace("hooknostic-original", "hooknostic-rewritten"),
          });
        }
      },
    }),
  ],
});
`;

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`${command} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeoutMs);
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

describe.skipIf(!enabled)("OpenCode smoke (real harness)", () => {
  it(
    "block and input rewrite function in a live session",
    { timeout: 300_000 },
    async () => {
      await rm(SMOKE_DIR, { recursive: true, force: true });
      await mkdir(SMOKE_DIR, { recursive: true });
      await runCommand("git", ["init"], { cwd: SMOKE_DIR, timeoutMs: 30_000 });

      await writeFile(join(SMOKE_DIR, "hooks.ts"), HOOKS_SOURCE, "utf8");
      const levels = Object.fromEntries(
        Object.entries(opencodeCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]),
      );
      const bundle = await bundleRuntime({
        source: opencodeShimEntrySource({
          entryImportPath: join(SMOKE_DIR, "hooks.ts").replaceAll("\\", "/"),
          capabilities: levels,
          policy: { onHookError: "continue", timeoutMs: 5000 },
          harnessVersion: "1.18.18",
        }),
        resolveDir: SMOKE_DIR,
        alias: ALIAS,
      });

      const { ir } = buildPluginIR(
        definePlugin({
          name: "smoke",
          hooks: [hook("tool.before", { id: "smoke-guard", async run() {} })],
        }),
      );
      const artifacts = generateOpenCodeArtifacts(
        ir!,
        { id: "opencode", version: ">=1.18", mode: "local", output: SMOKE_DIR },
        bundle,
      );
      for (const artifact of artifacts) {
        const target = join(SMOKE_DIR, artifact.path);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, artifact.contents, "utf8");
      }

      const prompt =
        "Do these steps in order and do not retry failures. " +
        "1. Run this exact shell command with the bash tool: echo hooknostic-original. Report its stdout verbatim. " +
        "2. Try to create a file named forbidden-marker.txt in this directory using a single shell command. If the command errors or is blocked, say so and move on without retrying. " +
        "3. Then stop.";

      const { stdout, stderr } = await runCommand(
        "opencode",
        ["run", prompt, "--model", MODEL],
        { cwd: SMOKE_DIR, timeoutMs: 280_000 },
      );

      const transcript = stdout + "\n" + stderr;
      expect(transcript).toContain("hooknostic-rewritten");
      expect(existsSync(join(SMOKE_DIR, "forbidden-marker.txt"))).toBe(false);
    },
  );
});
