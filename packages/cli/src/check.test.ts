import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { CapabilityProfile } from "@hooknostic/core";
import { makeFakeAdapter } from "@hooknostic/testkit";
import { runCheck } from "./check.js";
import { runCli } from "./cli.js";

const SDK_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../sdk/src/index.ts",
);
const EVALUATE = { alias: { "@hooknostic/sdk": SDK_PATH } };

const fullProfile: CapabilityProfile = {
  range: ">=1.0 <2",
  matrix: {
    "tool.before.observe": { level: "exact" },
    "tool.before.block": { level: "exact" },
    "tool.before.input.replace": { level: "exact" },
    "session.start.observe": { level: "exact" },
    "session.start.context.add": { level: "exact" },
  },
};

const limitedProfile: CapabilityProfile = {
  range: ">=1.0 <2",
  matrix: {
    "tool.before.observe": { level: "exact" },
    "session.start.observe": { level: "exact" },
  },
};

function registry() {
  return {
    alpha: makeFakeAdapter({ id: "alpha", profiles: [fullProfile] }),
    beta: makeFakeAdapter({ id: "beta", profiles: [limitedProfile] }),
  };
}

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function fixtureProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-"));
  tempDirs.push(dir);
  await writeFile(
    join(dir, "hooknostic.config.ts"),
    `
    export default {
      entry: "./hooks.ts",
      targets: {
        alpha: { version: ">=1.0 <2", mode: "plugin", output: "./dist/alpha" },
        beta: { version: ">=1.0 <2", mode: "plugin", output: "./dist/beta" },
      },
    };
    `,
    "utf8",
  );
  await writeFile(
    join(dir, "hooks.ts"),
    `
    import { definePlugin, hook, block } from "@hooknostic/sdk";
    export default definePlugin({
      name: "cli-fixture",
      hooks: [
        hook("tool.before", {
          id: "guard",
          capabilities: { "tool.before.block": "required" },
          async run() { return block("no"); },
        }),
        hook("session.start", { id: "observe-start", async run() {} }),
      ],
    });
    `,
    "utf8",
  );
  return dir;
}

describe("hooknostic check", () => {
  it("fails overall when one target lacks a required capability, passes when narrowed", async () => {
    const dir = await fixtureProject();

    const full = captureIO();
    const fullCode = await runCheck({
      config: join(dir, "hooknostic.config.ts"),
      registry: registry(),
      io: full.io,
      evaluate: EVALUATE,
    });
    expect(fullCode).toBe(1);
    expect(full.out()).toContain("HN201");
    expect(full.out()).toContain("PASS  alpha");
    expect(full.out()).toContain("FAIL  beta");

    const narrowed = captureIO();
    const narrowedCode = await runCheck({
      config: join(dir, "hooknostic.config.ts"),
      targets: ["alpha"],
      registry: registry(),
      io: narrowed.io,
      evaluate: EVALUATE,
    });
    expect(narrowedCode).toBe(0);
    expect(narrowed.out()).toContain("check passed");
  });

  it("emits a machine-readable JSON report", async () => {
    const dir = await fixtureProject();
    const { io, out } = captureIO();
    const code = await runCheck({
      config: join(dir, "hooknostic.config.ts"),
      json: true,
      registry: registry(),
      io,
      evaluate: EVALUATE,
    });
    expect(code).toBe(1);
    const report = JSON.parse(out());
    expect(report).toMatchObject({ schemaVersion: 1, command: "check", ok: false });
    expect(report.targets.alpha.ok).toBe(true);
    expect(report.targets.beta.ok).toBe(false);
    expect(report.targets.alpha.counts.exact).toBe(3);
    expect(
      report.diagnostics.some(
        (d: { code: string; target: string }) => d.code === "HN201" && d.target === "beta",
      ),
    ).toBe(true);
    // resolutions record every capability decision, including implicit observe
    expect(
      report.targets.alpha.resolutions.some(
        (r: { capability: string; requested: string }) =>
          r.capability === "tool.before.observe" && r.requested === "observe",
      ),
    ).toBe(true);
  });

  it("reports config problems as HN501 JSON with exit 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-bad-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "hooknostic.config.ts"), `export default { targets: {} };`, "utf8");
    const { io, out } = captureIO();
    const code = await runCheck({
      config: join(dir, "hooknostic.config.ts"),
      json: true,
      registry: registry(),
      io,
      evaluate: EVALUATE,
    });
    expect(code).toBe(1);
    const report = JSON.parse(out());
    expect(report.ok).toBe(false);
    expect(report.diagnostics[0].code).toBe("HN501");
  });
});

describe("runCli", () => {
  it("prints usage for help and unknown commands", async () => {
    const help = captureIO();
    expect(await runCli(["--help"], { io: help.io })).toBe(0);
    expect(help.out()).toContain("Usage:");

    const unknown = captureIO();
    expect(await runCli(["frobnicate"], { io: unknown.io })).toBe(2);
    expect(unknown.err()).toContain("unknown command");

    const none = captureIO();
    expect(await runCli([], { io: none.io })).toBe(2);
  });

  it("requires a target for inspect", async () => {
    const { io, err } = captureIO();
    expect(await runCli(["inspect"], { io })).toBe(2);
    expect(err()).toContain("requires a target");
  });
});
