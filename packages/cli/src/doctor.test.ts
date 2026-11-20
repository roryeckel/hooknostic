import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { claudeHarness } from "@hooknostic/adapter-claude";
import { codexAdapter, codexHarness } from "@hooknostic/adapter-codex";
import { opencodeAdapter, opencodeHarness, opencodeV2Harness } from "@hooknostic/adapter-opencode";
import { type HarnessAdapter, HOOKNOSTIC_VERSION, runProject } from "@hooknostic/core";
import { makeFakeAdapter } from "@hooknostic/testkit";

import { doctorVersionLine, resolveOnPath, runDoctor } from "./doctor.js";
import { defaultAdapterRegistry } from "./registry.js";

const REPO = resolve(import.meta.dirname, "../../..");

/** `text` as a regular expression matching it literally. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fakeIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    out,
    err,
  };
}

function adapterDetecting(version: string | undefined): HarnessAdapter {
  const base = makeFakeAdapter({
    id: "fake",
    profiles: [
      {
        range: ">=1.0 <2",
        matrix: { "session.start.observe": { level: "exact" } },
        source: {
          date: "2026-01-01",
          validatedOn: [
            {
              version: "1.2.0",
              date: "2026-01-15",
              method: "captured",
              what: "synthetic capture",
            },
          ],
        },
      },
    ],
    harness: {
      displayName: "Fake",
      recommendedRange: ">=1.2 <2",
      fixtureDir: "fake",
      referenceVersion: "1.2.0",
    },
  });
  return {
    ...base,
    async detect() {
      return version === undefined ? { installed: false } : { installed: true, version };
    },
  };
}

async function statusFor(installed: string | undefined): Promise<Record<string, unknown>> {
  const { io, out } = fakeIO();
  await runDoctor({ json: true, registry: { fake: adapterDetecting(installed) }, io });
  const payload = JSON.parse(out.join("")) as { harnesses: Record<string, unknown>[] };
  return payload.harnesses[0]!;
}

describe("doctor version comparison", () => {
  it.each([
    [opencodeHarness.referenceVersion, opencodeHarness.recommendedRange],
    [opencodeV2Harness.referenceVersion, opencodeV2Harness.recommendedRange],
  ])("uses the installed OpenCode family for unconfigured doctor (%s)", async (version, recommendedRange) => {
    const detect = vi.fn(async () => ({ installed: true, version }));
    const { io, out } = fakeIO();
    expect(await runDoctor({ json: true, registry: { opencode: { ...opencodeAdapter(), detect } }, io })).toBe(0);
    const report = JSON.parse(out.join(""));
    expect(report.harnesses).toHaveLength(1);
    expect(report.harnesses[0]).toMatchObject({
      adapter: "opencode",
      version,
      status: "ok",
      recommendedRange,
    });
    expect(detect).toHaveBeenCalledOnce();
  });

  it("keeps the v2 default when OpenCode is absent, unknown or outside both families", async () => {
    for (const detection of [{ installed: false }, { installed: true }, { installed: true, version: "3.0.0" }]) {
      const detect = vi.fn(async () => detection);
      const { io, out } = fakeIO();
      await runDoctor({ json: true, registry: { opencode: { ...opencodeAdapter(), detect } }, io });
      const report = JSON.parse(out.join(""));
      expect(report.harnesses).toHaveLength(1);
      expect(report.harnesses[0].recommendedRange).toBe(opencodeV2Harness.recommendedRange);
      expect(report.harnesses[0].validatedRanges).toEqual([opencodeV2Harness.recommendedRange]);
      expect(detect).toHaveBeenCalledOnce();
    }
  });

  it("keeps a configured v1 target on v1 when the installed binary is v2", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-doctor-opencode-family-"));
    try {
      const configPath = join(root, "hooknostic.config.ts");
      await writeFile(join(root, "hooks.ts"), 'export default { name: "doctor-family", hooks: [] };');
      await writeFile(
        configPath,
        `export default { entry: "./hooks.ts", targets: { legacy: { adapter: "opencode", version: ${JSON.stringify(opencodeHarness.recommendedRange)}, delivery: "package", output: "dist" } } };`,
      );
      const detect = vi.fn(async () => ({ installed: true, version: opencodeV2Harness.referenceVersion }));
      const { io, out } = fakeIO();
      await runDoctor({ config: configPath, json: true, registry: { opencode: { ...opencodeAdapter(), detect } }, io });
      const report = JSON.parse(out.join(""));
      expect(report.harnesses).toHaveLength(1);
      expect(report.harnesses[0]).toMatchObject({
        recommendedRange: opencodeHarness.recommendedRange,
        version: opencodeV2Harness.referenceVersion,
        status: "newer-than-validated",
      });
      expect(detect).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports ok inside the recommended range", async () => {
    expect(await statusFor("1.3.0")).toMatchObject({ status: "ok", recommendedRange: ">=1.2 <2" });
  });

  it("distinguishes validated-but-outside-recommended from outside-validated", async () => {
    // 1.1.0 satisfies the validated ">=1.0 <2" but not the recommended
    // ">=1.2 <2" -- its own advisory, previously indistinguishable from ok.
    expect(await statusFor("1.1.0")).toMatchObject({ status: "outside-recommended" });
    expect(await statusFor("0.9.0")).toMatchObject({ status: "outside-validated" });
    expect(await statusFor("3.0.0")).toMatchObject({ status: "newer-than-validated" });
  });

  it("reports the newest validated build so OUR staleness is visible", async () => {
    const entry = await statusFor("1.5.0");
    expect(entry["newestValidated"]).toMatchObject({ version: "1.2.0", method: "captured" });
    // Human output carries the drift note for an in-range-but-newer install.
    const { io, out } = fakeIO();
    await runDoctor({ registry: { fake: adapterDetecting("1.5.0") }, io });
    expect(out.join("\n")).toContain("newer than the newest validated build (1.2.0");
    expect(out.join("\n")).toContain("docs/harness-support.md");
  });

  it("keeps not-detected reporting intact", async () => {
    expect(await statusFor(undefined)).toMatchObject({ status: "not-detected", installed: false });
  });

  it("accepts a clean empty-target project cleanup state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-doctor-empty-"));
    try {
      const configPath = join(root, "hooknostic.config.ts");
      await writeFile(join(root, "hooks.ts"), `export default { name: "empty-project", hooks: [] };`);
      await writeFile(configPath, `export default { project: { root: "." }, entry: "./hooks.ts", targets: {} };`);
      expect((await runProject({ command: "sync", configPath, registry: {} })).ok).toBe(true);

      const { io, out } = fakeIO();
      expect(await runDoctor({ config: configPath, json: true, registry: {}, io })).toBe(0);
      const payload = JSON.parse(out.join(""));
      expect(payload.configurationErrors).toEqual([]);
      expect(payload.project).toMatchObject({ ok: true, drift: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["toString", "__proto__"])(
    "reports adapter %s, inherited from Object.prototype, as unregistered (#195)",
    async (adapter) => {
      const root = await mkdtemp(join(tmpdir(), "hooknostic-doctor-inherited-"));
      try {
        const configPath = join(root, "hooknostic.config.ts");
        await writeFile(join(root, "hooks.ts"), `export default { name: "inherited-adapter", hooks: [] };`);
        await writeFile(
          configPath,
          `export default { entry: "./hooks.ts", targets: { claude: { adapter: ${JSON.stringify(adapter)}, version: ${JSON.stringify(claudeHarness.recommendedRange)}, delivery: "package", output: "dist" } } };`,
        );
        const { io, out } = fakeIO();
        expect(await runDoctor({ config: configPath, json: true, registry: defaultAdapterRegistry(), io })).toBe(2);
        const payload = JSON.parse(out.join(""));
        expect(payload.configurationErrors).toContain('no adapter is registered for target "claude".');
        // The diagnostic itself too, remediation included (#260).
        expect(payload.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "HN501",
            severity: "error",
            message: 'no adapter is registered for target "claude".',
            remediation: expect.stringContaining("available adapters"),
          }),
        );

        // Printed as `check` prints it (#260).
        const human = fakeIO();
        expect(await runDoctor({ config: configPath, registry: defaultAdapterRegistry(), io: human.io })).toBe(2);
        const err = human.err.join("\n");
        expect(err).toMatch(/^HN501 invalid configuration \[error\]$/m);
        expect(err).toContain('\n  no adapter is registered for target "claude".\n');
        expect(err).toContain("\n  Remediation: available adapters: ");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("lists a config that fails to load as a diagnostic, beside its unchanged configuration error (#260)", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-doctor-load-failure-"));
    try {
      const configPath = join(root, "hooknostic.config.ts");
      await writeFile(configPath, `throw new Error("boom");\n`);
      const failure = `failed to load config ${configPath}: boom`;

      const machine = fakeIO();
      expect(await runDoctor({ config: configPath, json: true, registry: {}, io: machine.io })).toBe(2);
      const payload = JSON.parse(machine.out.join(""));
      expect(payload.configurationErrors).toEqual([failure]);
      expect(payload.diagnostics).toEqual([
        expect.objectContaining({
          code: "HN501",
          severity: "error",
          message: failure,
          remediation: expect.stringContaining("defineConfig"),
        }),
      ]);

      const human = fakeIO();
      expect(await runDoctor({ config: configPath, registry: {}, io: human.io })).toBe(2);
      // One block, with no blank line after it: nothing follows on stderr.
      expect(human.err).toEqual([expect.stringMatching(/^HN501 /)]);
      const err = human.err.join("\n");
      expect(err).toMatch(/^HN501 invalid configuration \[error\]$/m);
      expect(err).toContain(`\n  ${failure}\n`);
      expect(err).toContain(
        "\n  Remediation: the config must be a TypeScript module whose default export is defineConfig({...}).",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports Codex wiring synchronized into a linked worktree as HN107, naming the root checkout", async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "hooknostic-doctor-worktree-")));
    try {
      const main = join(scratch, "main");
      await mkdir(main);
      await writeFile(
        join(main, "hooks.ts"),
        // What definePlugin/hook return, spelled out: doctor loads without an SDK alias.
        `export default { name: "worktree-doctor", hooks: [{ event: "tool.before", id: "guard", match: { kind: "shell" }, capabilities: {}, async run() {} }] };`,
      );
      await writeFile(
        join(main, "hooknostic.config.ts"),
        `export default { project: { root: "." }, entry: "./hooks.ts", targets: { codex: { version: "${codexHarness.recommendedRange}", delivery: "project", output: ".hooknostic/artifacts/codex" } } };`,
      );
      const git = (cwd: string, args: string[]) => {
        const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
        expect(result.status, result.stderr).toBe(0);
      };
      git(main, ["init", "--quiet"]);
      git(main, ["add", "."]);
      git(main, [
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Synthetic doctor worktree fixture",
      ]);
      const linked = join(scratch, "linked");
      git(main, ["worktree", "add", "--detach", "--quiet", linked, "HEAD"]);
      // No detect(): doctor must not depend on a Codex install for this report.
      const { detect: _detect, ...codex } = codexAdapter();
      const registry = { codex };
      const configPath = join(linked, "hooknostic.config.ts");
      expect((await runProject({ command: "sync", configPath, registry })).errors).toEqual([]);

      const human = fakeIO();
      await runDoctor({ config: configPath, registry, io: human.io });
      // Printed as `check` prints it, with the remediation that is its advice (#260).
      const warning = human.out.join("\n");
      expect(warning).toMatch(/^HN107 .* \[warn\]$/m);
      expect(warning).toContain(`root checkout ${main}`);
      expect(warning).toContain(join(main, ".codex", "hooks.json"));
      expect(warning).toContain(
        "\n  Remediation: The generated wiring takes effect once it is present, and trusted, in ",
      );

      const machine = fakeIO();
      await runDoctor({ config: configPath, json: true, registry, io: machine.io });
      const payload = JSON.parse(machine.out.join(""));
      expect(payload.project.diagnostics).toEqual([
        expect.objectContaining({ code: "HN107", severity: "warn", target: "codex" }),
      ]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

// The versions a bug report needs, from doctor (#246).
describe("doctor versions", () => {
  const EMPTY_PROJECT = `{ project: { root: "." }, entry: "./hooks.ts", targets: {} }`;

  /**
   * A synced project with an empty-target config, which `config` then
   * replaces; `sdk` is the manifest of its node_modules/@hooknostic/sdk.
   */
  async function projectWith(sdk: Record<string, unknown> | undefined, config?: string) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hooknostic-doctor-versions-")));
    const configPath = join(root, "hooknostic.config.ts");
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "hooks.ts"), `export default { name: "doctor-versions", hooks: [] };`);
    await writeFile(configPath, `export default ${EMPTY_PROJECT};`);
    if (sdk !== undefined) {
      const directory = join(root, "node_modules/@hooknostic/sdk");
      await mkdir(join(directory, "dist"), { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ exports: { ".": "./dist/index.js" }, ...sdk }));
      await writeFile(join(directory, "dist/index.js"), "export {};\n");
    }
    // Synced, so doctor's exit code is the project's: current, 0.
    expect((await runProject({ command: "sync", configPath, registry: {} })).ok).toBe(true);
    if (config !== undefined) await writeFile(configPath, config);
    return { root, configPath };
  }

  /** Sets the version in the manifest of the SDK that {@link projectWith} installed. */
  async function setSdkVersion(root: string, version: string) {
    await writeFile(
      join(root, "node_modules/@hooknostic/sdk/package.json"),
      JSON.stringify({ exports: { ".": "./dist/index.js" }, name: "@hooknostic/sdk", version }),
    );
  }

  const SKEWED_SDK = { name: "@hooknostic/sdk", version: "0.0.1-test" };
  /** Doctor's HN110 for {@link SKEWED_SDK}, as the JSON's top-level `diagnostics` carries it. */
  const SKEW = expect.objectContaining({
    code: "HN110",
    severity: "warn",
    message: expect.stringMatching(
      new RegExp(`^this hooknostic is ${literal(HOOKNOSTIC_VERSION)}, .* is 0\\.0\\.1-test, `),
    ),
  });
  /** Doctor's HN110 as its text output prints it, as `check` does (#260). */
  const SKEW_LINE = new RegExp(
    `^HN110 CLI and project SDK on different releases \\[warn\\]\\n\\n  this hooknostic is ${literal(HOOKNOSTIC_VERSION)}, `,
  );
  /** The configuration errors that doctor's JSON also lists, after its own HN110 (#260). */
  const configurationDiagnostics = (payload: { configurationErrors: string[] }) =>
    payload.configurationErrors.map((message) =>
      expect.objectContaining({ code: "HN501", severity: "error", message }),
    );
  const PACKAGE_TARGET = `claude: { version: ${JSON.stringify(claudeHarness.recommendedRange)}, delivery: "package", output: "dist" }`;

  // Each mode doctor reported HN110 in only through a build it filtered to
  // errors, or not at all (#257). registry {}: no harness entry decides the
  // exit code, so each row's code is its configuration's.
  it.each([
    ["a project config without targets", `export default ${EMPTY_PROJECT};`, 0, true],
    [
      "a project config with only package targets",
      `export default { project: { root: "." }, entry: "./hooks.ts", targets: { ${PACKAGE_TARGET} } };`,
      2,
      true,
    ],
    ["a package config", `export default { entry: "./hooks.ts", targets: { ${PACKAGE_TARGET} } };`, 2, false],
    // No project, so empty targets are rejected: HN501.
    ["a config rejected for having no targets", `export default { entry: "./hooks.ts", targets: {} };`, 2, false],
    ["a config that fails to load", "export default {;\n", 2, false],
  ])("warns HN110 for %s, without changing the exit code (#257)", async (_, config, code, project) => {
    const { root, configPath } = await projectWith(SKEWED_SDK, config);
    try {
      const skewed = fakeIO();
      expect(await runDoctor({ config: configPath, json: true, registry: {}, io: skewed.io })).toBe(code);
      const payload = JSON.parse(skewed.out.join(""));
      // Each failing row's configuration error follows HN110 there (#260).
      expect(payload.configurationErrors.length > 0).toBe(code === 2);
      expect(payload.diagnostics).toEqual([SKEW, ...configurationDiagnostics(payload)]);
      // Doctor's own: verify builds no project target here, so its report has no HN110.
      if (project) expect(payload.project.diagnostics).toEqual([]);
      else expect(payload.project).toBeUndefined();

      const human = fakeIO();
      expect(await runDoctor({ config: configPath, registry: {}, io: human.io })).toBe(code);
      expect(human.out[1]).toMatch(SKEW_LINE);
      expect(human.out.filter((line) => line.startsWith("HN110 "))).toHaveLength(1);

      await setSdkVersion(root, HOOKNOSTIC_VERSION);
      const matching = fakeIO();
      expect(await runDoctor({ config: configPath, json: true, registry: {}, io: matching.io })).toBe(code);
      const matched = JSON.parse(matching.out.join(""));
      expect(matched.diagnostics).toEqual(configurationDiagnostics(matched));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the SDK beside a relative --config, not beside the current directory (#257)", async () => {
    const { root, configPath } = await projectWith(SKEWED_SDK);
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "hooknostic-doctor-cwd-")));
    const previous = process.cwd();
    try {
      process.chdir(elsewhere);
      const machine = fakeIO();
      const config = relative(elsewhere, configPath);
      expect(isAbsolute(config)).toBe(false);
      expect(await runDoctor({ config, json: true, registry: {}, io: machine.io })).toBe(0);
      const payload = JSON.parse(machine.out.join(""));
      expect(payload.runtime.sdk).toStrictEqual({ status: "found", version: "0.0.1-test" });
      expect(payload.diagnostics).toEqual([SKEW]);
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("reports this hooknostic and Node.js without a config, and no SDK", async () => {
    const machine = fakeIO();
    await runDoctor({ json: true, registry: { fake: adapterDetecting("1.3.0") }, io: machine.io });
    const payload = JSON.parse(machine.out.join(""));
    expect(payload.schemaVersion).toBe(2);
    expect(payload.runtime).toStrictEqual({ node: process.version, hooknostic: HOOKNOSTIC_VERSION });
    expect(payload.diagnostics).toEqual([]);

    const human = fakeIO();
    await runDoctor({ registry: { fake: adapterDetecting("1.3.0") }, io: human.io });
    expect(human.out[0]).toBe(`hooknostic ${HOOKNOSTIC_VERSION} (Node.js ${process.version})`);
  });

  it.each([
    ["found", { name: "@hooknostic/sdk", version: "0.0.1-test" }, { status: "found", version: "0.0.1-test" }],
    ["not-found", undefined, { status: "not-found" }],
    ["unidentified", { name: "@hooknostic/sdk" }, { status: "unidentified" }],
  ])("reports the project's SDK as %s, without changing the exit code", async (_, sdk, release) => {
    const { root, configPath } = await projectWith(sdk);
    try {
      const machine = fakeIO();
      expect(await runDoctor({ config: configPath, json: true, registry: {}, io: machine.io })).toBe(0);
      expect(JSON.parse(machine.out.join("")).runtime).toStrictEqual({
        node: process.version,
        hooknostic: HOOKNOSTIC_VERSION,
        sdk: release,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [{ status: "found", version: "0.0.1-test" } as const, "project @hooknostic/sdk 0.0.1-test"],
    [{ status: "not-found" } as const, "project @hooknostic/sdk not found"],
    [
      { status: "unidentified" } as const,
      "project @hooknostic/sdk version unknown: the resolved package's manifest isn't @hooknostic/sdk's or has no version",
    ],
    [
      { status: "not-looked-up", reason: "another-pnp-runtime" } as const,
      "project @hooknostic/sdk not looked up under another install's Plug'n'Play runtime",
    ],
    [
      {
        status: "not-looked-up",
        reason: "outside-pnp-runtime",
        manifest: join(process.cwd(), "app", ".pnp.cjs"),
      } as const,
      `project @hooknostic/sdk not looked up: ${join("app", ".pnp.cjs")} is a Yarn Plug'n'Play manifest, and this process isn't running under Yarn's runtime`,
    ],
    [
      {
        status: "not-looked-up",
        reason: "outside-pnp-runtime",
        manifest: resolve(process.cwd(), "..", "elsewhere", ".pnp.cjs"),
      } as const,
      `project @hooknostic/sdk not looked up: ${resolve(process.cwd(), "..", "elsewhere", ".pnp.cjs")} is a Yarn Plug'n'Play manifest, and this process isn't running under Yarn's runtime`,
    ],
  ])("words the project's SDK in the version line (%j)", (sdk, text) => {
    expect(doctorVersionLine(sdk, "v0.0.0-test")).toBe(
      `hooknostic ${HOOKNOSTIC_VERSION}, ${text} (Node.js v0.0.0-test)`,
    );
  });

  it.each([
    ["has no node_modules/@hooknostic/sdk", false],
    // Node's lookup walks past a folder without a manifest, on to NODE_PATH.
    ["has an empty node_modules/@hooknostic/sdk folder", true],
  ])("does not report an SDK that only NODE_PATH reaches when the project %s", async (_, emptyFolder) => {
    // The build's esbuild never searches NODE_PATH, which pnpm's bin shims
    // set, so such an SDK is not the project's. Spawned, so the child's
    // NODE_PATH is the test's alone.
    const global = await realpath(await mkdtemp(join(tmpdir(), "hooknostic-doctor-node-path-")));
    const { root, configPath } = await projectWith(undefined);
    try {
      if (emptyFolder) await mkdir(join(root, "node_modules/@hooknostic/sdk/dist"), { recursive: true });
      const sdk = join(global, "@hooknostic/sdk");
      await mkdir(join(sdk, "dist"), { recursive: true });
      await writeFile(
        join(sdk, "package.json"),
        JSON.stringify({ name: "@hooknostic/sdk", version: "0.0.2-global", exports: { ".": "./dist/index.js" } }),
      );
      await writeFile(join(sdk, "dist/index.js"), "export {};\n");
      const env = { ...process.env, NODE_PATH: global };
      // Precondition: Node's own lookup from the project does reach it.
      const reached = spawnSync(
        process.execPath,
        [
          "-e",
          `console.log(require("node:module").createRequire(process.argv[1]).resolve("@hooknostic/sdk"))`,
          join(root, "package.json"),
        ],
        { encoding: "utf8", env, timeout: 30_000 },
      );
      expect(reached.status, reached.stderr).toBe(0);
      expect(reached.stdout.trim()).toBe(join(sdk, "dist/index.js"));

      const doctor = spawnSync(
        process.execPath,
        [join(REPO, "packages/cli/bin/hooknostic.mjs"), "doctor", "--json", "--config", configPath],
        { cwd: root, encoding: "utf8", env, timeout: 120_000 },
      );
      expect(doctor.status, doctor.stderr).toBe(0);
      const payload = JSON.parse(doctor.stdout);
      expect(payload.runtime.sdk).toStrictEqual({ status: "not-found" });
      // Nor warn HN110 about it beside a version line that says "not found" (#257).
      expect(payload.diagnostics).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(global, { recursive: true, force: true });
    }
  });

  it("prints its version line before the config loads, so a load that never finishes still shows it", async () => {
    // The config's load waits for the test: until then, nothing after it has run.
    const release = "__hooknosticDoctorVersionsRelease";
    const scope = globalThis as Record<string, unknown>;
    const { root, configPath } = await projectWith(
      { name: "@hooknostic/sdk", version: "0.0.1-test" },
      `export default new Promise((resolve) => { (globalThis as Record<string, unknown>)[${JSON.stringify(release)}] = () => resolve(${EMPTY_PROJECT}); });`,
    );
    try {
      const human = fakeIO();
      const running = runDoctor({ config: configPath, registry: {}, io: human.io });
      await vi.waitFor(() => expect(scope[release]).toBeTypeOf("function"), { timeout: 30_000, interval: 20 });
      // HN110 too, which may be why the load never finishes (#257).
      expect(human.out).toEqual([
        `hooknostic ${HOOKNOSTIC_VERSION}, project @hooknostic/sdk 0.0.1-test (Node.js ${process.version})`,
        expect.stringMatching(SKEW_LINE),
        "",
      ]);
      (scope[release] as () => void)();
      expect(await running).toBe(0);
    } finally {
      delete scope[release];
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints verify's HN110 too when it judged another SDK than doctor's own (#257)", async () => {
    // Only the same code and message is one warning. The SDK changes while the
    // config loads: after doctor judges it, before verify's build does.
    const release = "__hooknosticDoctorVersionsVerifyRelease";
    const scope = globalThis as Record<string, unknown>;
    const project = `{ project: { root: "." }, entry: "./hooks.ts", targets: { codex: { version: ${JSON.stringify(codexHarness.recommendedRange)}, delivery: "project", output: ".hooknostic/artifacts/codex" } } }`;
    const { root, configPath } = await projectWith(
      SKEWED_SDK,
      `export default new Promise((resolve) => { (globalThis as Record<string, unknown>)[${JSON.stringify(release)}] = () => resolve(${project}); });`,
    );
    // No detect(): doctor must not depend on a Codex install for this report.
    const { detect: _detect, ...codex } = codexAdapter();
    try {
      const human = fakeIO();
      const running = runDoctor({ config: configPath, registry: { codex }, io: human.io });
      await vi.waitFor(() => expect(scope[release]).toBeTypeOf("function"), { timeout: 30_000, interval: 20 });
      await setSdkVersion(root, "0.0.2-test");
      (scope[release] as () => void)();
      await running;
      expect(human.out.filter((block) => block.startsWith("HN110 "))).toEqual([
        expect.stringContaining(" is 0.0.1-test, "),
        expect.stringContaining(" is 0.0.2-test, "),
      ]);
    } finally {
      delete scope[release];
      await rm(root, { recursive: true, force: true });
    }
  });

  it("judges the SDK in its JSON as it was before the config loads (#257)", async () => {
    // The JSON is written only at the end, so the SDK changes while the load
    // waits: a judgement made after the load would find no skew.
    const release = "__hooknosticDoctorVersionsJsonRelease";
    const scope = globalThis as Record<string, unknown>;
    const { root, configPath } = await projectWith(
      SKEWED_SDK,
      `export default new Promise((resolve) => { (globalThis as Record<string, unknown>)[${JSON.stringify(release)}] = () => resolve(${EMPTY_PROJECT}); });`,
    );
    try {
      const machine = fakeIO();
      const running = runDoctor({ config: configPath, json: true, registry: {}, io: machine.io });
      await vi.waitFor(() => expect(scope[release]).toBeTypeOf("function"), { timeout: 30_000, interval: 20 });
      await setSdkVersion(root, HOOKNOSTIC_VERSION);
      (scope[release] as () => void)();
      expect(await running).toBe(0);
      const payload = JSON.parse(machine.out.join(""));
      expect(payload.runtime.sdk).toStrictEqual({ status: "found", version: "0.0.1-test" });
      expect(payload.diagnostics).toEqual([SKEW]);
    } finally {
      delete scope[release];
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints its version line when the config fails to load", async () => {
    const { root, configPath } = await projectWith(
      { name: "@hooknostic/sdk", version: "0.0.1-test" },
      "export default {;\n",
    );
    try {
      const human = fakeIO();
      expect(await runDoctor({ config: configPath, registry: {}, io: human.io })).toBe(2);
      expect(human.out[0]).toBe(
        `hooknostic ${HOOKNOSTIC_VERSION}, project @hooknostic/sdk 0.0.1-test (Node.js ${process.version})`,
      );
      expect(human.err.join("\n")).toContain("failed to load config");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveOnPath", () => {
  const separator = process.platform === "win32" ? ";" : ":";
  const executableName = (name: string) => (process.platform === "win32" ? `${name}.EXE` : name);
  const makeExecutable = async (path: string) => {
    await writeFile(path, "");
    if (process.platform !== "win32") await chmod(path, 0o755);
  };

  it("finds a command that is present, and reports one that is not", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-path-"));
    try {
      await makeExecutable(join(root, executableName("present")));
      const env = { PATH: root } as NodeJS.ProcessEnv;

      expect(resolveOnPath("present", env)).toBe(join(root, executableName("present")));
      expect(resolveOnPath("absent", env)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searches PATH entries in order", async () => {
    const first = await mkdtemp(join(tmpdir(), "hooknostic-path-a-"));
    const second = await mkdtemp(join(tmpdir(), "hooknostic-path-b-"));
    try {
      await makeExecutable(join(first, executableName("tool")));
      await makeExecutable(join(second, executableName("tool")));
      const env = { PATH: [first, second].join(separator) } as NodeJS.ProcessEnv;

      expect(resolveOnPath("tool", env)).toBe(join(first, executableName("tool")));
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it("treats an empty PATH entry as the current directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-path-current-"));
    const previous = process.cwd();
    try {
      await makeExecutable(join(root, executableName("from-current-directory")));
      process.chdir(root);
      expect(resolveOnPath("from-current-directory", { PATH: "" } as NodeJS.ProcessEnv)).toBe(
        join(root, executableName("from-current-directory")),
      );
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "resolves a Windows command shim, which is how npx and bun exist there",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "hooknostic-path-shim-"));
      try {
        // No `npx.exe` exists on Windows -- only `npx.cmd`. A bare-name check
        // would call the single most common MCP runner missing.
        await writeFile(join(root, "shim.CMD"), "");
        const env = { PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;

        expect(resolveOnPath("shim", env)).toBe(join(root, "shim.CMD"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "honors quoted PATH entries and case-insensitive PATH and PATHEXT keys",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "hooknostic-path-quoted-"));
      try {
        await writeFile(join(root, "quoted.CMD"), "");
        const env = { path: `"${root}"`, pathext: ".CMD" } as NodeJS.ProcessEnv;

        expect(resolveOnPath("quoted", env)).toBe(join(root, "quoted.CMD"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not report a directory as a command", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-path-directory-"));
    try {
      await mkdir(join(root, executableName("folder")));
      expect(resolveOnPath("folder", { PATH: root } as NodeJS.ProcessEnv)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("does not report a non-executable file as a command", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-path-mode-"));
    try {
      await writeFile(join(root, "plain"), "");
      await chmod(join(root, "plain"), 0o644);
      expect(resolveOnPath("plain", { PATH: root } as NodeJS.ProcessEnv)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports nothing when PATH is unset rather than throwing", () => {
    expect(resolveOnPath("anything", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
