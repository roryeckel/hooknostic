import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The version stamped into build reports must track the release version, not
// a hard-coded literal that breaks on every bump.
const ROOT_VERSION = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
import { runBuild } from "./build.js";
import { runDoctor } from "./doctor.js";
import { runInspect } from "./inspect.js";
import { defaultAdapterRegistry } from "./registry.js";
import { claudeHarness } from "@hooknostic/adapter-claude";
import { opencodeHarness } from "@hooknostic/adapter-opencode";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const EXAMPLES = join(REPO, "examples");

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

const cleanupDirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    cleanupDirs.map(async (d) => {
      // Drop the node_modules junction before the recursive remove. On Windows
      // rm(recursive) descends into a junction rather than unlinking it, which
      // both takes the real tree's handles and fails the rmdir with EPERM.
      await rm(join(d, "node_modules"), { force: true, recursive: false }).catch(() => {});
      // Same transient-handle race the output commit path retries for (HN302):
      // esbuild and the just-written tree can still be held briefly.
      for (const waitMs of [0, 25, 100, 400]) {
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
        try {
          await rm(d, { recursive: true, force: true });
          return;
        } catch {
          // retry
        }
      }
    }),
  );
});

/**
 * Build an example in a scratch copy rather than in place.
 *
 * `rewrite-shell` and `agent-plugin` commit their output (ADR-0006), and it is
 * the *packaged* CLI that must produce it: `resolveShimPath` finds the bundled
 * shim under `packages/cli/dist` when the CLI runs, and the adapter's own
 * `src/shim.ts` when `runBuild` is called from source as these tests do. The two
 * embed different modules, so building in place left the committed artifacts
 * disagreeing with the CI reproducibility gate depending on which ran last.
 *
 * The copy sits beside the real example, at the same depth, so `@hooknostic/sdk`
 * still resolves and the emitted path banners are identical.
 */
async function cleanExample(name: string) {
  const dir = join(EXAMPLES, `.buildtest-${name}`);
  await rm(dir, { recursive: true, force: true });
  await cp(join(EXAMPLES, name), dir, {
    recursive: true,
    filter: (src) =>
      !["dist", "hooknostic-build.json", "com.anthropic.claude-code", "node_modules"].includes(
        basename(src),
      ),
  });
  // pnpm links workspace deps into each package's own node_modules, and
  // resolution walks up from the importing file -- so the copy needs its own
  // link or `@hooknostic/sdk` does not resolve and the config fails to load.
  await symlink(join(EXAMPLES, name, "node_modules"), join(dir, "node_modules"), "junction");
  cleanupDirs.push(dir);
  return dir;
}

