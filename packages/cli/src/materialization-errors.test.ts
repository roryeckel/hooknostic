import type * as fsPromises from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA } from "@hooknostic/agent-plugin";

import { runBuild } from "./build.js";
import { runCheck } from "./check.js";
import { defaultAdapterRegistry } from "./registry.js";

const materializationFs = vi.hoisted(() => ({
  failCreate: false,
  failCleanup: false,
  staging: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    async mkdtemp(prefix: string, options?: BufferEncoding | { encoding?: BufferEncoding }) {
      if (prefix.includes("hooknostic-materialize-") && materializationFs.failCreate) {
        throw Object.assign(new Error("synthetic temporary-directory failure"), { code: "EACCES" });
      }
      const path = await actual.mkdtemp(prefix, options);
      if (prefix.includes("hooknostic-materialize-")) materializationFs.staging.add(path);
      return path;
    },
    async rm(path: string, options?: Parameters<typeof actual.rm>[1]) {
      if (materializationFs.staging.delete(path) && materializationFs.failCleanup) {
        await actual.rm(path, options);
        throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
      }
      return await actual.rm(path, options);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  materializationFs.failCreate = false;
  materializationFs.failCleanup = false;
  materializationFs.staging.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function captureIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) },
    stdout: () => stdout.join("\n"),
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-materialization-errors-"));
  roots.push(root);
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "materialization-errors" }),
  );
  await writeFile(join(root, "packages.lock"), "locked\n");
  await writeFile(
    join(root, "hooknostic.config.ts"),
    `export default {
      components: {
        root: ".",
        materialize: [{
          provider: {
            id: "fixture",
            plan() { return { command: process.execPath, args: ["-e", ""] }; },
          },
          inputs: { lock: "packages.lock" },
          into: "generated",
        }],
      },
      targets: {
        opencode: { version: ">=1.18 <2", delivery: "package", output: "dist/opencode" },
      },
    };`,
  );
  return join(root, "hooknostic.config.ts");
}

describe("materialization staging diagnostics", () => {
  it("returns structured HN301 from check when the temporary directory cannot be created", async () => {
    const config = await fixture();
    materializationFs.failCreate = true;
    const capture = captureIO();

    await expect(runCheck({ config, json: true, registry: defaultAdapterRegistry(), io: capture.io })).resolves.toBe(2);
    const report = JSON.parse(capture.stdout());
    expect(report.targets.opencode.ok).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN301",
        severity: "error",
        message: expect.stringContaining("temporary staging setup"),
      }),
    );
  });

  it("returns structured HN301 from build when the temporary directory cannot be created", async () => {
    const config = await fixture();
    materializationFs.failCreate = true;
    const capture = captureIO();

    await expect(runBuild({ config, json: true, registry: defaultAdapterRegistry(), io: capture.io })).resolves.toBe(2);
    const report = JSON.parse(capture.stdout());
    expect(report.targets.opencode.status).toBe("failed");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN301",
        severity: "error",
        message: expect.stringContaining("temporary staging setup"),
      }),
    );
  });

  it("reports cleanup failure as a nonfatal warning", async () => {
    const config = await fixture();
    materializationFs.failCleanup = true;
    const capture = captureIO();

    await expect(runCheck({ config, json: true, registry: defaultAdapterRegistry(), io: capture.io })).resolves.toBe(0);
    const report = JSON.parse(capture.stdout());
    expect(report.targets.opencode.ok).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN301",
        severity: "warn",
        message: expect.stringContaining("could not remove temporary materialization directory"),
      }),
    );
  });
});
