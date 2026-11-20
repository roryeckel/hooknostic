import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { claudeHarness } from "@hooknostic/adapter-claude";
import { opencodeHarness } from "@hooknostic/adapter-opencode";
import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA } from "@hooknostic/agent-plugin";
import type { CapabilityProfile } from "@hooknostic/core";
import { HOOKNOSTIC_VERSION } from "@hooknostic/core";
import { makeFakeAdapter } from "@hooknostic/testkit";

import { runBuild } from "./build.js";
import { runCheck } from "./check.js";
import { CLI_USAGE, COMMAND_FLAGS, COMMAND_POSITIONALS, PARSE_OPTIONS, runCli } from "./cli.js";
import { defaultAdapterRegistry } from "./registry.js";

// Synthetic profiles need a syntactically valid source; provenance is
// meaningless for a fake harness, so one shared stub keeps the noise down.
const SRC: CapabilityProfile["source"] = {
  date: "2026-01-01",
  validatedOn: [{ version: "1.0.0", date: "2026-01-01", method: "doc-derived", what: "synthetic" }],
};

const SDK_PATH = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../sdk/src/index.ts");
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
  it("does not validate or materialize package content when narrowed to a project target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-project-runtime-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "project-runtime-probe" }),
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        project: { root: "." },
        components: {
          root: ".",
          targets: ["claude", "opencode"],
          materialize: [{
            provider: { id: "fixture", plan() { throw new Error("provider was invoked"); } },
            inputs: { lock: "missing.lock" },
            into: "generated/dependencies",
          }],
        },
        targets: {
          claude: { version: "${claudeHarness.recommendedRange}", delivery: "project", output: ".hooknostic/artifacts/claude" },
          opencode: { version: "${opencodeHarness.recommendedRange}", delivery: "package", output: "dist/opencode" },
        },
      };`,
    );
    const capture = captureIO();

    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        targets: ["claude"],
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
      }),
      capture.out(),
    ).toBe(0);
    expect(JSON.parse(capture.out()).diagnostics).toEqual([]);
  });

  it("does not defer a materialized command when the same components also use project delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-mixed-materialized-command-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "mixed-materialized-command" }),
    );
    await writeFile(join(dir, "packages.lock"), "locked fixture\n");
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { generated: { type: "stdio", command: "./generated/bin/server" } },
      }),
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        project: { root: "." },
        components: {
          root: ".",
          targets: ["claude", "opencode"],
          materialize: [{
            provider: { id: "fixture", plan() { throw new Error("provider was invoked"); } },
            inputs: { lock: "packages.lock" },
            into: "generated",
          }],
        },
        targets: {
          claude: { version: "${claudeHarness.recommendedRange}", delivery: "project", output: ".hooknostic/artifacts/claude" },
          opencode: { version: "${opencodeHarness.recommendedRange}", delivery: "package", output: "dist/opencode" },
        },
      };`,
    );
    const capture = captureIO();

    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
      }),
    ).toBe(2);
    const report = JSON.parse(capture.out());
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN503", severity: "error" }));
    expect(report.diagnostics.map((diagnostic: { message: string }) => diagnostic.message).join("\n")).not.toContain(
      "provider was invoked",
    );
  });

  it("does not invoke a materializer before capability analysis succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-runtime-analysis-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "runtime-analysis-probe" }),
    );
    await writeFile(join(dir, "packages.lock"), "locked fixture\n");
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook, preventStop } from "@hooknostic/sdk";
       export default definePlugin({
         name: "runtime-analysis-probe",
         hooks: [hook("turn.stop", {
           id: "keep-going",
           capabilities: { "turn.stop.prevent": "required" },
           async run() { return preventStop("more to do"); },
         })],
       });`,
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        components: {
          root: ".",
          materialize: [{
            provider: { id: "fixture", plan() { throw new Error("provider was invoked"); } },
            inputs: { lock: "packages.lock" },
            into: "runtime/dependencies",
          }],
        },
        targets: {
          opencode: { version: "${opencodeHarness.recommendedRange}", delivery: "package", output: "dist/opencode" },
        },
      };`,
    );
    const capture = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: EVALUATE,
      }),
    ).toBe(2);

    const diagnostics = JSON.parse(capture.out()).diagnostics as { code: string; message: string }[];
    expect(diagnostics.some((diagnostic) => diagnostic.code === "HN201")).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.code === "HN501")).toBe(false);
  });

  it("marks targets unsuccessful when package materialization fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-materialize-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "materialize-probe" }),
    );
    await writeFile(join(dir, "packages.lock"), "locked fixture\n");
    await writeFile(join(dir, "hooks.ts"), `export default { name: "materialize-probe", hooks: [] };`);
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        components: {
          root: ".",
          materialize: [{
            provider: { id: "fixture", plan() { return { command: "hooknostic-missing-materializer", args: [] }; } },
            inputs: { lock: "packages.lock" },
            into: "runtime/dependencies",
          }],
        },
        targets: {
          opencode: { version: "${opencodeHarness.recommendedRange}", delivery: "package", output: "dist/opencode" },
        },
      };`,
    );

    const checkCapture = captureIO();
    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: checkCapture.io,
        evaluate: EVALUATE,
      }),
    ).toBe(2);
    const checkReport = JSON.parse(checkCapture.out());
    expect(checkReport.targets.opencode.ok).toBe(false);
    expect(checkReport.diagnostics).toContainEqual(expect.objectContaining({ code: "HN501" }));

    const buildCapture = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        registry: defaultAdapterRegistry(),
        io: buildCapture.io,
        evaluate: EVALUATE,
      }),
    ).toBe(2);
    expect(buildCapture.out()).toMatch(/FAIL\s+opencode/);
    expect(buildCapture.out()).not.toContain("BUILT  opencode");
  });

  it("reports an excluded direct MCP source as HN503", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-excluded-mcp-"));
    tempDirs.push(dir);
    await writeFile(join(dir, ".env"), "{}");
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        project: { root: "." },
        components: { mcp: "./.env" },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "project", output: ".hooknostic/artifacts/claude" } },
      };`,
    );
    const capture = captureIO();

    expect(
      await runCheck({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
      }),
    ).toBe(2);

    expect(JSON.parse(capture.out()).diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN503", severity: "error" }),
    );
  });

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
      report.diagnostics.some((d: { code: string; target: string }) => d.code === "HN201" && d.target === "beta"),
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
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN205", target: "noproj" }));
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
    await writeFile(
      join(dir, "runtime.package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }),
    );
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

    // check writes no target artifacts, even on the success path.
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

  it("reports a config whose getter throws as HN501, not an unexpected error (#199)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-throwing-config-"));
    tempDirs.push(dir);
    const config = join(dir, "hooknostic.config.ts");
    await writeFile(
      config,
      `export default { entry: "./hooks.ts", get targets() { throw new Error("targets getter"); } };`,
      "utf8",
    );
    const { io, out } = captureIO();
    // Exit 2 either way: the report's shape is what changed.
    await runCli(["check", "--config", config, "--json"], { registry: registry(), io });
    const report = JSON.parse(out());
    expect(report.errors).toBeUndefined();
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "HN501",
        message: `failed to load config ${config}: reading its default export threw: targets getter`,
      }),
    ]);
  });

  it.each([
    ["config", "hooknostic.config.ts"],
    ["hook source", "hooks.ts"],
  ])("prints where a schema imported from the SDK's root moved, from the %s (#247)", async (_, file) => {
    const dir = await fixtureProject();
    await writeFile(join(dir, "hooks.ts"), `export default { name: "p", hooks: [] };`);
    const path = join(dir, file);
    const source =
      file === "hooks.ts"
        ? `export default { name: "p", hooks: [] };`
        : `export default { entry: "./hooks.ts", targets: { alpha: { version: ">=1.0 <2", delivery: "package", output: "./dist" } } };`;
    await writeFile(
      path,
      `import { targetConfigSchema } from "@hooknostic/sdk";\nconsole.log(targetConfigSchema);\n${source}`,
    );
    if (file === "hooks.ts")
      await writeFile(
        join(dir, "hooknostic.config.ts"),
        `export default { entry: "./hooks.ts", targets: { alpha: { version: ">=1.0 <2", delivery: "package", output: "./dist" } } };`,
      );
    const { io, out, err } = captureIO();
    expect(
      await runCheck({ config: join(dir, "hooknostic.config.ts"), registry: registry(), io, evaluate: EVALUATE }),
    ).toBe(2);
    expect(out()).toBe("");
    expect(err()).toMatch(/^HN501 invalid configuration \[error\]\n/);
    expect(err()).toContain(`failed to load ${file === "hooks.ts" ? "entry" : "config"} ${path}: `);
    expect(err()).toContain(
      "\n\n  Remediation: the SDK's schemas moved from @hooknostic/sdk to @hooknostic/sdk/schemas in 0.13.0: " +
        'import { targetConfigSchema } from "@hooknostic/sdk/schemas" instead. ' +
        "See https://github.com/roryeckel/hooknostic/blob/master/docs/upgrading/sdk-schemas-subpath.md.",
    );
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
    await writeFile(join(dir, "hooks.ts"), `export default { name: "empty-targets", hooks: [] };`, "utf8");

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

  it("reports a target named __proto__ as HN501 instead of dropping it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-proto-target-"));
    tempDirs.push(dir);
    const config = join(dir, "hooknostic.config.ts");
    await writeFile(
      config,
      `export default {
        entry: "./hooks.ts",
        targets: { ["__proto__"]: { adapter: "alpha", version: ">=1 <2", delivery: "project", output: "./out" } },
      };`,
      "utf8",
    );
    await writeFile(join(dir, "hooks.ts"), `export default { name: "proto-target", hooks: [] };`, "utf8");

    for (const run of [runCheck, runBuild]) {
      const capture = captureIO();
      expect(await run({ config, json: true, registry: registry(), io: capture.io, evaluate: EVALUATE })).toBe(2);
      const diagnostics = JSON.parse(capture.out()).diagnostics as { code: string; message: string }[];
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HN501",
          message: expect.stringContaining('invalid configuration: targets.__proto__: "__proto__" cannot be used'),
        }),
      );
      expect(diagnostics.map((diagnostic) => diagnostic.message)).not.toContainEqual(
        expect.stringContaining("no targets"),
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
        registry: {
          ...defaultAdapterRegistry(),
          opencode: {
            ...defaultAdapterRegistry().opencode!,
            resolveTarget: (target) => {
              const selected = defaultAdapterRegistry().opencode!.resolveTarget!(target);
              return { ...selected, adapter: { ...selected.adapter!, supportedDeliveries: () => ["project"] } };
            },
          },
        },
        io: capture.io,
        evaluate: EVALUATE,
      }),
    ).toBe(2);
    const diagnostics = JSON.parse(capture.out()).diagnostics as {
      code: string;
      message: string;
      remediation?: string;
    }[];
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

  // In place of a command, as --help is: the version alone, and whatever
  // follows is ignored (#246).
  it.each([[["--version"]], [["-v"]], [["--version", "--json"]], [["-v", "doctor", "--config", "missing.ts"]]])(
    "prints this hooknostic's version alone for %j",
    async (argv) => {
      const { io, out, err } = captureIO();
      expect(await runCli(argv, { io })).toBe(0);
      expect(out()).toBe(HOOKNOSTIC_VERSION);
      expect(err()).toBe("");
    },
  );

  it("documents -v, --version beside inspect's --version <range>", () => {
    const lines = CLI_USAGE.split("\n");
    const own = lines.findIndex((line) => line.trimStart().startsWith("-v, --version "));
    expect(own, "a -v, --version line in CLI_USAGE").toBeGreaterThanOrEqual(0);
    expect(lines[own]).toContain("in place of a command");
    expect(lines[own + 1]?.trimStart()).toMatch(/^--version <range> +Harness version range for inspect$/);
  });

  it("leaves --version <range> after inspect to inspect", async () => {
    const { io, out, err } = captureIO();
    expect(await runCli(["inspect", "claude", "--version", claudeHarness.recommendedRange], { io })).toBe(0);
    expect(out()).not.toBe(HOOKNOSTIC_VERSION);
    expect(out()).toContain(`harness range ${claudeHarness.recommendedRange}`);
    expect(err()).toBe("");
  });

  // Ahead of the options' checks, so a target given as --target, or a flag
  // inspect does not take, still gets the message that names the mistake (#255).
  it.each([[["inspect"]], [["inspect", "--json"]], [["inspect", "--target", "claude"]], [["inspect", "--local"]]])(
    "requires a target for %j",
    async (argv) => {
      const { io, out, err } = captureIO();
      expect(await runCli(argv, { io })).toBe(2);
      expect(err()).toBe("inspect requires a target, e.g. `hooknostic inspect claude`.");
      expect(out()).toBe("");
    },
  );

  // The commands that load a config, or write, when they get past their
  // checks: init scaffolds beside its config and sync reconciles a project.
  const LOADS = new Set(["check", "build", "init", "sync", "verify", "recover", "doctor"]);

  /**
   * `argv` with a fresh temp --config right after such a command, so a check
   * that regressed acts on an empty temp directory, never the checkout. Run
   * with `registry: {}` and assert the directory still empty.
   */
  async function isolated(argv: string[]): Promise<{ argv: string[]; dir: string | undefined }> {
    const [command, ...rest] = argv;
    if (command === undefined || !LOADS.has(command)) return { argv, dir: undefined };
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-usage-"));
    tempDirs.push(dir);
    return { argv: [command, "--config", join(dir, "hooknostic.config.ts"), ...rest], dir };
  }

  it.each(["check", "build"])("rejects an empty --target for %s", async (command) => {
    for (const value of ["", ", ,"]) {
      const { io, err } = captureIO();
      const run = await isolated([command, "--target", value]);
      expect(await runCli(run.argv, { io, registry: {} })).toBe(2);
      expect(err()).toContain("at least one non-empty target");
      expect(await readdir(run.dir as string)).toEqual([]);
    }
  });

  // A mistake in the command line is a usage error, not the catch-all's
  // "unexpected error" with a stack (#208).
  it.each([
    [["build", "--dry-run"], "--dry-run is only supported by sync"],
    [["check", "--dry-run"], "--dry-run is only supported by sync"],
    [["verify", "--dry-run"], "--dry-run is only supported by sync"],
    [["recover", "--dry-run"], "--dry-run is only supported by sync"],
    [["doctor", "--dry-run"], "--dry-run is only supported by sync"],
    [["init", "--local", "--dry-run"], "--dry-run is only supported by sync"],
    [["inspect", "claude", "--dry-run"], "--dry-run is only supported by sync"],
    [["dispatch", "--target", "claude", "--dry-run"], "--dry-run is only supported by sync"],
    [["dispatch", "--json"], "--json is not supported by dispatch, which always writes JSON Lines"],
    // Text, not usage()'s JSON line, even with another usage error (#218).
    [
      ["dispatch", "--target", "claude", "--dry-run", "--json"],
      "--json is not supported by dispatch, which always writes JSON Lines",
    ],
    [["check", "--unguarded"], "--unguarded is only supported by dispatch"],
    [["sync", "--unguarded"], "--unguarded is only supported by dispatch"],
    [["inspect", "claude", "--unguarded"], "--unguarded is only supported by dispatch"],
    [["init"], "init requires --local"],
    [["inspect", "claude", "--delivery", "foo"], "--delivery must be project or package"],
    // Which option a command takes is one table (#255). dispatch's --json
    // still comes first (#218); the other options in their declaration order,
    // not the command line's.
    [
      ["dispatch", "--target", "claude", "--capability", "x", "--json"],
      "--json is not supported by dispatch, which always writes JSON Lines",
    ],
    [["check", "--dry-run", "--local"], "--dry-run is only supported by sync"],
    [["check", "--local", "--dry-run"], "--dry-run is only supported by sync"],
    [
      ["doctor", "--version", "1.0"],
      `--version <range> is only supported by inspect; run "hooknostic --version" for this hooknostic's version`,
    ],
    // Present though empty; check and build keep their own message for it.
    [["sync", "--target", ""], "--target is not supported by sync"],
    // --dry-run and --unguarded are checked first, for any command, as they
    // were before the table: each command line they rejected keeps its message.
    [["check", "--local", "--unguarded"], "--unguarded is only supported by dispatch"],
    [["inspect", "--dry-run"], "--dry-run is only supported by sync"],
    [["inspect", "--unguarded"], "--unguarded is only supported by dispatch"],
    [["frobnicate", "--dry-run"], "--dry-run is only supported by sync"],
    // Otherwise an unknown command is that, whatever its options.
    [["frobnicate", "--local"], 'unknown command "frobnicate"'],
    [["frobnicate", "extra"], 'unknown command "frobnicate"'],
    // Stray words: inspect takes its target, and no command anything else.
    [["sync", "extra"], 'unexpected argument "extra": sync takes no positional arguments'],
    [["sync", "--dry-run", "false"], 'unexpected argument "false": sync takes no positional arguments'],
    [
      ["dispatch", "--target", "claude", "extra"],
      'unexpected argument "extra": dispatch takes no positional arguments',
    ],
    [["inspect", "claude", "extra"], 'unexpected argument "extra": inspect takes one target'],
    [["inspect", "claude", "extra", "more"], 'unexpected argument "extra": inspect takes one target'],
    [["check", "--", "--json"], 'unexpected argument "--json": check takes no positional arguments'],
    // An option the command does not take, ahead of a word it does not either.
    [["check", "--local", "extra"], "--local is only supported by init"],
  ])("reports %j as a usage error", async (argv, message) => {
    const { io, out, err } = captureIO();
    const run = await isolated(argv);
    expect(await runCli(run.argv, { io, registry: {} })).toBe(2);
    expect(err()).toBe(`${message}\n${CLI_USAGE}`);
    expect(err()).not.toContain("unexpected error");
    expect(err()).not.toMatch(/^\s+at /m);
    expect(out()).toBe("");
    if (run.dir !== undefined) expect(await readdir(run.dir)).toEqual([]);
  });

  it.each([
    [["build", "--dry-run", "--json"], "--dry-run is only supported by sync"],
    [["inspect", "claude", "--events", "f", "--json"], "--events is only supported by dispatch"],
    [["check", "extra", "--json"], 'unexpected argument "extra": check takes no positional arguments'],
    // As before the table: the JSON line, ahead of inspect's missing target
    // and of an unknown command.
    [["inspect", "--dry-run", "--json"], "--dry-run is only supported by sync"],
    [["inspect", "--unguarded", "--json"], "--unguarded is only supported by dispatch"],
    [["frobnicate", "--unguarded", "--json"], "--unguarded is only supported by dispatch"],
  ])("keeps a usage error's JSON line under --json for %j (#208, #255)", async (argv, message) => {
    const { io, out, err } = captureIO();
    const run = await isolated(argv);
    expect(await runCli(run.argv, { io, registry: {} })).toBe(2);
    if (run.dir !== undefined) expect(await readdir(run.dir)).toEqual([]);
    expect(JSON.parse(out())).toStrictEqual({
      schemaVersion: 1,
      command: argv[0],
      ok: false,
      errors: [message],
    });
    expect(out()).not.toContain("\n");
    expect(err()).toBe("");
  });

  // inspect's selectors are one option group in the usage, and inspect itself
  // refuses two of them: the table accepts each, and leaves that to inspect.
  it("leaves inspect's mutually exclusive selectors to inspect", async () => {
    const { io, out, err } = captureIO();
    const argv = ["inspect", "claude", "--capability", "tool.before.observe", "--field", "turn.stop.lastMessage"];
    expect(await runCli(argv, { io })).toBe(2);
    expect(`${out()}\n${err()}`).toContain("--capability, --component and --field are mutually exclusive.");
    expect(`${out()}\n${err()}`).not.toMatch(/is (only|not) supported by/);
  });
});

