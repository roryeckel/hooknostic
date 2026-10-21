import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { bundleRuntime } from "@hooknostic/core";

import { copilotShimEntrySource } from "./index.js";

const PACKAGES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO = resolve(PACKAGES, "..");
const ALIAS = {
  "@hooknostic/sdk": join(PACKAGES, "sdk/src/index.ts"),
  "@hooknostic/runtime": join(PACKAGES, "runtime/src/index.ts"),
  "@hooknostic/adapter-copilot/shim": join(PACKAGES, "adapter-copilot/src/shim.ts"),
  "@hooknostic/adapter-copilot": join(PACKAGES, "adapter-copilot/src/index.ts"),
};
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runShim(
  pluginSource: string,
  input: string,
  capabilities: Record<string, "exact">,
  args: string[] = ["preToolUse"],
  timeoutMs = 5_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-copilot-shim-"));
  cleanup.push(dir);
  const pluginPath = join(dir, "hooks.ts");
  const bundlePath = join(dir, "hooknostic.mjs");
  await writeFile(pluginPath, pluginSource, "utf8");
  const bundle = await bundleRuntime({
    source: copilotShimEntrySource({
      entryImportPath: pluginPath.replaceAll("\\", "/"),
      capabilities,
      minimumCapabilityLevel: "emulated",
      policy: { onHookError: "continue", timeoutMs, contextCharLimit: 4_000_000, notifyCharLimit: 4_000 },
    }),
    resolveDir: dir,
    alias: ALIAS,
  });
  await writeFile(bundlePath, bundle.code, "utf8");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [bundlePath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOOKNOSTIC_DEBUG: "" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Copilot shim did not exit"));
    }, 3_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}

async function fixture(name: string): Promise<string> {
  return readFile(join(REPO, "fixtures/copilot/1.0", name), "utf8");
}

describe("Copilot command shim", () => {
  it("denies a tool call from the native event hint", async () => {
    const result = await runShim(
      `import { block, definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "guard", hooks: [hook("tool.before", {
         id: "guard", capabilities: { "tool.before.block": "required" },
         async run() { return block("blocked by the capture probe"); }
       })] });`,
      await fixture("tool-before.input.json"),
      { "tool.before.observe": "exact", "tool.before.block": "exact" },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "blocked by the capture probe",
    });
  });

  it("rewrites a shell command through the shape table", async () => {
    const result = await runShim(
      `import { definePlugin, hook, updateShell } from "@hooknostic/sdk";
       export default definePlugin({ name: "rewrite", hooks: [hook("tool.before", {
         id: "rewrite", capabilities: { "tool.before.input.replace": "required" },
         async run(event) { return updateShell({ command: "echo " + event.tool.shell.command }); }
       })] });`,
      await fixture("tool-before.input.json"),
      { "tool.before.observe": "exact", "tool.before.input.replace": "exact" },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      modifiedArgs: { command: "echo echo camel-lifecycle", description: "Echo camel-lifecycle" },
    });
  });

  it("decodes a PascalCase payload without a hint", async () => {
    const result = await runShim(
      `import { addContext, definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "context", hooks: [hook("session.start", {
         id: "context", capabilities: { "session.start.context.add": "required" },
         async run() { return addContext("pascal-context"); }
       })] });`,
      await fixture("session-start-pascal.input.json"),
      { "session.start.observe": "exact", "session.start.context.add": "exact" },
      [],
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ additionalContext: "pascal-context" });
  });

  it("fails open on an event outside the portable vocabulary", async () => {
    const result = await runShim(
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "empty", hooks: [hook("session.start", { id: "noop", async run() {} })] });`,
      await fixture("error-occurred.input.json"),
      { "session.start.observe": "exact" },
      ["ErrorOccurred"],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("flushes a response larger than the pipe buffer before exiting", async () => {
    const result = await runShim(
      `import { definePlugin, hook, replaceInput } from "@hooknostic/sdk";
       export default definePlugin({ name: "large", hooks: [hook("tool.before", {
         id: "large", capabilities: { "tool.before.input.replace": "required" },
         async run() { return replaceInput({ command: "x".repeat(2_000_000) }); }
       })] });`,
      await fixture("tool-before.input.json"),
      { "tool.before.observe": "exact", "tool.before.input.replace": "exact" },
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { modifiedArgs: { command: string } }).modifiedArgs.command).toHaveLength(
      2_000_000,
    );
  });
});
