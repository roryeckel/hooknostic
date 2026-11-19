import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { claudeHarness } from "@hooknostic/adapter-claude";
import { codexAdapter, codexHarness } from "@hooknostic/adapter-codex";
import { opencodeAdapter, opencodeHarness, opencodeV2Harness } from "@hooknostic/adapter-opencode";
import { type HarnessAdapter, HOOKNOSTIC_VERSION, runProject } from "@hooknostic/core";
import { makeFakeAdapter } from "@hooknostic/testkit";

import { doctorVersionLine, resolveOnPath, runDoctor } from "./doctor.js";
import { defaultAdapterRegistry } from "./registry.js";

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
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
      const warning = human.out.find((line) => line.startsWith("HN107 warn: "));
      expect(warning, human.out.join("\n")).toContain(`root checkout ${main}`);
      expect(warning).toContain(join(main, ".codex", "hooks.json"));

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

  /**
   * Run `work` with Node's global folders as a plain `node` has them: vitest's
   * bin shim puts pnpm's hoisted packages, this workspace's SDK among them, on
   * NODE_PATH, where a project without an SDK would resolve it.
   */
  async function withoutNodePath<T>(work: () => Promise<T>): Promise<T> {
    const nodePath = process.env["NODE_PATH"];
    const initPaths = () => (Module as unknown as { _initPaths(): void })._initPaths();
    delete process.env["NODE_PATH"];
    initPaths();
    try {
      return await work();
    } finally {
      if (nodePath !== undefined) process.env["NODE_PATH"] = nodePath;
      initPaths();
    }
  }

  it("reports this hooknostic and Node.js without a config, and no SDK", async () => {
    const machine = fakeIO();
    await runDoctor({ json: true, registry: { fake: adapterDetecting("1.3.0") }, io: machine.io });
    const payload = JSON.parse(machine.out.join(""));
    expect(payload.schemaVersion).toBe(2);
    expect(payload.runtime).toStrictEqual({ node: process.version, hooknostic: HOOKNOSTIC_VERSION });

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
      expect(
        await withoutNodePath(() => runDoctor({ config: configPath, json: true, registry: {}, io: machine.io })),
      ).toBe(0);
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
    [{ status: "unidentified" } as const, "project @hooknostic/sdk version unknown"],
    [
      { status: "not-looked-up" } as const,
      "project @hooknostic/sdk not looked up under another install's Plug'n'Play runtime",
    ],
  ])("words the project's SDK in the version line (%j)", (sdk, text) => {
    expect(doctorVersionLine(sdk, "v0.0.0-test")).toBe(
      `hooknostic ${HOOKNOSTIC_VERSION}, ${text} (Node.js v0.0.0-test)`,
    );
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
      expect(human.out).toEqual([
        `hooknostic ${HOOKNOSTIC_VERSION}, project @hooknostic/sdk 0.0.1-test (Node.js ${process.version})`,
      ]);
      (scope[release] as () => void)();
      expect(await running).toBe(0);
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
