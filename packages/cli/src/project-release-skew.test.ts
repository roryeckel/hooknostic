import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { expect, it } from "vitest";

import { HOOKNOSTIC_VERSION } from "@hooknostic/core";

import { runCli } from "./cli.js";

const REPO = resolve(import.meta.dirname, "../../..");

it("warns HN110 from sync and verify without failing either (#194)", { timeout: 120_000 }, async () => {
  // The local-project example outside the workspace, with a registry-style
  // copy of the built SDK from another release.
  const other = "0.11.9";
  expect(other).not.toBe(HOOKNOSTIC_VERSION);
  const root = await mkdtemp(join(tmpdir(), "hooknostic-cli-skew-"));
  try {
    await cp(join(REPO, "examples/local-project"), root, {
      recursive: true,
      filter: (src) => basename(src) !== "node_modules",
    });
    const sdk = join(root, "node_modules/@hooknostic/sdk");
    // What the package publishes ("files"), so the bundler finds its notice.
    await cp(join(REPO, "packages/sdk/dist"), join(sdk, "dist"), { recursive: true });
    await cp(join(REPO, "packages/sdk/LICENSE"), join(sdk, "LICENSE"));
    const manifest = JSON.parse(await readFile(join(REPO, "packages/sdk/package.json"), "utf8")) as object;
    await writeFile(join(sdk, "package.json"), JSON.stringify({ ...manifest, version: other }, null, 2));

    const config = join(root, "hooknostic.config.ts");
    for (const command of ["sync", "verify"]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli([command, "--config", config], {
        io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      });
      const output = [...out, ...err].join("\n");
      expect(code, output).toBe(0);
      expect(output).toContain(`HN110 warn: this hooknostic is ${HOOKNOSTIC_VERSION}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
