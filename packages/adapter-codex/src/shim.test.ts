import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { bundleRuntime } from "@hooknostic/core";

import { codexShimEntrySource } from "./index.js";

const PACKAGES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO = resolve(PACKAGES, "..");
const ALIAS = {
  "@hooknostic/sdk": join(PACKAGES, "sdk/src/index.ts"),
  "@hooknostic/runtime": join(PACKAGES, "runtime/src/index.ts"),
  "@hooknostic/adapter-codex/shim": join(PACKAGES, "adapter-codex/src/shim.ts"),
};
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex command shim stream draining", () => {
  it("flushes a response larger than the pipe buffer before exiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-codex-shim-"));
    cleanup.push(dir);
    const pluginPath = join(dir, "hooks.ts");
    const bundlePath = join(dir, "hooknostic.mjs");
    await writeFile(
      pluginPath,
      `import { definePlugin, hook, replaceInput } from "@hooknostic/sdk";
       export default definePlugin({ name: "large", hooks: [hook("tool.before", {
         id: "large", capabilities: { "tool.before.input.replace": "required" },
         async run() { return replaceInput({ command: "x".repeat(2_000_000) }); }
       })] });`,
      "utf8",
    );
    const bundle = await bundleRuntime({
      source: codexShimEntrySource({
        entryImportPath: pluginPath.replaceAll("\\", "/"),
        capabilities: {
          "tool.before.observe": "exact",
          "tool.before.input.replace": "exact",
        },
        minimumCapabilityLevel: "emulated",
        policy: { onHookError: "continue", timeoutMs: 5_000, contextCharLimit: 4_000_000 },
      }),
      resolveDir: dir,
      alias: ALIAS,
    });
    await writeFile(bundlePath, bundle.code, "utf8");
    const input = await readFile(join(REPO, "fixtures/codex/0.148/pre-tool-bash.input.json"), "utf8");
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [bundlePath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", rejectPromise);
        child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
        child.stdin.end(input);
      },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command).toHaveLength(2_000_000);
  });

  it("exits after a handler timeout even when the handler retains a live handle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-codex-shim-"));
    cleanup.push(dir);
    const pluginPath = join(dir, "hooks.ts");
    const bundlePath = join(dir, "hooknostic.mjs");
    await writeFile(
      pluginPath,
      `import { definePlugin, hook, replaceInput } from "@hooknostic/sdk";
       export default definePlugin({ name: "timeout", hooks: [
         hook("tool.before", {
           id: "slow",
           async run() {
             setInterval(() => {}, 30_000);
             await new Promise(() => {});
           }
         }),
         hook("tool.before", {
           id: "rewrite",
           capabilities: { "tool.before.input.replace": "required" },
           async run() { return replaceInput({ command: "after-timeout" }); }
         })
       ] });`,
      "utf8",
    );
    const bundle = await bundleRuntime({
      source: codexShimEntrySource({
        entryImportPath: pluginPath.replaceAll("\\", "/"),
        capabilities: {
          "tool.before.observe": "exact",
          "tool.before.input.replace": "exact",
        },
        minimumCapabilityLevel: "emulated",
        policy: { onHookError: "continue", timeoutMs: 25, contextCharLimit: 4_000_000 },
      }),
      resolveDir: dir,
      alias: ALIAS,
    });
    await writeFile(bundlePath, bundle.code, "utf8");
    const input = await readFile(join(REPO, "fixtures/codex/0.148/pre-tool-bash.input.json"), "utf8");
    const startedAt = Date.now();
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      elapsedMs: number;
    }>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [bundlePath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(new Error("Codex shim did not exit after dispatch completed"));
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
    expect(result.code).toBe(0);
    // The timeout that used to vanish is now named on stderr. Codex's wire
    // schemas are additionalProperties:false, so this cannot ride in the JSON
    // body -- stderr is the only channel that does not become a vendor error.
    expect(result.stderr).toContain("hooknostic timeout [slow]");
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toEqual({
      command: "after-timeout",
    });
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});
