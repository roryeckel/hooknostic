import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { CapabilityProfile } from "@hooknostic/core";
import { makeFakeAdapter } from "@hooknostic/testkit";
import { runBuild } from "./build.js";
import { runCheck } from "./check.js";
import { runCli } from "./cli.js";
import { defaultAdapterRegistry } from "./registry.js";
import { claudeHarness } from "@hooknostic/adapter-claude";
import { opencodeHarness } from "@hooknostic/adapter-opencode";
import { AGENT_PLUGIN_MANIFEST_SCHEMA } from "@hooknostic/agent-plugin";

// Synthetic profiles need a syntactically valid source; provenance is
// meaningless for a fake harness, so one shared stub keeps the noise down.
const SRC: CapabilityProfile["source"] = {
  date: "2026-01-01",
  validatedOn: [
    { version: "1.0.0", date: "2026-01-01", method: "doc-derived", what: "synthetic" },
  ],
};

const SDK_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../sdk/src/index.ts",
);
const EVALUATE = { alias: { "@hooknostic/sdk": SDK_PATH } };

const fullProfile: CapabilityProfile = {
  range: ">=1.0 <2",
  source: SRC,
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
  source: SRC,
  matrix: {
    "tool.before.observe": { level: "exact" },
    "session.start.observe": { level: "exact" },
  },
};

