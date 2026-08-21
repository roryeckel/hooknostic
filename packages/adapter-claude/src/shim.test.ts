import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bundleRuntime } from "@hooknostic/core";
import { claudeShimEntrySource } from "./index.js";

const PACKAGES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO = resolve(PACKAGES, "..");
const ALIAS = {
  "@hooknostic/sdk": join(PACKAGES, "sdk/src/index.ts"),
  "@hooknostic/runtime": join(PACKAGES, "runtime/src/index.ts"),
  "@hooknostic/adapter-claude/shim": join(PACKAGES, "adapter-claude/src/shim.ts"),
};
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runShim(
  pluginSource: string,
  inputFixture: string,
  capabilities: Record<string, "exact">,
  timeoutMs = 5_000,
): Promise<{ stdout: string; stderr: string; code: number | null; elapsedMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-claude-shim-"));
  cleanup.push(dir);
  const pluginPath = join(dir, "hooks.ts");
  const bundlePath = join(dir, "hooknostic.mjs");
  await writeFile(pluginPath, pluginSource, "utf8");
  const bundle = await bundleRuntime({
    source: claudeShimEntrySource({
      entryImportPath: pluginPath.replaceAll("\\", "/"),
      capabilities,
      minimumCapabilityLevel: "emulated",
      policy: { onHookError: "continue", timeoutMs, contextCharLimit: 4_000_000 },
    }),
    resolveDir: dir,
    alias: ALIAS,
  });
  await writeFile(bundlePath, bundle.code, "utf8");
  const input = await readFile(join(REPO, inputFixture), "utf8");
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [bundlePath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Claude shim did not exit after dispatch completed"));
    }, 3_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, elapsedMs: Date.now() - startedAt });
    });
    child.stdin.end(input);
  });
}

describe("Claude command shim stream draining", () => {
  it("flushes a response larger than the pipe buffer before exiting", async () => {
    const result = await runShim(
      `import { definePlugin, hook, replaceInput } from "@hooknostic/sdk";
       export default definePlugin({ name: "large", hooks: [hook("tool.before", {
         id: "large", capabilities: { "tool.before.input.replace": "required" },
         async run() { return replaceInput({ command: "x".repeat(2_000_000) }); }
       })] });`,
      "fixtures/claude/2.1/pre-tool-bash.input.json",
      { "tool.before.observe": "exact", "tool.before.input.replace": "exact" },
    );
    expect(result.code).toBe(0);
    expect(
      JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command,
    ).toHaveLength(2_000_000);
  });

  it("flushes a large stderr blocking reason before exiting", async () => {
    const result = await runShim(
      `import { block, definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "large", hooks: [hook("prompt.before", {
         id: "large", capabilities: { "prompt.before.block": "required" },
         async run() { return block("x".repeat(2_000_000)); }
       })] });`,
      "fixtures/claude/2.1/prompt-submit.input.json",
      { "prompt.before.observe": "exact", "prompt.before.block": "exact" },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toHaveLength(2_000_000);
  });

  it("exits after a handler timeout even when the handler retains a live handle", async () => {
    const result = await runShim(
      `import { block, definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "timeout", hooks: [
         hook("prompt.before", {
           id: "slow",
           async run() {
             setInterval(() => {}, 30_000);
             await new Promise(() => {});
           }
         }),
         hook("prompt.before", {
           id: "block",
           capabilities: { "prompt.before.block": "required" },
           async run() { return block("blocked after timeout"); }
         })
       ] });`,
      "fixtures/claude/2.1/prompt-submit.input.json",
      { "prompt.before.observe": "exact", "prompt.before.block": "exact" },
      25,
    );
    expect(result).toMatchObject({ code: 2, stderr: "blocked after timeout" });
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});