// Which command takes which option and how many words (#255). The
// expectations are written out here by hand, so a change to the CLI's table
// cannot carry its own tests along; only the first test reads the table, and
// only to hold it to the documented usage.
describe("the options and words each command takes", () => {
  const FLAGS = [
    "dry-run",
    "local",
    "target",
    "capability",
    "component",
    "field",
    "delivery",
    "events",
    "version",
    "unguarded",
    "json",
  ] as const;
  type TestFlag = (typeof FLAGS)[number];

  // --config is taken by every command, and given to every run below.
  const ACCEPTED: Record<string, TestFlag[]> = {
    check: ["target", "json"],
    build: ["target", "json"],
    init: ["local", "json"],
    sync: ["dry-run", "json"],
    verify: ["json"],
    recover: ["json"],
    doctor: ["json"],
    inspect: ["capability", "component", "field", "version", "delivery", "json"],
    dispatch: ["target", "events", "unguarded"],
  };
  const REJECTED: Record<string, TestFlag[]> = {
    check: ["dry-run", "local", "capability", "component", "field", "delivery", "events", "version", "unguarded"],
    build: ["dry-run", "local", "capability", "component", "field", "delivery", "events", "version", "unguarded"],
    init: ["dry-run", "target", "capability", "component", "field", "delivery", "events", "version", "unguarded"],
    sync: ["local", "target", "capability", "component", "field", "delivery", "events", "version", "unguarded"],
    verify: [
      "dry-run",
      "local",
      "target",
      "capability",
      "component",
      "field",
      "delivery",
      "events",
      "version",
      "unguarded",
    ],
    recover: [
      "dry-run",
      "local",
      "target",
      "capability",
      "component",
      "field",
      "delivery",
      "events",
      "version",
      "unguarded",
    ],
    doctor: [
      "dry-run",
      "local",
      "target",
      "capability",
      "component",
      "field",
      "delivery",
      "events",
      "version",
      "unguarded",
    ],
    inspect: ["dry-run", "local", "target", "events", "unguarded"],
    dispatch: ["dry-run", "local", "capability", "component", "field", "delivery", "version", "json"],
  };
  const COMMANDS = Object.keys(ACCEPTED);

  // The flags only one command takes, in the words of #208 and #218.
  const ONLY: Partial<Record<TestFlag, string>> = {
    "dry-run": "--dry-run is only supported by sync",
    local: "--local is only supported by init",
    capability: "--capability is only supported by inspect",
    component: "--component is only supported by inspect",
    field: "--field is only supported by inspect",
    delivery: "--delivery is only supported by inspect",
    events: "--events is only supported by dispatch",
    unguarded: "--unguarded is only supported by dispatch",
    version: `--version <range> is only supported by inspect; run "hooknostic --version" for this hooknostic's version`,
  };
  function rejection(command: string, flag: TestFlag): string {
    if (command === "dispatch" && flag === "json")
      return "--json is not supported by dispatch, which always writes JSON Lines";
    if (flag === "target") return `--target is not supported by ${command}`;
    const message = ONLY[flag];
    if (message === undefined) throw new Error(`no expected message for --${flag}`);
    return message;
  }

  /**
   * Run `command` against a missing config in a fresh temp directory, with
   * what the command needs to get past its own first check, then `flag` (once:
   * not again when those already give it), then `words`. Nothing reads stdin,
   * spawns a harness, or writes outside the directory; init writes beside the
   * config.
   */
  async function run(command: string, flag: TestFlag | undefined, words: string[] = []) {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-cli-flags-"));
    tempDirs.push(dir);
    const events = join(dir, "missing.jsonl");
    const required: Record<string, string[]> = {
      init: ["--local"],
      inspect: ["claude"],
      dispatch: ["--target", "claude", "--events", events],
    };
    const values: Partial<Record<TestFlag, string>> = {
      target: "claude",
      capability: "x",
      component: "x",
      field: "x",
      delivery: "project",
      version: "*",
      events,
    };
    const given = required[command] ?? [];
    const option = flag === undefined || given.includes(`--${flag}`) ? [] : [`--${flag}`];
    const value = option.length > 0 && flag !== undefined && values[flag] !== undefined ? [values[flag]] : [];
    const argv = [command, ...given, ...option, ...value, ...words, "--config", join(dir, "hooknostic.config.ts")];
    const { io, out, err } = captureIO();
    const code = await runCli(argv, { io, registry: {} });
    return { argv, code, out: out(), err: err(), dir };
  }

  it("partitions every option for every command, 29 taken and 79 refused", () => {
    for (const command of COMMANDS) {
      const accepted = ACCEPTED[command] ?? [];
      const rejected = REJECTED[command] ?? [];
      expect([...accepted, ...rejected].sort(), command).toEqual([...FLAGS].sort());
    }
    expect(COMMANDS.length * (FLAGS.length + 1)).toBe(108);
    // --config, taken by all nine, plus the rest.
    expect(COMMANDS.length + Object.values(ACCEPTED).flat().length).toBe(29);
    expect(Object.values(REJECTED).flat().length).toBe(79);
  });

  it("holds the table to each command's usage line", () => {
    const lines = CLI_USAGE.split("\n").filter((line) => /^ {2}hooknostic \w/.test(line));
    const flags: Record<string, string[]> = {};
    const words: Record<string, number> = {};
    for (const line of lines) {
      const [, command, rest] = /^ {2}hooknostic (\w+)(.*)$/.exec(line) ?? [];
      if (command === undefined || rest === undefined) throw new Error(line);
      flags[command] = [...rest.matchAll(/--([a-z-]+)/g)].map((match) => match[1] as string).sort();
      // A <placeholder> that is not an option's value is a positional.
      const tokens = rest
        .replace(/[[\]|]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      words[command] = tokens.filter((token, at) => token.startsWith("<") && !tokens[at - 1]?.startsWith("--")).length;
    }
    expect(Object.keys(flags).sort()).toEqual([...COMMANDS].sort());
    expect(
      Object.fromEntries(Object.entries(COMMAND_FLAGS).map(([command, set]) => [command, [...set].sort()])),
    ).toEqual(flags);
    expect(COMMAND_POSITIONALS).toEqual(words);
    // The flat table cannot say inspect's selectors are alternatives; the
    // usage does, and inspect enforces it (see the test above).
    expect(CLI_USAGE).toContain("[--capability <id> | --component <id> | --field <id>]");
  });

  // An option parsed but in no command's set would be refused everywhere;
  // one added beside --help would be checked nowhere.
  it("parses no option the table does not cover", () => {
    const parsed = Object.keys(PARSE_OPTIONS).filter((name) => name !== "help");
    const tabled = new Set(Object.values(COMMAND_FLAGS).flatMap((set) => [...set]));
    expect([...parsed].sort()).toEqual([...tabled].sort());
    // And each is described under Options, not only on a usage line.
    const options = CLI_USAGE.slice(CLI_USAGE.indexOf("\nOptions:\n"));
    const described = new Set([...options.matchAll(/^ {2}(?:-\w, )?--([a-z-]+)/gm)].map((match) => match[1]));
    expect(parsed.filter((name) => !described.has(name))).toEqual([]);
  });

  // The rows above cover every option the parser takes, so an option added
  // to the CLI, even everywhere it belongs, needs rows here too. In the
  // order they are checked in, which decides the message for two at once.
  it("covers every option the parser takes, in its order", () => {
    expect(Object.keys(PARSE_OPTIONS).filter((name) => name !== "help")).toEqual(["config", ...FLAGS]);
  });

  it.each(COMMANDS.flatMap((command) => (ACCEPTED[command] ?? []).map((flag) => [command, flag] as const)))(
    "%s takes --%s",
    async (command, flag) => {
      const { argv, out, err } = await run(command, flag);
      const output = `${out}\n${err}`;
      // It may still fail, for the missing config or events file, but not
      // over the command line.
      expect(output, argv.join(" ")).not.toMatch(/is (only|not) supported by|unexpected argument/);
      expect(output, argv.join(" ")).not.toContain(CLI_USAGE);
      if (flag !== "json")
        for (const line of out.split("\n")) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          expect(value, argv.join(" ")).not.toMatchObject({ schemaVersion: 1, ok: false });
        }
    },
  );

  it.each(COMMANDS.flatMap((command) => (REJECTED[command] ?? []).map((flag) => [command, flag] as const)))(
    "%s refuses --%s as a usage error, before doing anything",
    async (command, flag) => {
      const { argv, code, out, err, dir } = await run(command, flag);
      expect(code, argv.join(" ")).toBe(2);
      expect(err, argv.join(" ")).toBe(`${rejection(command, flag)}\n${CLI_USAGE}`);
      expect(err).not.toContain("unexpected error");
      expect(err).not.toMatch(/^\s+at /m);
      expect(out).toBe("");
      // Nothing written: init in particular never ran.
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it.each(COMMANDS)("%s refuses a stray word as a usage error, before doing anything", async (command) => {
    const { argv, code, out, err, dir } = await run(command, undefined, ["extra"]);
    const message =
      command === "inspect"
        ? 'unexpected argument "extra": inspect takes one target'
        : `unexpected argument "extra": ${command} takes no positional arguments`;
    expect(code, argv.join(" ")).toBe(2);
    expect(err, argv.join(" ")).toBe(`${message}\n${CLI_USAGE}`);
    expect(out).toBe("");
    expect(await readdir(dir)).toEqual([]);
  });
});

// `inspect --config` reports a config that fails to load as HN501, through
// the diagnostics printer, as `check` does (#208).
describe("inspect --config with a config that fails to load", () => {
  const configs: [string, string | undefined, string][] = [
    ["is missing", undefined, "failed to load config <path>: "],
    [
      "fails the schema",
      `export default { entry: "./hooks.ts", targets: { claude: { adapter: "claude" } } };`,
      "invalid configuration: targets.claude.version",
    ],
    ["throws at top level", `throw new Error("boom");`, "failed to load config <path>: boom"],
    [
      "declares no targets",
      `export default { entry: "./hooks.ts", targets: {} };`,
      "configuration declares no targets.",
    ],
  ];

  async function configFile(source: string | undefined): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-inspect-config-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "hooks.ts"), `export default { name: "inspect-config", hooks: [] };`);
    const path = join(dir, "hooknostic.config.ts");
    if (source !== undefined) await writeFile(path, source);
    return path;
  }

  it.each(configs)("prints HN501 when the config %s", async (_, source, detail) => {
    const path = await configFile(source);
    const { io, out, err } = captureIO();
    expect(await runCli(["inspect", "claude", "--config", path], { io })).toBe(2);
    expect(err()).toMatch(/^HN501 invalid configuration \[error\]\n/);
    expect(err()).toContain(detail.replace("<path>", path));
    expect(err()).toContain("Remediation:");
    expect(err()).not.toContain("unexpected error");
    expect(err()).not.toMatch(/^\s+at /m);
    expect(out()).toBe("");
  });

  it.each(configs)("reports HN501 under --json when the config %s", async (_, source, detail) => {
    const path = await configFile(source);
    const { io, out, err } = captureIO();
    expect(await runCli(["inspect", "claude", "--config", path, "--json"], { io })).toBe(2);
    const report = JSON.parse(out());
    expect(report).toMatchObject({ schemaVersion: 1, command: "inspect", ok: false });
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect(report.diagnostics.every((d: { code: string }) => d.code === "HN501")).toBe(true);
    expect(report.errors).toStrictEqual(
      report.diagnostics.map((d: { code: string; message: string }) => `${d.code}: ${d.message}`),
    );
    expect(report.errors.join("\n")).toContain(detail.replace("<path>", path));
    expect(report.errors[0]).toMatch(/^HN501: /);
    expect(out()).not.toContain("unexpected error");
    expect(err()).toBe("");
  });
});