// `check` runs the whole generation pipeline (bundling included), so even
// analysis-focused fakes need a shim entry or they stop at HN301.
function registry() {
  return {
    alpha: makeFakeAdapter({ id: "alpha", profiles: [fullProfile], shimEntry: "export {};" }),
    beta: makeFakeAdapter({ id: "beta", profiles: [limitedProfile], shimEntry: "export {};" }),
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
        alpha: { version: ">=1.0 <2", delivery: "package", output: "./dist/alpha" },
        beta: { version: ">=1.0 <2", delivery: "package", output: "./dist/beta" },
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
    expect(fullCode).toBe(2);
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
    expect(code).toBe(2);
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

  it("marks a target failed in JSON when Agent Plugin projection fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-projection-check-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "projection-check" }),
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        components: { root: ".", targets: ["noproj"] },
        targets: {
          noproj: { version: ">=1.0 <2", delivery: "package", output: "./dist/noproj" },
        },
      };`,
    );

    const capture = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: {
          // Every shipped adapter now has a projector, so the projector-less
          // case only exists as a double.
          noproj: makeFakeAdapter({ id: "noproj", profiles: [fullProfile], shimEntry: "export {};" }),
        },
        io: capture.io,
      }),
    ).toBe(2);
    const report = JSON.parse(capture.out());
    expect(report.ok).toBe(false);
    expect(report.targets.noproj.ok).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", target: "noproj" }),
    );
  });

  it("runs projection so overlay collisions and runtime package defects fail check, not just build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-check-preflight-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "com.anthropic.claude-code/runtime"), { recursive: true });
    await writeFile(join(dir, "com.anthropic.claude-code/runtime/hooknostic.mjs"), "native collision");
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "preflight" }),
    );
    await writeFile(join(dir, "runtime.package.json"), JSON.stringify({ dependencies: { "is-number": "7.0.0" } }));
    await writeFile(join(dir, "runtime.package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "preflight", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    const config = (runtimePackage: string) =>
      `export default {
        entry: "./hooks.ts",
        components: { root: ".", targets: ["claude"]${runtimePackage} },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } },
      };`;

    // Overlay collision with the generated runtime path: only the projector sees it.
    await writeFile(join(dir, "hooknostic.config.ts"), config(""));
    const collision = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: collision.io,
        evaluate: EVALUATE,
      }),
    ).toBe(2);
    const collisionReport = JSON.parse(collision.out());
    expect(collisionReport.targets.claude.ok).toBe(false);
    expect(collisionReport.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN503", target: "claude", message: expect.stringContaining("collides") }),
    );

    // A manifest/lockfile pair that would fail at install time.
    await rm(join(dir, "com.anthropic.claude-code"), { recursive: true });
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      config(', runtimePackage: { manifest: "./runtime.package.json", lockfile: "./runtime.package-lock.json" }'),
    );
    const lockfile = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        registry: defaultAdapterRegistry(),
        io: lockfile.io,
        evaluate: EVALUATE,
      }),
    ).toBe(2);
    expect(lockfile.out()).toContain("root dependencies do not match the manifest");
    expect(lockfile.out()).toContain("FAIL  claude");

    // check writes nothing, even on the success path.
    await rm(join(dir, "runtime.package.json"));
    await rm(join(dir, "runtime.package-lock.json"));
    await writeFile(join(dir, "hooknostic.config.ts"), config(""));
    const clean = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: clean.io,
        evaluate: EVALUATE,
      }),
      clean.out(),
    ).toBe(0);
    const cleanReport = JSON.parse(clean.out());
    expect(cleanReport.targets.claude.ok).toBe(true);
    expect(cleanReport.targets.claude.projection).toMatchObject({ status: "success" });
    expect(cleanReport.targets.claude.artifacts).toEqual(
      expect.arrayContaining([".claude-plugin/plugin.json", "hooks/hooks.json", "runtime/hooknostic.mjs"]),
    );
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(existsSync(join(dir, "hooknostic-build.json"))).toBe(false);
    expect((await readdir(dir)).filter((name) => name.startsWith(".hooknostic-"))).toEqual([]);
  });

  it("fails a runtime dependency that needs an install script until it is named in allowInstallScripts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-check-scripts-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "scripted" }),
    );
    await writeFile(join(dir, "runtime.package.json"), JSON.stringify({ dependencies: { native: "1.0.0" } }));
    await writeFile(
      join(dir, "runtime.package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { native: "1.0.0" } },
          "node_modules/native": { version: "1.0.0", hasInstallScript: true },
        },
      }),
    );
    const config = (allow: string) =>
      `export default {
        components: {
          root: ".",
          targets: ["claude"],
          runtimePackage: { manifest: "./runtime.package.json", lockfile: "./runtime.package-lock.json"${allow} },
        },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } },
      };`;

    await writeFile(join(dir, "hooknostic.config.ts"), config(""));
    const rejected = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: rejected.io,
      }),
    ).toBe(2);
    expect(JSON.parse(rejected.out()).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN503",
        target: "claude",
        message: expect.stringContaining("npm ci --ignore-scripts"),
      }),
    );

    // The opt-out is per package and carries no other meaning: the script still
    // never runs, the author has just taken responsibility for this one.
    await writeFile(join(dir, "hooknostic.config.ts"), config(', allowInstallScripts: ["native"]'));
    const allowed = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: allowed.io,
      }),
      allowed.out(),
    ).toBe(0);
  });

  it("prints FAIL when output-layout validation fails after capability analysis", async () => {
    const dir = await fixtureProject();
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        targets: {
          alpha: { version: ">=1.0 <2", delivery: "package", output: "." },
        },
      };`,
    );

    const capture = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        registry: registry(),
        io: capture.io,
        evaluate: EVALUATE,
      }),
    ).toBe(2);
    expect(capture.out()).toContain("HN501");
    expect(capture.out()).toContain("FAIL  alpha");
    expect(capture.out()).not.toContain("PASS  alpha");
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
    expect(code).toBe(2);
    const report = JSON.parse(out());
    expect(report.ok).toBe(false);
    expect(report.diagnostics[0].code).toBe("HN501");
  });

  it("keeps empty project targets invalid for ordinary check and build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-empty-targets-"));
    tempDirs.push(dir);
    const config = join(dir, "hooknostic.config.ts");
    await writeFile(
      config,
      `export default {
        project: { root: "." },
        entry: "./hooks.ts",
        targets: {},
      };`,
      "utf8",
    );
    await writeFile(
      join(dir, "hooks.ts"),
      `export default { name: "empty-targets", hooks: [] };`,
      "utf8",
    );

    for (const run of [runCheck, runBuild]) {
      const capture = captureIO();
      expect(
        await run({
          config,
          json: true,
          registry: registry(),
          io: capture.io,
          evaluate: EVALUATE,
        }),
      ).toBe(2);
      expect(JSON.parse(capture.out()).diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HN501",
          message: expect.stringContaining("no targets"),
        }),
      );
    }
  });

  it("reports unsupported deliveries before generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-mode-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        targets: { opencode: { version: "${opencodeHarness.recommendedRange}", delivery: "package", output: "./dist" } },
      };`,
      "utf8",
    );
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "mode", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
      "utf8",
    );
    const capture = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: { ...defaultAdapterRegistry(), opencode: { ...defaultAdapterRegistry().opencode!, supportedDeliveries: () => ["project"] } },
        io: capture.io,
        evaluate: EVALUATE,
      }),
    ).toBe(2);
    const diagnostics = JSON.parse(capture.out()).diagnostics as { code: string; message: string; remediation?: string }[];
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN204",
        target: "opencode",
        message: 'target "opencode" delivery "package" is unsupported by adapter "opencode".',
        remediation: "use one of the supported deliveries: project.",
      }),
    );
    // "before generation": the delivery is rejected during analysis, so no
    // generation- or commit-phase diagnostic can appear alongside it.
    expect(diagnostics.filter((d) => d.code.startsWith("HN3"))).toEqual([]);
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

  it.each(["check", "build"])("rejects an empty --target for %s", async (command) => {
    for (const value of ["", ", ,"]) {
      const { io, err } = captureIO();
      expect(await runCli([command, "--target", value], { io })).toBe(2);
      expect(err()).toContain("at least one non-empty target");
    }
  });
});
