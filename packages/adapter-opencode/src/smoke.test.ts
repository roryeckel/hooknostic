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
import { opencodeHarness } from "./harness.js";
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
// Separate from SMOKE_DIR so the stop test's loop-guard sentinel lives in a
// directory that test itself wipes; sharing one leaves a stale sentinel that
// silently short-circuits the hook on every subsequent run.
const STOP_DIR = join(REPO, ".capture", "opencode-stop-smoke");
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

const STOP_HOOKS_SOURCE = `
import { definePlugin, hook, notify, preventStop } from "@hooknostic/sdk";
import { existsSync, writeFileSync } from "node:fs";

// Self-limiting on purpose. preventStop posts a prompt, which drives another
// turn, which fires session.idle again -- an unconditional hook would loop until
// the test times out. OpenCode has no stop_hook_active flag and no block cap, so
// the terminating condition has to live in the hook.
const SENTINEL = ${JSON.stringify(join(STOP_DIR, "stop-fired").replaceAll("\\", "/"))};

export default definePlugin({
  name: "stop-smoke",
  hooks: [
    hook("turn.stop", {
      id: "smoke-notice",
      capabilities: { "turn.stop.notify": "optional" },
      async run(_event, ctx) {
        if (existsSync(SENTINEL)) return;
        if (!ctx.capabilities.has("turn.stop.notify")) return;
        return notify("hooknostic-notice");
      },
    }),
    hook("turn.stop", {
      id: "smoke-continue",
      capabilities: { "turn.stop.prevent": "required" },
      async run() {
        if (existsSync(SENTINEL)) return;
        writeFileSync(SENTINEL, "", "utf8");
        return preventStop("Reply with the single word hooknostic-continued.");
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
      // PWD must agree with cwd: opencode 1.18.25 trusts the inherited PWD
      // env var over the process working directory, and a vitest parented by
      // a bash-like shell exports PWD = repo root -- opencode then creates a
      // SECOND instance there and runs the session in it, where no plugins
      // exist. Hooks silently absent; verified live 2026-08-30.
      env: { ...process.env, PWD: options.cwd },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      // Tree-kill, not child.kill(): with shell:true on Windows the handle is
      // cmd.exe, and this wraps a 280s live `opencode run` whose orphan would
      // hold the scratch directory for every later run.
      void stopProcessTree(child);
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

/**
 * Windows holds directory handles briefly after a process exits, and an
 * `opencode serve` orphaned by an earlier run holds this one outright — so a
 * plain rm fails with EBUSY and takes the test with it. Same transient-lock
 * class the output commit path already retries.
 */
async function removeScratch(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Terminate a whole process tree.
 *
 * On Windows these children are spawned through a shell, so the handle is
 * `cmd.exe`, not the harness: `kill()` leaves the real process orphaned,
 * holding its port, scratch directory and inherited pipes — which fails the
 * next run and can hang Vitest on open handles.
 */
function stopProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill();
    return Promise.resolve();
  }
  return new Promise<void>((resolvePromise) => {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on(
      "close",
      () => resolvePromise(),
    );
  });
}

/** Tree-kill a server and wait for it to actually go away. */
async function stopServer(server: ReturnType<typeof spawn>): Promise<void> {
  const exited = new Promise<void>((resolvePromise) => server.on("close", () => resolvePromise()));
  await stopProcessTree(server);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
}

describe.skipIf(!enabled)("OpenCode smoke (real harness)", () => {
  it(
    "block and input rewrite function in a live session",
    { timeout: 300_000 },
    async () => {
      await removeScratch(SMOKE_DIR);
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
          harnessVersion: opencodeHarness.referenceVersion,
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
        { id: "opencode", version: opencodeHarness.recommendedRange, mode: "local", output: SMOKE_DIR },
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

  it(
    "stop prevention drives another turn in a live session",
    { timeout: 300_000 },
    async () => {
      const dir = STOP_DIR;
      await removeScratch(dir);
      await mkdir(dir, { recursive: true });
      await runCommand("git", ["init"], { cwd: dir, timeoutMs: 30_000 });
      await writeFile(join(dir, "hooks.ts"), STOP_HOOKS_SOURCE, "utf8");

      const levels = Object.fromEntries(
        Object.entries(opencodeCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]),
      );
      const bundle = await bundleRuntime({
        source: opencodeShimEntrySource({
          entryImportPath: join(dir, "hooks.ts").replaceAll("\\", "/"),
          capabilities: levels,
          // turn.stop.observe is approximate on OpenCode (an aborted turn fires
          // session.idle twice) and the default floor is emulated, so without
          // this an OpenCode turn.stop hook cannot dispatch at all.
          minimumCapabilityLevel: "approximate",
          policy: {
            onHookError: "continue",
            timeoutMs: 5000,
            contextCharLimit: 16_000,
            notifyCharLimit: 2_000,
          },
          // Deliberately a literal, newer than referenceVersion: this probe
          // exercised a later build than the fixture capture.
          harnessVersion: "1.18.25",
        }),
        resolveDir: dir,
        alias: ALIAS,
      });

      const { ir } = buildPluginIR(
        definePlugin({
          name: "stop-smoke",
          hooks: [hook("turn.stop", { id: "smoke-continue", async run() {} })],
        }),
      );
      for (const artifact of generateOpenCodeArtifacts(
        ir!,
        { id: "opencode", version: opencodeHarness.recommendedRange, mode: "local", output: dir },
        bundle,
      )) {
        const target = join(dir, artifact.path);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, artifact.contents, "utf8");
      }

      // `opencode run` cannot observe this: it exits at session.idle, before a
      // posted turn can start. A persistent server is the only vehicle.
      const port = 47411;
      const server = spawn("opencode", ["serve", "--port", String(port)], {
        cwd: dir,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const base = `http://127.0.0.1:${port}`;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          try {
            if ((await fetch(`${base}/app`)).ok) break;
          } catch {
            /* not listening yet */
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        const session = (await (
          await fetch(`${base}/session`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).json()) as { id: string };

        await fetch(`${base}/session/${session.id}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerID: MODEL.split("/")[0], modelID: MODEL.split("/")[1] },
            parts: [{ type: "text", text: "Say the single word ready, then stop." }],
          }),
        });

        // The post happens during session.idle, which resolves only after the
        // prompt request returns; give the driven turn room to run.
        await new Promise((r) => setTimeout(r, 45_000));

        const messages = (await (
          await fetch(`${base}/session/${session.id}/message`)
        ).json()) as { info?: { role?: string }; parts?: { type?: string; text?: string }[] }[];
        const rendered = messages.map((m) => ({
          role: m.info?.role,
          text: (m.parts ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(" "),
        }));

        // preventStop posted a prompt and the agent answered it — a turn that
        // would not exist had the stop been allowed to stand.
        expect(rendered.filter((m) => m.role === "assistant").length).toBeGreaterThan(1);
        expect(rendered.some((m) => m.text?.includes("hooknostic-continued"))).toBe(true);
        // notify posted with noReply, so it is present without a turn of its own.
        expect(rendered.some((m) => m.text?.includes("hooknostic-notice"))).toBe(true);
      } finally {
        await stopServer(server);
      }
    },
  );
});
