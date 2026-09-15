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

async function runCodexShim(
  pluginSource: string,
  capabilities: Record<string, "exact">,
  extra: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-codex-shim-"));
  cleanup.push(dir);
  const pluginPath = join(dir, "hooks.ts");
  const bundlePath = join(dir, "hooknostic.mjs");
  await writeFile(pluginPath, pluginSource, "utf8");
  const bundle = await bundleRuntime({
    source: codexShimEntrySource({
      entryImportPath: pluginPath.replaceAll("\\", "/"),
      capabilities,
      minimumCapabilityLevel: "emulated",
      policy: { onHookError: "continue", timeoutMs: 5_000, contextCharLimit: 4_000_000 },
    }),
    resolveDir: dir,
    alias: ALIAS,
  });
  await writeFile(bundlePath, bundle.code, "utf8");
  const input = extra.input ?? (await readFile(join(REPO, "fixtures/codex/0.148/pre-tool-bash.input.json"), "utf8"));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [bundlePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOOKNOSTIC_DEBUG: "", ...extra.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

describe("Codex command shim output discipline", () => {
  const BLOCKING_LOGGER = `import { block, definePlugin, hook } from "@hooknostic/sdk";
    export default definePlugin({ name: "noisy", hooks: [hook("tool.before", {
      id: "noisy", capabilities: { "tool.before.block": "required" },
      async run() {
        console.log("log from a hook");
        process.stdout.write("raw stdout from a hook\\n");
        return block("nope");
      }
    })] });`;
  const CAPABILITIES = { "tool.before.observe": "exact", "tool.before.block": "exact" } as const;

  it("keeps handler output off the protocol stdout", async () => {
    const result = await runCodexShim(BLOCKING_LOGGER, CAPABILITIES);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.stderr).toContain("log from a hook");
    expect(result.stderr).toContain("raw stdout from a hook");
  });

  it("stays silent on an undecodable payload unless HOOKNOSTIC_DEBUG is set", async () => {
    const quiet = await runCodexShim(BLOCKING_LOGGER, CAPABILITIES, { input: "{}" });
    expect(quiet).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const traced = await runCodexShim(BLOCKING_LOGGER, CAPABILITIES, { input: "{}", env: { HOOKNOSTIC_DEBUG: "1" } });
    expect(traced.code).toBe(0);
    expect(traced.stdout).toBe("");
    expect(traced.stderr).toMatch(/^hooknostic debug: ignored payload: /m);
  });

  it("traces a dispatch when HOOKNOSTIC_DEBUG is set", async () => {
    const result = await runCodexShim(BLOCKING_LOGGER, CAPABILITIES, { env: { HOOKNOSTIC_DEBUG: "1" } });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.stderr).toMatch(/^hooknostic debug: PreToolUse -> tool\.before \(shell Bash\)$/m);
    expect(result.stderr).toMatch(/^hooknostic debug: effects \[noisy:block\], terminated by noisy, 0 errors$/m);
  });
});

describe("Codex command shim stdout claim", () => {
  it("survives a handler that back-pressures and ends stdout after console was initialized", async () => {
    const result = await runCodexShim(
      `import { block, definePlugin, hook } from "@hooknostic/sdk";
    console.error("module loaded");
    export default definePlugin({ name: "streamy", hooks: [hook("tool.before", {
      id: "streamy", capabilities: { "tool.before.block": "required" },
      async run() {
        console.log("log after console init");
        const accepted = process.stdout.write("z".repeat(4 * 1024 * 1024));
        if (!accepted) await new Promise((resolve) => process.stdout.once("drain", resolve));
        process.stdout.end("closing stdout");
        return block("nope");
      }
    })] });`,
      { "tool.before.observe": "exact", "tool.before.block": "exact" },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.stderr).toContain("log after console init");
    expect(result.stderr).toContain("closing stdout");
  });
});

describe("Codex command shim plugin loading and exit", () => {
  const PLUGIN = `import { block, definePlugin, hook } from "@hooknostic/sdk";
    import { stdout as namedStdout } from "node:process";
    const capturedStdout = process.stdout;
    console.log("module top-level log");
    // Defer stderr writes, like an asynchronous pipe, so queued output outlives the reply.
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, encoding, callback) => {
      const done = typeof encoding === "function" ? encoding : callback;
      setTimeout(() => {
        realStderrWrite(chunk);
        done?.();
      }, 5);
      return true;
    };
    export default definePlugin({ name: "captured", hooks: [hook("tool.before", {
      id: "captured", capabilities: { "tool.before.block": "required" },
      async run() {
        capturedStdout.write("written through a captured reference");
        namedStdout.write("written through the node:process export");
        for (let chunk = 0; chunk < 100; chunk += 1) process.stdout.write("q");
        return block("nope");
      }
    })] });`;
  const CAPS = { "tool.before.observe": "exact", "tool.before.block": "exact" } as const;

  it("claims stdout before plugin modules evaluate, and flushes redirected output before exiting", async () => {
    const result = await runCodexShim(PLUGIN, CAPS);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.stderr).toContain("module top-level log");
    expect(result.stderr).toContain("written through a captured reference");
    expect(result.stderr).toContain("written through the node:process export");
    expect(result.stderr.split("q").length - 1).toBe(100);
  });

  it("treats a payload that is not JSON as ignored", async () => {
    const result = await runCodexShim(PLUGIN, CAPS, { input: "not json" });
    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(result.stderr).not.toContain("hooknostic:");
    const traced = await runCodexShim(PLUGIN, CAPS, { input: "not json", env: { HOOKNOSTIC_DEBUG: "1" } });
    expect(traced.stderr).toMatch(/^hooknostic debug: ignored payload: payload is not JSON/m);
  });
});

describe("Codex command shim with an unusable stderr", () => {
  const CAPS = { "tool.before.observe": "exact", "tool.before.block": "exact" } as const;

  it("still replies and exits 0 when a handler ends stderr", async () => {
    const result = await runCodexShim(
      `import { block, definePlugin, hook } from "@hooknostic/sdk";
    export default definePlugin({ name: "stderr-abuse", hooks: [hook("tool.before", {
      id: "stderr-abuse", capabilities: { "tool.before.block": "required" },
      async run() {
        process.stderr.end("closing stderr");
        return block("nope");
      }
    })] });`,
      CAPS,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("still replies and exits 0 when a handler leaves stderr corked", async () => {
    const result = await runCodexShim(
      `import { block, definePlugin, hook } from "@hooknostic/sdk";
    export default definePlugin({ name: "stderr-abuse", hooks: [hook("tool.before", {
      id: "stderr-abuse", capabilities: { "tool.before.block": "required" },
      async run() {
        process.stderr.cork(); process.stderr.write("corked");
        return block("nope");
      }
    })] });`,
      CAPS,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("still replies and exits 0 when a handler destroys stderr", async () => {
    const result = await runCodexShim(
      `import { block, definePlugin, hook } from "@hooknostic/sdk";
    export default definePlugin({ name: "stderr-abuse", hooks: [hook("tool.before", {
      id: "stderr-abuse", capabilities: { "tool.before.block": "required" },
      async run() {
        process.stderr.destroy();
        return block("nope");
      }
    })] });`,
      CAPS,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
