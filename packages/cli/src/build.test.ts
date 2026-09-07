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
import { codexHarness } from "@hooknostic/adapter-codex";
import { opencodeHarness } from "@hooknostic/adapter-opencode";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
} from "@hooknostic/agent-plugin";
import { makeFakeAdapter, syntheticSource } from "@hooknostic/testkit";

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

/**
 * A fake harness whose projector represents the manifest exactly and nothing
 * else, so the warn-policy omission path has somewhere real to go: the
 * shipped adapters either project every component (Claude) or none (Codex,
 * OpenCode), and a target with no projector at all is a hard error.
 */
function partialProjectorAdapter() {
  return makeFakeAdapter({
    id: "partial",
    profiles: [
      {
        range: ">=1.0 <2",
        source: syntheticSource(),
        matrix: { "session.start.observe": { level: "exact" } },
      },
    ],
    shimEntry: "export {};",
    agentPluginProjector: {
      namespace: "example.partial",
      profiles: [
        {
          range: ">=1.0 <2",
          components: { "agent-plugin.manifest": { level: "exact" } },
          source: {
            date: "2026-01-01",
            validatedOn: [{ version: "1.0.0", date: "2026-01-01", method: "doc-derived", what: "synthetic" }],
          },
        },
      ],
      async project(source, context) {
        const skipped = (
          component:
            | "agent-plugin.skills"
            | "agent-plugin.mcp.stdio"
            | "agent-plugin.client-extension.files",
          count: number,
        ) => [component, { discovered: count, emitted: 0, skipped: count }] as const;
        const skills = source.skills.length;
        const servers = Object.keys(source.mcp?.mcpServers ?? {}).length;
        const manifestExtension = source.manifest.extensions?.["example.partial"] === undefined ? 0 : 1;
        return {
          files: [
            { path: "manifest.json", contents: JSON.stringify({ name: source.manifest.name }) },
            ...context.hookArtifacts,
          ],
          issues: [],
          summary: {
            components: Object.fromEntries([
              ["agent-plugin.manifest", { discovered: 1, emitted: 1, skipped: 0 }],
              skipped("agent-plugin.skills", skills),
              skipped("agent-plugin.mcp.stdio", servers),
              ...(manifestExtension === 0
                ? []
                : [skipped("agent-plugin.client-extension.files", manifestExtension)]),
            ]),
            omissions: [
              { component: "agent-plugin.skills", reason: "unsupported" },
              { component: "agent-plugin.mcp.stdio", reason: "unsupported" },
              ...(manifestExtension === 0
                ? []
                : [{ component: "agent-plugin.client-extension.files" as const, reason: "unsupported" }]),
            ],
            copiedPaths: [],
          },
        };
      },
    },
  });
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
      expect(report.schemaVersion).toBe(2);
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
      expect(onDisk.schemaVersion).toBe(2);
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
    "projects an Agent Plugin into Claude without modifying the source package",
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
      expect(report.agentPlugin.targets).toEqual(["claude"]);
      expect(report.targets.claude.projection).toMatchObject({ status: "success" });

      // `artifacts` lists what the build generated, not what it copied, and the
      // split comes from the projector's own `copiedPaths` rather than from any
      // path layout core knows about.
      expect(report.targets.claude.artifacts).toEqual(
        expect.arrayContaining([
          ".claude-plugin/plugin.json",
          ".mcp.json",
          "hooks/hooks.json",
          "package.json",
          "package-lock.json",
          "runtime/hooknostic.mjs",
        ]),
      );
      expect(report.targets.claude.artifacts).not.toContain("skills/greet/SKILL.md");
      expect(report.targets.claude.artifacts).not.toContain("src/greet-mcp.mjs");

      // The portable root remains untouched; native material exists only in output.
      expect(existsSync(join(dir, "com.anthropic.claude-code"))).toBe(false);
      expect(existsSync(join(dir, "dist/claude/hooks/hooks.json"))).toBe(true);
      expect(existsSync(join(dir, "dist/claude/runtime/hooknostic.mjs"))).toBe(true);
      expect(existsSync(join(dir, "dist/claude/src/greet-mcp.mjs"))).toBe(true);
      expect(await readFile(join(dir, "plugin.json"), "utf8")).toBe(manifestBefore);

      const mcpJson = JSON.parse(
        await readFile(join(dir, "dist/claude/.mcp.json"), "utf8"),
      );
      expect(mcpJson.mcpServers.greeter).toMatchObject({
        type: "stdio",
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/src/greet-mcp.mjs"],
      });

      const runtimeManifest = JSON.parse(await readFile(join(dir, "dist/claude/package.json"), "utf8"));
      expect(runtimeManifest).toMatchObject({
        name: "combined-example-runtime",
        dependencies: { "@modelcontextprotocol/server": "2.0.0", zod: "4.5.4" },
      });
      expect(existsSync(join(dir, "dist/claude/package-lock.json"))).toBe(true);
      expect(existsSync(join(dir, "dist/claude/runtime.package.json"))).toBe(false);

      // plugin.json metadata filled the gaps in the plugin spec.
      const pluginJson = JSON.parse(
        await readFile(join(dir, "dist/claude/.claude-plugin/plugin.json"), "utf8"),
      );
      expect(pluginJson).toMatchObject({
        name: "combined-example",
        version: "1.0.0",
        description:
          "Agent Plugins package with a skill, MCP server, and hooknostic-compiled lifecycle hooks",
        license: "MIT",
      });
    },
  );

  it("builds a hookless skill package without emitting a runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-hookless-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "skills/review"), { recursive: true });
    const manifest = JSON.stringify(
      {
        $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
        name: "hookless-tools",
        version: "1.0.0",
        extensions: { "com.anthropic.claude-code": { manifestOnly: true } },
      },
      null,
      2,
    );
    const skill = "---\nname: review\ndescription: Review a change\n---\nReview carefully.\n";
    await writeFile(join(dir, "plugin.json"), manifest);
    await writeFile(join(dir, "skills/review/SKILL.md"), skill);
    await mkdir(join(dir, "dist/.hooknostic-claude-recovery/backup"), { recursive: true });
    await writeFile(
      join(dir, "dist/.hooknostic-claude-recovery/backup/private.txt"),
      "stale transaction data",
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        agentPlugin: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } }
      };`,
    );

    const capture = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
      }),
      capture.out(),
    ).toBe(0);
    const report = JSON.parse(capture.out());
    expect(report.source).toBeUndefined();
    // The config file is project scaffolding, never package content.
    expect(report.agentPlugin.sourceFiles).toEqual(["plugin.json", "skills/review/SKILL.md"]);
    expect(report.agentPlugin.sourceFileCount).toBe(2);
    expect(existsSync(join(dir, "dist/claude/hooknostic.config.ts"))).toBe(false);
    expect(report.targets.claude.projection.components["agent-plugin.skills"]).toMatchObject({
      support: "exact",
      discovered: 1,
      emitted: 1,
    });
    expect(report.targets.claude.projection.components["agent-plugin.client-extension.files"]).toMatchObject({
      support: "exact",
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
    expect(existsSync(join(dir, "dist/claude/runtime/hooknostic.mjs"))).toBe(false);
    expect(
      existsSync(
        join(dir, "dist/claude/dist/.hooknostic-claude-recovery/backup/private.txt"),
      ),
    ).toBe(false);
    expect(await readFile(join(dir, "dist/claude/skills/review/SKILL.md"), "utf8")).toBe(skill);
    expect(await readFile(join(dir, "plugin.json"), "utf8")).toBe(manifest);
  });

  it("records explicit warn-policy omissions while retaining hook artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-omission-"));
    cleanupDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
        name: "omission-test",
        extensions: { "example.partial": { manifestOnly: true } },
      }),
    );
    await writeFile(join(dir, "README.md"), "portable");
    for (const name of ["first", "second"]) {
      await mkdir(join(dir, `skills/${name}`), { recursive: true });
      await writeFile(
        join(dir, `skills/${name}/SKILL.md`),
        `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
      );
    }
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          first: { type: "stdio", command: "node" },
          second: { type: "stdio", command: "node" },
        },
      }),
    );
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "omission-test", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        agentPlugin: { root: ".", targets: ["partial"], onUnsupported: "warn" },
        targets: { partial: { version: ">=1.0 <2", mode: "plugin", output: "./dist/partial" } }
      };`,
    );
    const capture = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: { partial: partialProjectorAdapter() },
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      capture.out(),
    ).toBe(0);
    const report = JSON.parse(capture.out());
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", severity: "warn", component: "agent-plugin.skills" }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", severity: "warn", component: "agent-plugin.mcp.stdio" }),
    );
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", severity: "warn", component: "agent-plugin.client-extension.files" }),
    );
    expect(report.targets.partial.projection.omissions).toEqual([
      expect.objectContaining({ component: "agent-plugin.skills" }),
      expect.objectContaining({ component: "agent-plugin.mcp.stdio" }),
      expect.objectContaining({ component: "agent-plugin.client-extension.files" }),
    ]);
    expect(report.targets.partial.projection.components).toMatchObject({
      "agent-plugin.manifest": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
      "agent-plugin.skills": { support: "unsupported", discovered: 2, emitted: 0, skipped: 2 },
      "agent-plugin.mcp.stdio": { support: "unsupported", discovered: 2, emitted: 0, skipped: 2 },
      "agent-plugin.client-extension.files": { support: "unsupported", discovered: 1, emitted: 0, skipped: 1 },
    });
    expect(existsSync(join(dir, "dist/partial/fake-plugin.json"))).toBe(true);
    expect(existsSync(join(dir, "dist/partial/manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "dist/partial/README.md"))).toBe(false);
    // This projector's generated manifest is `manifest.json`, at a path no
    // shipped adapter uses: core reports it because the projector did not list
    // it as copied, not because core recognizes the path.
    expect(report.targets.partial.artifacts).toContain("manifest.json");
  });

  it("refuses a projection target whose adapter has no projector, even under warn policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-no-projector-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "skills/review"), { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "no-projector" }),
    );
    await writeFile(join(dir, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
    await mkdir(join(dir, "dist/codex"), { recursive: true });
    await writeFile(join(dir, "dist/codex/previous"), "previous output");
    // Hookless, so the only thing this target could ever receive is the package.
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        agentPlugin: { root: ".", targets: ["codex"], onUnsupported: "warn" },
        targets: { codex: { version: "${codexHarness.recommendedRange}", mode: "local", output: "./dist/codex" } }
      };`,
    );
    const json = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: json.io,
      }),
    ).toBe(1);
    const report = JSON.parse(json.out());
    expect(report.targets.codex.status).toBe("failed");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: "HN205", severity: "error", target: "codex", message: expect.stringContaining("no Agent Plugin projector") }),
    ]);
    // Nothing was committed: the previous output survives untouched, and the
    // "success" that used to accompany an empty directory is gone.
    expect(await readFile(join(dir, "dist/codex/previous"), "utf8")).toBe("previous output");
    expect(existsSync(join(dir, "hooknostic-build.json"))).toBe(false);

    const human = captureIO();
    expect(
      await runBuild({ config: join(dir, "hooknostic.config.ts"), registry: defaultAdapterRegistry(), io: human.io }),
    ).toBe(1);
    expect(human.out()).toContain("FAIL   codex");
    expect(human.out()).toContain("Agent Plugin projection failed");
  });

  it("prints the projection summary for a built target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-projection-summary-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "skills/review"), { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "summary" }),
    );
    await writeFile(join(dir, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        agentPlugin: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } }
      };`,
    );
    const human = captureIO();
    expect(
      await runBuild({ config: join(dir, "hooknostic.config.ts"), registry: defaultAdapterRegistry(), io: human.io }),
      human.out(),
    ).toBe(0);
    expect(human.out()).toContain("BUILT  claude");
    expect(human.out()).toMatch(/Agent Plugin projection success: 2 components emitted, 0 omitted, 1 package files copied/);
  });

  it("never ships dependencies, secrets, the config, or the hook source from a project-root package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-inventory-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "node_modules/left-pad"), { recursive: true });
    await mkdir(join(dir, "src/nested"), { recursive: true });
    await writeFile(join(dir, "node_modules/left-pad/index.js"), "module.exports = 1;");
    await writeFile(join(dir, ".env"), "SECRET=1");
    await writeFile(join(dir, ".env.local"), "SECRET=2");
    await writeFile(join(dir, "src/nested/.env"), "SECRET=3");
    await writeFile(join(dir, ".npmrc"), "//registry/:_authToken=abc");
    await writeFile(join(dir, "src/server.mjs"), "export {};");
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "inventory" }),
    );
    await writeFile(
      join(dir, "src/hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "inventory", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./src/hooks.ts",
        agentPlugin: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } }
      };`,
    );
    const capture = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      capture.out(),
    ).toBe(0);
    const report = JSON.parse(capture.out());
    expect(report.agentPlugin.sourceFiles).toEqual(["plugin.json", "src/server.mjs"]);
    for (const shipped of ["src/server.mjs", "runtime/hooknostic.mjs", ".claude-plugin/plugin.json"]) {
      expect(existsSync(join(dir, "dist/claude", shipped)), shipped).toBe(true);
    }
    for (const leaked of [
      "node_modules",
      ".env",
      ".env.local",
      "src/nested/.env",
      ".npmrc",
      "hooknostic.config.ts",
      "src/hooks.ts",
      "dist",
    ]) {
      expect(existsSync(join(dir, "dist/claude", leaked)), leaked).toBe(false);
    }
  });

  it("builds when the output is spelled through a link inside the package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-linked-output-"));
    cleanupDirs.push(dir);
    // A previous output exists. Inventory walks `link/claude` under the link's
    // name; the exclusion must cover that spelling as well as the canonical
    // `dist/claude`, or the loader rejects the link as resolving to an
    // excluded path and the build fails.
    await mkdir(join(dir, "dist/claude"), { recursive: true });
    await writeFile(join(dir, "dist/claude/stale.json"), "{}");
    await symlink(join(dir, "dist"), join(dir, "link"), "junction");
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "linked-output" }),
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        agentPlugin: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./link/claude" } }
      };`,
    );
    const capture = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      capture.out(),
    ).toBe(0);
    expect(JSON.parse(capture.out()).agentPlugin.sourceFiles).toEqual(["plugin.json"]);
    expect(existsSync(join(dir, "dist/claude"))).toBe(true);
  });

  it("excludes the config file's link target when the config itself is a link inside the package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-linked-config-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "linked-config" }),
    );
    await writeFile(
      join(dir, "config/real.config.ts"),
      `export default {
        agentPlugin: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } }
      };`,
    );
    // The name is excluded by rule; the file it links to must be as well.
    await symlink(join(dir, "config/real.config.ts"), join(dir, "hooknostic.config.ts"), "file");
    const capture = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      capture.out(),
    ).toBe(0);
    expect(JSON.parse(capture.out()).agentPlugin.sourceFiles).toEqual(["plugin.json"]);
  });

  it("still excludes the config and entry when the package root is reached through a link", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hooknostic-linked-root-"));
    cleanupDirs.push(parent);
    const real = join(parent, "real");
    await mkdir(join(real, "src"), { recursive: true });
    // The loader inventories the realpath; the config names the alias.
    await symlink(real, join(parent, "alias"), "junction");
    await writeFile(
      join(real, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "linked-root" }),
    );
    await writeFile(
      join(real, "src/hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "linked-root", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    await writeFile(
      join(real, "hooknostic.config.ts"),
      `export default {
        entry: "./src/hooks.ts",
        agentPlugin: { root: "../alias", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } }
      };`,
    );
    const capture = captureIO();
    expect(
      await runBuild({
        config: join(real, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      capture.out(),
    ).toBe(0);
    expect(JSON.parse(capture.out()).agentPlugin.sourceFiles).toEqual(["plugin.json"]);
    expect(existsSync(join(real, "dist/claude/hooknostic.config.ts"))).toBe(false);
    expect(existsSync(join(real, "dist/claude/src/hooks.ts"))).toBe(false);
  });

  it("still excludes a target output spelled through the package root's alias", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hooknostic-aliased-output-"));
    cleanupDirs.push(parent);
    const real = join(parent, "real");
    await mkdir(join(parent, "src"), { recursive: true });
    // A previous build's output sits under the real root; the config reaches
    // both the root and the output through the alias.
    await mkdir(join(real, "dist/claude"), { recursive: true });
    await writeFile(join(real, "dist/claude/stale.json"), "{}");
    await symlink(real, join(parent, "alias"), "junction");
    await writeFile(
      join(real, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "aliased-output" }),
    );
    await writeFile(
      join(parent, "src/hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "aliased-output", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    await writeFile(
      join(parent, "hooknostic.config.ts"),
      `export default {
        entry: "./src/hooks.ts",
        agentPlugin: { root: "./alias", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./alias/dist/claude" } }
      };`,
    );
    const capture = captureIO();
    expect(
      await runBuild({
        config: join(parent, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      capture.out(),
    ).toBe(0);
    expect(JSON.parse(capture.out()).agentPlugin.sourceFiles).toEqual(["plugin.json"]);
    expect(existsSync(join(real, "dist/claude/dist/claude/stale.json"))).toBe(false);
  });

  it("fails on an invalid component by default and degrades it only under onInvalid: warn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-invalid-component-"));
    cleanupDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "invalid-component" }),
    );
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          good: { type: "stdio", command: "node" },
          insecure: { type: "streamable-http", url: "http://example.com/insecure" },
        },
      }),
    );
    const config = (policy: string) =>
      `export default {
        agentPlugin: { root: ".", targets: ["claude"]${policy} },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } }
      };`;

    await writeFile(join(dir, "hooknostic.config.ts"), config(""));
    const strict = captureIO();
    expect(
      await runBuild({ config: join(dir, "hooknostic.config.ts"), json: true, registry: defaultAdapterRegistry(), io: strict.io }),
    ).toBe(1);
    expect(JSON.parse(strict.out()).diagnostics).toEqual([
      expect.objectContaining({ code: "HN503", severity: "error", message: expect.stringContaining('"insecure"') }),
    ]);
    expect(existsSync(join(dir, "dist"))).toBe(false);

    await writeFile(join(dir, "hooknostic.config.ts"), config(', onInvalid: "warn"'));
    const lenient = captureIO();
    expect(
      await runBuild({ config: join(dir, "hooknostic.config.ts"), json: true, registry: defaultAdapterRegistry(), io: lenient.io }),
      lenient.out(),
    ).toBe(0);
    const report = JSON.parse(lenient.out());
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: "HN503", severity: "warn", message: expect.stringContaining('"insecure"') }),
    ]);
    const mcp = JSON.parse(await readFile(join(dir, "dist/claude/.mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["good"]);
  });

  it("rolls back a projection when a native overlay collides with the Hooknostic runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-projection-rollback-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "com.anthropic.claude-code/runtime"), { recursive: true });
    await mkdir(join(dir, "dist/claude"), { recursive: true });
    await writeFile(join(dir, "dist/claude/old-marker"), "old");
    await writeFile(join(dir, "com.anthropic.claude-code/runtime/hooknostic.mjs"), "native collision");
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "collision-test" }),
    );
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "collision-test", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        agentPlugin: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } }
      };`,
    );
    const capture = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
    ).toBe(1);
    expect(JSON.parse(capture.out()).diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN503", target: "claude" }),
    );
    expect(await readFile(join(dir, "dist/claude/old-marker"), "utf8")).toBe("old");
  });

  it("fails a projection whose package root claims a Claude-reserved path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-reserved-"));
    cleanupDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "reserved-test" }),
    );
    // Not a client extension: a root `.mcp.json` never passed the portable MCP
    // validation, so its servers must not reach Claude's own config path.
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { rogue: { command: "rogue" } } }),
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        agentPlugin: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", mode: "plugin", output: "./dist/claude" } }
      };`,
    );
    const capture = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: capture.io,
      }),
    ).toBe(1);
    expect(JSON.parse(capture.out()).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN503",
        target: "claude",
        message: expect.stringContaining("com.anthropic.claude-code/.mcp.json"),
      }),
    );
    expect(existsSync(join(dir, "dist/claude"))).toBe(false);
  });

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

    const component = captureIO();
    expect(
      await runInspect({
        target: "claude",
        component: "agent-plugin.mcp.streamable-http",
        json: true,
        registry: defaultAdapterRegistry(),
        io: component.io,
      }),
    ).toBe(0);
    expect(JSON.parse(component.out()).components).toEqual([
      expect.objectContaining({
        component: "agent-plugin.mcp.streamable-http",
        level: "exact",
      }),
    ]);

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
