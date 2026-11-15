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
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number | null; elapsedMs: number }> {
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
    const startedAt = Date.now();
    const child = spawn(process.execPath, [bundlePath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOOKNOSTIC_DEBUG: "", ...env },
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
      resolvePromise({ stdout, stderr, code, elapsedMs: Date.now() - startedAt });
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
    // Not ours is not a defect: nothing is reported.
    expect(result.stderr).not.toMatch(/^hooknostic /m);
  });

  it("treats a payload that is not JSON as ignored, and traces it only under HOOKNOSTIC_DEBUG", async () => {
    const PLUGIN = `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "noop", hooks: [hook("tool.before", { id: "noop", async run() {} })] });`;
    const caps = { "tool.before.observe": "exact" } as const;
    const quiet = await runShim(PLUGIN, "not json", caps);
    expect(quiet).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const traced = await runShim(PLUGIN, "not json", caps, undefined, undefined, { HOOKNOSTIC_DEBUG: "1" });
    expect(traced).toMatchObject({ code: 0, stdout: "" });
    expect(traced.stderr).toMatch(/^hooknostic debug: ignored payload: payload is not JSON/m);
  });

  it("reports a plugin module that throws as an internal error, and fails open", async () => {
    const THROWING = `throw new Error("plugin module failed");\nexport default {};`;
    const caps = { "tool.before.observe": "exact" } as const;
    const result = await runShim(THROWING, await fixture("tool-before.input.json"), caps);
    expect(result).toMatchObject({ code: 0, stdout: "" });
    // One whole line, newline included, naming the native event.
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: plugin module failed\n/m);
    const traced = await runShim(THROWING, await fixture("tool-before.input.json"), caps, undefined, undefined, {
      HOOKNOSTIC_DEBUG: "1",
    });
    expect(traced.code).toBe(0);
    expect(traced.stderr).toMatch(
      /^hooknostic internal \[preToolUse\]: plugin module failed\nError: plugin module failed\n\s+at /m,
    );
  });

  it("fails open on a thrown value it cannot inspect, rather than denying the call", async () => {
    // `instanceof` on a revoked proxy throws, in the very catch that tells a
    // payload that is not ours from a defect. The exit 1 that followed is a
    // denial on preToolUse, where any non-zero exit blocks.
    const REVOKED = `const { proxy, revoke } = Proxy.revocable({}, {});\nrevoke();\nthrow proxy;\nexport default {};`;
    const result = await runShim(REVOKED, await fixture("tool-before.input.json"), {
      "tool.before.observe": "exact",
    });
    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: uninspectable thrown value\n/m);
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

/**
 * A hook source that does not expect to share its process: the shapes a
 * bundled CLI brings along (#186). On preToolUse any non-zero exit is a
 * denial, so each of these used to deny the call.
 */
function hostileSource(options: { top?: string; body?: string; effect?: string }): string {
  const effect = options.effect ?? `addContext("hook ran")`;
  const capability = effect.startsWith("block") ? "tool.before.block" : "tool.before.context.add";
  return `import { addContext, block, definePlugin, hook } from "@hooknostic/sdk";
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function readAll() { let data = ""; for await (const chunk of process.stdin) data += chunk; return data; }
    ${options.top ?? ""}
    export default definePlugin({ name: "hostile", hooks: [hook("tool.before", {
      id: "hostile", capabilities: { "${capability}": "required" },
      async run() { ${options.body ?? ""}; return ${effect}; }
    })] });`;
}

describe("Copilot command shim with a hook source that owns the process", () => {
  const CAPS = {
    "tool.before.observe": "exact",
    "tool.before.context.add": "exact",
    "tool.before.block": "exact",
  } as const;
  const REPLY = { additionalContext: "hook ran" };
  const INTERNAL = /^hooknostic internal \[preToolUse\]: /gm;
  // A bundled CLI's main(), reading the stdin the shim already consumed.
  const CLI_MAIN = `async function main() { console.log(JSON.parse(await readAll())); }`;

  async function run(source: string, env: NodeJS.ProcessEnv = {}) {
    return runShim(source, await fixture("tool-before.input.json"), CAPS, undefined, undefined, env);
  }

  it("reports a CLI main() that rejects, once, and still replies", async () => {
    const result = await run(hostileSource({ top: `${CLI_MAIN}\nmain();` }));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(REPLY);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: .+\n/m);
    expect(result.stderr.match(INTERNAL)).toHaveLength(1);
  });

  it("lets the hooks decide when a rejection lands mid-dispatch", async () => {
    const result = await run(
      hostileSource({
        top: `(async () => { await sleep(50); throw new Error("rejected during dispatch"); })();`,
        body: "await sleep(200)",
      }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(REPLY);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: rejected during dispatch\n/m);
  });

  it("keeps a decided denial intact when a rejection lands after it", async () => {
    const result = await run(
      hostileSource({
        top: `(async () => { await sleep(100); throw new Error("rejected after a block"); })();`,
        effect: `block("blocked on purpose")`,
      }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "blocked on purpose",
    });
    expect(result.stderr.match(INTERNAL)).toHaveLength(1);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: rejected after a block\n/m);
  });

  it("reports a timer that throws and still replies", async () => {
    const result = await run(
      hostileSource({ top: `setTimeout(() => { throw new Error("timer threw"); }, 30);`, body: "await sleep(100)" }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(REPLY);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: timer threw\n/m);
  });

  it("reports a top-level process.exit(2) as a load error, and fails open", async () => {
    const result = await run(hostileSource({ top: "process.exit(2);" }));
    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: the hook source called process\.exit\(2\)\n/m);
  });

  it("catches a named exit import from node:process too", async () => {
    const result = await run(hostileSource({ top: `import { exit } from "node:process";\nexit(2);` }));
    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: the hook source called process\.exit\(2\)\n/m);
  });

  it("reports a CLI's main().catch(() => process.exit(1)) once the plugin has loaded", async () => {
    const result = await run(
      hostileSource({ top: `${CLI_MAIN}\nmain().catch(() => process.exit(1));`, body: "await sleep(50)" }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(REPLY);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: the hook source called process\.exit\(1\)\n/m);
  });

  it("reports a handler's process.exit(2) as that handler's error", async () => {
    const result = await run(hostileSource({ body: "process.exit(2)" }));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/^hooknostic \S+ \[hostile\]: the hook source called process\.exit\(2\)$/m);
  });

  it("keeps the decided exit code over a late process.exitCode", async () => {
    const result = await run(hostileSource({ top: "setTimeout(() => { process.exitCode = 2; }, 100);" }));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(REPLY);
  });

  it("reports a strict-mode rejection once", async () => {
    const result = await run(hostileSource({ top: `Promise.reject("plain reason");` }), {
      NODE_OPTIONS: "--unhandled-rejections=strict",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr.match(INTERNAL)).toHaveLength(1);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: plain reason\n/m);
  });

  it("fails open when the hook source's own uncaughtException listener exits", async () => {
    const result = await run(
      hostileSource({
        top: `process.on("uncaughtException", () => process.exit(1));
          setTimeout(() => { throw new Error("timer threw"); }, 30);`,
        body: "await sleep(100)",
      }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: timer threw\n/m);
  });

  it("reports a rejection once when the hook source removed every unhandledRejection listener", async () => {
    const result = await run(
      hostileSource({
        top: `process.removeAllListeners("unhandledRejection");
          Promise.reject(new Error("rejected with no listener left"));`,
      }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(REPLY);
    expect(result.stderr.match(INTERNAL)).toHaveLength(1);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: rejected with no listener left\n/m);
  });

  it("fails open when the hook source prepends an uncaughtException listener that exits", async () => {
    const result = await run(
      hostileSource({
        top: `process.prependListener("uncaughtException", () => process.exit(1));
          setTimeout(() => { throw new Error("timer threw"); }, 30);`,
        body: "await sleep(100)",
      }),
    );
    // It runs ahead of the guard's own listeners; a throw from it is exit 7, a denial.
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: the hook source called process\.exit\(1\)\n/m);
  });

  it("leaves once, with 0, when a beforeExit listener exits under an await that never settles", async () => {
    // runShim's own deadline turns a regression -- the beforeExit loop -- into a failure.
    const result = await run(
      hostileSource({ top: `process.on("beforeExit", () => process.exit(3));\nawait new Promise(() => {});` }),
    );
    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(result.stderr.match(INTERNAL)).toHaveLength(1);
    expect(result.stderr).toMatch(/^hooknostic internal \[preToolUse\]: the hook source called process\.exit\(3\)\n/m);
  });

  it("forces the exit past a leaked handle without reporting its own exit", async () => {
    const result = await run(hostileSource({ top: "setInterval(() => {}, 1_000);" }));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(REPLY);
    expect(result.stderr).not.toMatch(/process\.exit/);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});