describe("hooknostic build end-to-end", () => {
  it(
    "builds the rewrite-shell example into three self-contained target artifacts",
    { timeout: 120_000 },
    async () => {
      const dir = await cleanExample("rewrite-shell");
      const { io, out } = captureIO();
      const code = await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io,
      });
      expect(code, out()).toBe(0);

      const report = JSON.parse(out());
      expect(report.schemaVersion).toBe(1);
      expect(Object.keys(report.targets).sort()).toEqual(["claude", "codex", "opencode"]);
      for (const target of Object.values(report.targets) as { status: string }[]) {
        expect(target.status).toBe("success");
      }
      expect(report.targets.claude.capabilities.unsupported).toBe(0);

      // Self-contained per-target outputs (design §8.4).
      const claudeRuntime = join(dir, "dist/claude/runtime/hooknostic.mjs");
      expect(existsSync(join(dir, "dist/claude/.claude-plugin/plugin.json"))).toBe(true);
      expect(existsSync(join(dir, "dist/claude/hooks/hooks.json"))).toBe(true);
      expect(existsSync(claudeRuntime)).toBe(true);
      expect(existsSync(join(dir, "dist/codex/.codex/hooks.json"))).toBe(true);
      expect(existsSync(join(dir, "dist/codex/.codex/hooknostic/hooknostic.mjs"))).toBe(true);
      expect(existsSync(join(dir, "dist/opencode/.opencode/plugins/hooknostic.js"))).toBe(true);

      // The bundle embeds the portable handlers — no cross-directory refs.
      const bundle = await readFile(claudeRuntime, "utf8");
      expect(bundle).toContain("Refusing destructive root deletion");
      expect(bundle).not.toContain("require(\"@hooknostic");

      // Build report on disk, versioned for CI consumption.
      const onDisk = JSON.parse(
        await readFile(join(dir, "hooknostic-build.json"), "utf8"),
      );
      expect(onDisk.schemaVersion).toBe(1);
      expect(onDisk.hooknosticVersion).toBe(ROOT_VERSION);

      // Determinism: a second build emits identical manifests.
      const firstHooksJson = await readFile(join(dir, "dist/claude/hooks/hooks.json"), "utf8");
      const second = captureIO();
      expect(
        await runBuild({
          config: join(dir, "hooknostic.config.ts"),
          json: true,
          registry: defaultAdapterRegistry(),
          io: second.io,
        }),
      ).toBe(0);
      expect(await readFile(join(dir, "dist/claude/hooks/hooks.json"), "utf8")).toBe(
        firstHooksJson,
      );
    },
  );

  it(
    "emits identical bytes no matter which directory the build was invoked from",
    { timeout: 240_000 },
    async () => {
      // esbuild writes each module's path into a `// <path>` banner relative to
      // absWorkingDir, which defaults to the working directory. Unanchored, the
      // same source produced different bytes from the repo root than from the
      // config's own directory -- so "the committed artifact matches its source"
      // became a claim about where the developer happened to stand, and a
      // consumer's drift check reported staleness when nothing was stale. Found
      // in the wild: a real consumer's three artifacts moved 87 lines.
      //
      // This has to spawn the CLI rather than call runBuild and chdir between
      // calls. esbuild runs as a long-lived service process whose working
      // directory is fixed when it starts, so an in-process process.chdir() does
      // not reach it and the test passes with the fix removed -- verified.
      const dir = await cleanExample("rewrite-shell");
      const runtime = join(dir, "dist/claude/runtime/hooknostic.mjs");
      const cli = join(REPO, "packages/cli/bin/hooknostic.mjs");

      const bundleBuiltFrom = async (cwd: string) => {
        const run = spawnSync(
          process.execPath,
          [cli, "build", "--config", join(dir, "hooknostic.config.ts")],
          { cwd, encoding: "utf8", timeout: 120_000 },
        );
        expect(run.status, `${run.stdout}
${run.stderr}`).toBe(0);
        return readFile(runtime, "utf8");
      };

      const fromRepoRoot = await bundleBuiltFrom(REPO);
      const fromConfigDir = await bundleBuiltFrom(dir);
      expect(fromConfigDir).toBe(fromRepoRoot);
    },
  );

  it(
    "emits Agent Plugins extension directories and reuses manifest metadata",
    { timeout: 120_000 },
    async () => {
      const dir = await cleanExample("agent-plugin");
      const manifestBefore = await readFile(join(dir, "plugin.json"), "utf8");

      const { io, out } = captureIO();
      const code = await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io,
      });
      expect(code, out()).toBe(0);

      const report = JSON.parse(out());
      expect(report.agentPlugin.extensions).toEqual(["com.anthropic.claude-code"]);

      // Legal client-extension directory; portable root untouched (ADR-0004).
      expect(existsSync(join(dir, "com.anthropic.claude-code/hooks/hooks.json"))).toBe(true);
      expect(existsSync(join(dir, "com.anthropic.claude-code/runtime/hooknostic.mjs"))).toBe(
        true,
      );
      expect(existsSync(join(dir, "com.anthropic.claude-code/.claude-plugin"))).toBe(false);
      expect(await readFile(join(dir, "plugin.json"), "utf8")).toBe(manifestBefore);

      // plugin.json metadata filled the gaps in the plugin spec.
      const pluginJson = JSON.parse(
        await readFile(join(dir, "dist/claude/.claude-plugin/plugin.json"), "utf8"),
      );
      expect(pluginJson).toEqual({
        name: "combined-example",
        version: "1.0.0",
        description: "Agent Plugins package with hooknostic-compiled lifecycle hooks",
      });
    },
  );

  it(
    "commits nothing when any selected target fails analysis",
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-buildfail-"));
      cleanupDirs.push(dir);
      await writeFile(
        join(dir, "hooknostic.config.ts"),
        `export default {
          entry: "./hooks.ts",
          targets: {
            claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" },
            opencode: { version: "${opencodeHarness.recommendedRange}", mode: "local", output: "./dist/opencode" },
          },
        };`,
        "utf8",
      );
      await writeFile(
        join(dir, "hooks.ts"),
        `import { definePlugin, hook, preventStop } from "@hooknostic/sdk";
        export default definePlugin({
          name: "wants-prevent-stop",
          hooks: [
            hook("turn.stop", {
              id: "keep-going",
              capabilities: { "turn.stop.prevent": "required" },
              async run() { return preventStop("more to do"); },
            }),
          ],
        });`,
        "utf8",
      );

      const SDK = join(REPO, "packages/sdk/src/index.ts");
      const { io, out } = captureIO();
      const code = await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io,
        evaluate: { alias: { "@hooknostic/sdk": SDK } },
      });
      expect(code).toBe(1);

      const report = JSON.parse(out());
      // turn.stop.prevent is exact on claude; on opencode the implicit turn.stop.observe is approximate, which is below the default floor.
      expect(report.targets.claude.status).toBe("success");
      expect(report.targets.opencode.status).toBe("failed");
      expect(
        report.diagnostics.some(
          (d: { code: string; target: string }) =>
            d.code === "HN201" && d.target === "opencode",
        ),
      ).toBe(true);
      // Atomicity: the passing target's artifacts were NOT committed either.
      expect(existsSync(join(dir, "dist"))).toBe(false);
      expect(existsSync(join(dir, "hooknostic-build.json"))).toBe(false);
    },
  );

  it("rejects project-root output without deleting the config or hook source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-unsafe-output-"));
    cleanupDirs.push(dir);
    const configPath = join(dir, "hooknostic.config.ts");
    const entryPath = join(dir, "hooks.ts");
    await writeFile(
      configPath,
      `export default {
        entry: "./hooks.ts",
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "." } },
      };`,
      "utf8",
    );
    await writeFile(
      entryPath,
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "safe", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
      "utf8",
    );
    const capture = captureIO();
    expect(
      await runBuild({
        config: configPath,
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
    ).toBe(1);
    expect(JSON.parse(capture.out()).diagnostics).toEqual([
      expect.objectContaining({ code: "HN501", target: "claude" }),
    ]);
    expect(await readFile(configPath, "utf8")).toContain('output: "."');
    expect(await readFile(entryPath, "utf8")).toContain("definePlugin");
  });

  it("rejects an invalid report destination before replacing existing artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-report-output-"));
    cleanupDirs.push(dir);
    const configPath = join(dir, "hooknostic.config.ts");
    await writeFile(
      configPath,
      `export default {
        entry: "./hooks.ts",
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } },
      };`,
      "utf8",
    );
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "safe", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
      "utf8",
    );
    const existingOutput = join(dir, "dist/claude");
    await mkdir(existingOutput, { recursive: true });
    await writeFile(join(existingOutput, "old-marker"), "old", "utf8");
    await mkdir(join(dir, "hooknostic-build.json"));

    const capture = captureIO();
    expect(
      await runBuild({
        config: configPath,
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
    ).toBe(1);
    expect(JSON.parse(capture.out()).diagnostics).toEqual([
      expect.objectContaining({ code: "HN302" }),
    ]);
    expect(await readFile(join(existingOutput, "old-marker"), "utf8")).toBe("old");
  });
});

