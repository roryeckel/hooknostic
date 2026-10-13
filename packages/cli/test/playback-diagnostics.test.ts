import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runProcess } from "./harness-playback.js";
import { createPlaybackDiagnostics } from "./playback-diagnostics.js";

describe("playback timeout diagnostics", () => {
  it("saves child output while a setup command is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-diagnostics-"));
    try {
      const diagnostics = createPlaybackDiagnostics(root, "package-remote");
      const args = [
        "-e",
        "process.stdout.write('packing\\n'); process.stderr.write('waiting\\n'); setInterval(() => {}, 1000)",
      ];
      diagnostics.start("pnpm-pack", { command: process.execPath, args, cwd: root });
      await expect(
        runProcess(process.execPath, args, {
          cwd: root,
          env: process.env,
          timeoutMs: 1000,
          onOutput: (stream, chunk) => diagnostics.output("pnpm-pack", stream, chunk),
        }),
      ).rejects.toThrow("timed out");
      expect(JSON.parse(await readFile(join(root, "current-phase.json"), "utf8"))).toMatchObject({
        phase: "pnpm-pack",
        status: "started",
        command: process.execPath,
        args,
        cwd: root,
      });
      expect(await readFile(join(root, "pnpm-pack.stdout.log"), "utf8")).toBe("packing\n");
      expect(await readFile(join(root, "pnpm-pack.stderr.log"), "utf8")).toBe("waiting\n");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("retains the stalled phase and observations when the driver is killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-diagnostics-"));
    const helper = new URL("./playback-diagnostics.ts", import.meta.url).href;
    const fixture = join(root, "driver.mjs");
    await writeFile(
      fixture,
      `import { createPlaybackDiagnostics } from ${JSON.stringify(helper)};
const diagnostics = createPlaybackDiagnostics(process.argv[2], "package-remote");
await diagnostics.run("npm-install", async () => {
  diagnostics.output("npm-install", "stderr", "install is pending\\n");
  diagnostics.snapshot("model.json", { requests: [], errors: [] });
  process.stdout.write("ready\\n");
  await new Promise(() => { setInterval(() => {}, 1000); });
}, { command: "npm", args: ["install", "--offline"], cwd: process.argv[2] });
`,
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", fixture, root], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Diagnostic driver did not become ready")), 10_000);
        child.once("error", reject);
        child.stdout.on("data", () => {
          clearTimeout(timer);
          resolve();
        });
        child.stderr.resume();
      });
      child.kill();
      await closed;
      expect(JSON.parse(await readFile(join(root, "current-phase.json"), "utf8"))).toMatchObject({
        phase: "npm-install",
        status: "started",
        command: "npm",
        args: ["install", "--offline"],
      });
      expect(await readFile(join(root, "npm-install.stderr.log"), "utf8")).toBe("install is pending\n");
      expect(JSON.parse(await readFile(join(root, "model.json"), "utf8"))).toEqual({ requests: [], errors: [] });
    } finally {
      child.kill();
      await closed;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
