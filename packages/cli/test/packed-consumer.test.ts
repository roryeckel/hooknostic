import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { defaultAdapterRegistry } from "../src/registry.js";
import { runProcess } from "./harness-playback.js";

it.skipIf(process.env["HOOKNOSTIC_PACK"] !== "1")(
  "installs actual pnpm tarballs and compiles a clean consumer",
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-packed-consumer-"));
    try {
      const consumer = join(dir, "consumer");
      await mkdir(consumer);
      for (const packageName of ["agent-plugin", "sdk", "cli"]) {
        const packed = await runProcess("pnpm", ["pack", "--pack-destination", dir], {
          cwd: join(root, "packages", packageName),
          env: process.env,
          timeoutMs: 60_000,
        });
        expect(packed.code, packed.stdout + packed.stderr).toBe(0);
      }
      const tarballs = (await readdir(dir)).filter((file) => file.endsWith(".tgz")).map((file) => join(dir, file));
      expect(tarballs).toHaveLength(3);
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify({ name: "launch-consumer", private: true, type: "module" }),
      );
      const installed = await runProcess(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
        { cwd: consumer, env: process.env, timeoutMs: 120_000 },
      );
      expect(installed.code, installed.stdout + installed.stderr).toBe(0);
      for (const name of ["hooknostic", "@hooknostic/sdk", "@hooknostic/agent-plugin"]) {
        const pkg = join(consumer, "node_modules", name);
        const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
        if (name === "hooknostic") expect(manifest.bin?.hooknostic).toBe("./bin/hooknostic.mjs");
        expect(JSON.stringify(manifest.dependencies ?? {})).not.toMatch(/workspace:|catalog:/);
        expect(await readFile(join(pkg, "README.md"), "utf8")).not.toBe("");
        expect(await readFile(join(pkg, "LICENSE"), "utf8")).toContain("Apache");
      }
      const cli = join(consumer, "node_modules/hooknostic/bin/hooknostic.mjs");
      const run = async (args: string[]) => {
        const result = await runProcess(process.execPath, [cli, ...args], {
          cwd: consumer,
          env: process.env,
          timeoutMs: 60_000,
        });
        expect(result.code, result.stdout + result.stderr).toBe(0);
      };
      await run(["init", "--local"]);
      await run(["check"]);
      await run(["sync"]);
      await run(["verify"]);
      // Components-only package delivery exercises the loader from the installed CLI.
      await mkdir(join(consumer, "portable/skills/hello"), { recursive: true });
      await writeFile(
        join(consumer, "portable/plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "launch-consumer",
          version: "1.0.0",
        }),
      );
      await writeFile(
        join(consumer, "portable/skills/hello/SKILL.md"),
        "---\nname: hello\ndescription: Say hello.\n---\nSay hello.\n",
      );
      await writeFile(
        join(consumer, "package.config.ts"),
        `export default ${JSON.stringify({ components: { root: "portable" }, targets: { claude: { version: defaultAdapterRegistry().claude!.harness.recommendedRange, delivery: "package", output: "dist/claude" } } })};`,
      );
      await run(["build", "--config", "package.config.ts"]);
      expect(await readFile(join(consumer, "dist/claude/skills/hello/SKILL.md"), "utf8")).toContain("Say hello.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