describe("hooknostic doctor", () => {
  it("reports detection status per adapter", async () => {
    const { io, out } = captureIO();
    await runDoctor({ json: true, registry: defaultAdapterRegistry(), io });
    const report = JSON.parse(out());
    expect(report.command).toBe("doctor");
    expect(report.harnesses.map((h: { adapter: string }) => h.adapter).sort()).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
    for (const harness of report.harnesses) {
      expect([
        "ok",
        "newer-than-validated",
        "outside-validated",
        "not-detected",
        "unknown-version",
      ]).toContain(harness.status);
      expect(harness.validatedRanges.length).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe("hooknostic inspect", () => {
  it("renders adapter-owned capability facts with rationale", async () => {
    const { io, out } = captureIO();
    const code = await runInspect({
      target: "codex",
      json: true,
      registry: defaultAdapterRegistry(),
      io,
    });
    expect(code).toBe(0);
    const report = JSON.parse(out());
    expect(report.target).toBe("codex");
    expect(report.profiles[0].source.date).toBe("2026-08-29");
    const replace = report.capabilities.find(
      (c: { capability: string }) => c.capability === "tool.after.output.replace",
    );
    // Captured live on 0.151.0: the hook engine rejects updatedMCPToolOutput
    // outright, so the cell is unsupported (see the codex profile rationale).
    expect(replace.level).toBe("unsupported");
    expect(replace.rationale).toContain("updatedMCPToolOutput");
    const err = report.capabilities.find(
      (c: { capability: string }) => c.capability === "tool.error.observe",
    );
    expect(err.level).toBe("unsupported");
  });

  it("supports single-capability queries and unknown targets", async () => {
    const single = captureIO();
    expect(
      await runInspect({
        target: "claude",
        capability: "tool.before.requestApproval",
        json: true,
        registry: defaultAdapterRegistry(),
        io: single.io,
      }),
    ).toBe(0);
    expect(JSON.parse(single.out()).capabilities).toHaveLength(1);

    const unknown = captureIO();
    expect(
      await runInspect({
        target: "cursor",
        registry: defaultAdapterRegistry(),
        io: unknown.io,
      }),
    ).toBe(2);
    expect(unknown.err()).toContain("unknown target");

    const inherited = captureIO();
    expect(
      await runInspect({
        target: "toString",
        registry: defaultAdapterRegistry(),
        io: inherited.io,
      }),
    ).toBe(2);
    expect(inherited.err()).toContain('unknown target "toString"');

    const invalidCapability = captureIO();
    expect(
      await runInspect({
        target: "claude",
        capability: "tool.before.typo",
        json: true,
        registry: defaultAdapterRegistry(),
        io: invalidCapability.io,
      }),
    ).toBe(2);
    expect(invalidCapability.err()).toContain("unknown capability");
    expect(invalidCapability.err()).toContain("without --capability");
  });
});
