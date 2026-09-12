import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
import { runCheck } from "./check.js";
import { runDoctor } from "./doctor.js";
import { runInspect } from "./inspect.js";
import { defaultAdapterRegistry } from "./registry.js";
import { claudeHarness } from "@hooknostic/adapter-claude";
import { CODEX_PLUGIN_MODE_RANGE } from "@hooknostic/adapter-codex";
import { opencodeHarness } from "@hooknostic/adapter-opencode";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  loadAgentPlugin,
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
function noProjectorAdapter() {
  return makeFakeAdapter({
    id: "noproj",
    profiles: [
      { range: ">=1.0 <2", source: syntheticSource(), matrix: { "session.start.observe": { level: "exact" } } },
    ],
    shimEntry: "export {};",
  });
}

function copyThroughAdapter() {
  return makeFakeAdapter({
    id: "copy",
    profiles: [
      {
        range: ">=1.0 <2",
        source: syntheticSource(),
        matrix: { "session.start.observe": { level: "exact" } },
      },
    ],
    shimEntry: "export {};",
    agentPluginProjector: {
      namespace: "",
      profiles: [
        {
          range: ">=1.0 <2",
          components: { "agent-plugin.manifest": { level: "exact" }, "agent-plugin.skills": { level: "exact" } },
          source: {
            date: "2026-01-01",
            validatedOn: [{ version: "1.0.0", date: "2026-01-01", method: "doc-derived", what: "synthetic" }],
          },
        },
      ],
      // Copies the package verbatim, so `copiedPaths` covers the whole output
      // and a previous build reappearing as source is directly countable.
      async project(source, context) {
        return {
          files: [
            ...source.files.map((file) => ({ path: file.path, contents: file.contents, mode: file.mode })),
            ...context.hookArtifacts,
          ],
          issues: [],
          summary: {
            components: {
              "agent-plugin.manifest": { discovered: 1, emitted: 1, skipped: 0 },
              ...(source.skills.length === 0
                ? {}
                : { "agent-plugin.skills": { discovered: source.skills.length, emitted: source.skills.length, skipped: 0 } }),
            },
            omissions: [],
            copiedPaths: source.files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
          },
        };
      },
    },
  });
}

/**
 * A projector that returns the package without the compiled hook artifacts.
 *
 * A projection replaces the target output wholesale, so this installs a package
 * that looks complete and runs nothing. Nothing else in the build notices: the
 * plan is non-empty, every path validates, and the summary counts the components
 * it did emit.
 */
function dropsHookArtifactsAdapter() {
  return makeFakeAdapter({
    id: "drops",
    profiles: [
      {
        range: ">=1.0 <2",
        source: syntheticSource(),
        matrix: { "session.start.observe": { level: "exact" } },
      },
    ],
    shimEntry: "export {};",
    agentPluginProjector: {
      namespace: "",
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
      async project(source) {
        return {
          files: source.files.map((file) => ({ path: file.path, contents: file.contents, mode: file.mode })),
          issues: [],
          summary: {
            components: { "agent-plugin.manifest": { discovered: 1, emitted: 1, skipped: 0 } },
            omissions: [],
            copiedPaths: source.files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
          },
        };
      },
    },
  });
}

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
  it("rejects nameless author metadata in check and build unless explicitly omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-author-"));
    cleanupDirs.push(dir);
    const config = join(dir, "hooknostic.config.ts");
    const output = join(dir, "dist/claude");
    await writeFile(join(dir, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "author-probe", author: { email: "maintainer@example.com" },
    }));
    const writeConfig = async (onUnsupported?: "warn") => writeFile(config, `export default ${JSON.stringify({
      components: { root: ".", targets: ["claude"], ...(onUnsupported === undefined ? {} : { onUnsupported }) },
      targets: { claude: { version: claudeHarness.recommendedRange, delivery: "package", output: "dist/claude" } },
    })};`);
    await writeConfig();
    for (const run of [runCheck, runBuild]) {
      const capture = captureIO();
      expect(await run({ config, json: true, registry: defaultAdapterRegistry(), io: capture.io })).toBe(2);
      expect(JSON.parse(capture.out()).diagnostics).toContainEqual(expect.objectContaining({
        code: "HN205", severity: "error", component: "agent-plugin.manifest",
      }));
      expect(existsSync(output)).toBe(false);
    }
    await writeConfig("warn");
    const capture = captureIO();
    expect(await runBuild({ config, json: true, registry: defaultAdapterRegistry(), io: capture.io })).toBe(0);
    expect(JSON.parse(await readFile(join(output, ".claude-plugin/plugin.json"), "utf8"))).not.toHaveProperty("author");
    expect(JSON.parse(capture.out()).targets.claude.projection.omissions).toEqual([
      expect.objectContaining({ component: "agent-plugin.manifest", name: "author" }),
    ]);
  });
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
    "does not inventory a previous package output as source on the next build",
    { timeout: 120_000 },
    async () => {
      // With `root: "."` the output sits inside the inventory root.
      // If it is not excluded, build N+1 copies build N's package into the new
      // one and the tree nests a level deeper every run.
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-repackage-"));
      cleanupDirs.push(dir);
      await mkdir(join(dir, "skills/probe"), { recursive: true });
      await writeFile(
        join(dir, "plugin.json"),
        JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "repack", version: "1.0.0" }),
      );
      await writeFile(join(dir, "skills/probe/SKILL.md"), "---\nname: probe\ndescription: Probe\n---\n");
      await writeFile(
        join(dir, "hooknostic.config.ts"),
        `export default {
          components: { root: ".", targets: ["copy"] },
          targets: {
            copy: {
              version: ">=1.0 <2",
              delivery: "package",
              output: "./dist/copy",
            },
          },
        };`,
      );

      const copiedCounts: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        const json = captureIO();
        expect(
          await runBuild({
            config: join(dir, "hooknostic.config.ts"),
            json: true,
            registry: { copy: copyThroughAdapter() },
            io: json.io,
            evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
          }),
          json.out(),
        ).toBe(0);
        copiedCounts.push(JSON.parse(json.out()).targets.copy.projection.copiedFileCount);
      }

      // Two files, unchanged across runs: the count grew 2 -> 4 -> 6 before the fix.
      expect(copiedCounts).toEqual([2, 2, 2]);
      // The manifest is what a nested copy would duplicate first.
      expect(existsSync(join(dir, "dist/copy/dist/copy/plugin.json"))).toBe(false);
      // `dist/` itself survives as an EMPTY directory: only its contents are
      // excluded, and the loader preserves empty package directories on purpose
      // (an MCP `cwd` may be one). Nothing from a previous build is inside it.
      expect(existsSync(join(dir, "dist/copy/dist/copy"))).toBe(false);
    },
  );

  it(
    "fails a target whose projection drops the compiled hook artifacts",
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-drophooks-"));
      cleanupDirs.push(dir);
      await writeFile(
        join(dir, "plugin.json"),
        JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "drops", version: "1.0.0" }),
      );
      await writeFile(
        join(dir, "hooks.ts"),
        `import { definePlugin, hook } from "@hooknostic/sdk";
         export default definePlugin({ name: "drops", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
      );
      await writeFile(
        join(dir, "hooknostic.config.ts"),
        `export default {
          entry: "./hooks.ts",
          components: { root: ".", targets: ["drops"] },
          targets: { drops: { version: ">=1.0 <2", delivery: "package", output: "./dist/drops" } },
        };`,
      );

      const capture = captureIO();
      expect(
        await runBuild({
          config: join(dir, "hooknostic.config.ts"),
          json: true,
          registry: { drops: dropsHookArtifactsAdapter() },
          io: capture.io,
          evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
        }),
        capture.out(),
      ).toBe(2);
      const report = JSON.parse(capture.out());
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HN301",
          severity: "error",
          target: "drops",
          message: expect.stringContaining("fake-plugin.json"),
        }),
      );
      expect(report.targets.drops.status).toBe("failed");
      // The package the projector did produce must not reach disk: it would be
      // an installable plugin with no hooks in it.
      expect(existsSync(join(dir, "dist/drops"))).toBe(false);
    },
  );

  it(
    "projects one Agent Plugin into three native plugins without modifying the source",
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
      expect(report.components.targets).toEqual(["claude", "codex", "opencode"]);
      for (const id of ["claude", "codex", "opencode"]) {
        expect(report.targets[id].projection, id).toMatchObject({ status: "success" });
      }

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
        args: ["${CLAUDE_PLUGIN_ROOT}/runtime/mcp-launcher.mjs", "${CLAUDE_PLUGIN_ROOT}", "node", "${CLAUDE_PLUGIN_ROOT}/src/greet-mcp.mjs"],
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

      // Every harness gets all three components in one installable unit; the
      // Codex manifest naming its hooks is what a local-mode target would
      // silently omit.
      const codexManifest = JSON.parse(
        await readFile(join(dir, "dist/codex/.codex-plugin/plugin.json"), "utf8"),
      );
      expect(codexManifest).toMatchObject({
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        hooks: "./hooks.json",
      });
      expect(existsSync(join(dir, "dist/codex/skills/greet/SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, "dist/opencode/.opencode/plugins/package/skills/greet/SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, "dist/opencode/.opencode/plugins/hooknostic.js"))).toBe(true);
      // The MCP server's implementation, which its argv names with
      // ${PLUGIN_ROOT}: shipping the argv without the file is a server that
      // cannot start, reported emitted.
      expect(existsSync(join(dir, "dist/opencode/.opencode/plugins/package/src/greet-mcp.mjs"))).toBe(true);

      // `runtimePackage` is a Claude-only component, which is why the example
      // sets onUnsupported: "warn" -- the other two record the omission.
      for (const id of ["codex", "opencode"]) {
        expect(report.targets[id].projection.omissions, id).toContainEqual(
          expect.objectContaining({ component: "agent-plugin.runtime-package" }),
        );
      }
    },
  );

  it("preserves an empty package directory used as MCP cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-empty-cwd-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "worker"));
    await writeFile(join(dir, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "empty-cwd",
    }));
    await writeFile(join(dir, "mcp.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: { worker: {
        type: "stdio", command: "node", cwd: "./worker/",
        args: ["-e", "console.log(process.cwd())"],
      }, rooted: {
        type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/worker",
        args: ["-e", "console.log(process.cwd())"],
      } },
    }));
    await writeFile(join(dir, "hooknostic.config.ts"), `export default {
      components: { root: ".", targets: ["claude"] },
      targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist" } }
    };`);
    const capture = captureIO();
    expect(await runBuild({ config: join(dir, "hooknostic.config.ts"), json: true,
      registry: defaultAdapterRegistry(), io: capture.io }), capture.out()).toBe(0);
    const output = join(dir, "dist");
    expect(existsSync(join(output, "worker"))).toBe(true);
    const servers = JSON.parse(await readFile(join(output, ".mcp.json"), "utf8")).mcpServers;
    for (const name of ["worker", "rooted"]) {
      const child = spawnSync(process.execPath,
        servers[name].args.map((arg: string) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", output)),
        { encoding: "utf8", timeout: 10_000 });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe(join(output, "worker"));
    }
    expect(JSON.parse(capture.out()).targets.claude.projection.directories).toEqual(["worker"]);

    // An overlay file cannot replace a directory the MCP process needs.
    await mkdir(join(dir, "com.anthropic.claude-code"));
    await writeFile(join(dir, "com.anthropic.claude-code/worker"), "collision");
    const check = captureIO();
    expect(await runCheck({ config: join(dir, "hooknostic.config.ts"), json: true,
      registry: defaultAdapterRegistry(), io: check.io })).toBe(2);
    expect(JSON.parse(check.out()).diagnostics).toContainEqual(expect.objectContaining({
      code: "HN301", message: expect.stringContaining("invalid directory path"),
    }));
  });

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
        components: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } }
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
    expect(report.components.sourceFiles).toEqual(["plugin.json", "skills/review/SKILL.md"]);
    expect(report.components.sourceFileCount).toBe(2);
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
        components: { root: ".", targets: ["partial"], onUnsupported: "warn" },
        targets: { partial: { version: ">=1.0 <2", delivery: "package", output: "./dist/partial" } }
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

  it("projects an OpenCode project plugin carrying skills, MCP and hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-opencode-plugin-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "skills/review"), { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "oc-trio", version: "1.4.0" }),
    );
    await writeFile(join(dir, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          local: {
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: { TOKEN: "${MY_TOKEN}" },
          },
          streamed: {
            type: "sse",
            url: "https://example.invalid/sse",
            headers: { Authorization: "Bearer ${MY_TOKEN}" },
          },
        },
      }),
    );
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "oc-trio", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        components: { root: ".", targets: ["opencode"] },
        targets: {
          opencode: {
            version: "${opencodeHarness.recommendedRange}",
            delivery: "package",
            output: "./dist/opencode",
            compatibility: { minimum: "approximate" },
          },
        },
      };`,
    );
    const json = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: json.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      json.out(),
    ).toBe(0);

    // The hook module and the package module are siblings; OpenCode loads every
    // module in this directory, and does not recurse into `skills/`.
    expect(existsSync(join(dir, "dist/opencode/.opencode/plugins/hooknostic.js"))).toBe(true);
    expect(existsSync(join(dir, "dist/opencode/.opencode/plugins/package/skills/review/SKILL.md"))).toBe(true);
    const injector = await readFile(
      join(dir, "dist/opencode/.opencode/plugins/hooknostic-agent-plugin.js"),
      "utf8",
    );

    // Agent Plugins 1.0 defines two placeholders and requires unrecognized
    // placeholder-like text to stay literal, so ${MY_TOKEN} reaches the harness
    // as written. The module resolves the install directory and nothing else --
    // expanding it here would put a host value in a package-chosen destination.
    expect(injector).not.toContain("{env:MY_TOKEN}");
    expect(injector).not.toContain("process.env");
    // The declared environment reaches the launcher through the servers
    // document, not through OpenCode's `environment` key, and its unrecognized
    // placeholder-like text stays literal on the way.
    const servers = JSON.parse(
      await readFile(
        join(dir, "dist/opencode/.opencode/plugins/hooknostic-runtime/mcp-servers.json"),
        "utf8",
      ),
    );
    expect(servers.servers[0]).toMatchObject({
      name: "local",
      env: { TOKEN: "${MY_TOKEN}" },
    });
    // The servers are embedded as JSON text and parsed at load time, so a
    // server named `__proto__` stays an own property instead of becoming an
    // object literal's prototype.
    const embedded = JSON.parse(
      JSON.parse(injector.match(/const mcpServers = JSON\.parse\((.*)\);/)![1]!) as string,
    ) as Record<string, Record<string, unknown>>;
    // Every stdio server registers the same way: the launcher supplies the
    // contract OpenCode binds none of.
    expect(embedded["local"]).toMatchObject({
      type: "local",
      command: ["node", "__HOOKNOSTIC_LAUNCHER__", "0"],
    });
    expect(embedded["local"]).not.toHaveProperty("environment");
    // sse has no OpenCode discriminator; both remote transports become `remote`.
    expect(embedded["streamed"]).toMatchObject({ type: "remote" });
    // The install directory is only knowable at load time.
    expect(injector).toContain("__HOOKNOSTIC_PLUGIN_ROOT__");
    expect(injector).toContain("import.meta.url");

    const report = JSON.parse(json.out());
    expect(report.targets.opencode.projection.components).toMatchObject({
      "agent-plugin.skills": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
      "agent-plugin.mcp.stdio": { support: "emulated", discovered: 1, emitted: 1, skipped: 0 },
      "agent-plugin.mcp.sse": { support: "emulated", discovered: 1, emitted: 1, skipped: 0 },
    });
  });

  it("requires an explicit project root for project component delivery", async () => {
    // `local` mode emits .codex/hooks.json with a session-relative command. The
    // native manifest has no key for it, so the projection would install skills
    // and MCP that work beside hooks that silently never run -- and every other
    // check passes, because the artifacts are present and valid, just unread.
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-codex-localmode-"));
    cleanupDirs.push(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "codex-local", version: "1.0.0" }),
    );
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "codex-local", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        components: { root: ".", targets: ["codex"] },
        targets: {
          codex: { version: "${CODEX_PLUGIN_MODE_RANGE}", delivery: "project", output: "./dist/codex" },
        },
      };`,
    );
    const json = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: json.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      json.out(),
    ).toBe(2);
    const report = JSON.parse(json.out());
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining('project component delivery requires project.root'),
      }),
    );
    expect(existsSync(join(dir, "dist/codex"))).toBe(false);
  });

  it("projects a Codex plugin carrying skills, MCP and hooks in one output", async () => {
    // The three components share one native manifest, and the portable one must
    // NOT survive beside it: Codex prefers a root plugin.json and would then
    // ignore the hooks key entirely (.capture/codex-plugin-hooks).
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-codex-plugin-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "skills/review"), { recursive: true });
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
        name: "codex-trio",
        version: "2.1.0",
        description: "carries all three",
      }),
    );
    await writeFile(join(dir, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          local: { type: "stdio", command: "node", args: ["server.mjs"] },
          remote: {
            type: "streamable-http",
            url: "https://example.invalid/mcp",
            headers: { Authorization: "Bearer literal" },
          },
        },
      }),
    );
    await writeFile(
      join(dir, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
       export default definePlugin({ name: "codex-trio", hooks: [hook("session.start", { id: "s", async run() {} })] });`,
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        entry: "./hooks.ts",
        components: { root: ".", targets: ["codex"] },
        targets: {
          codex: { version: "${CODEX_PLUGIN_MODE_RANGE}", delivery: "package", output: "./dist/codex" },
        },
      };`,
    );
    const json = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        registry: defaultAdapterRegistry(),
        io: json.io,
        evaluate: { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } },
      }),
      json.out(),
    ).toBe(0);

    const manifest = JSON.parse(
      await readFile(join(dir, "dist/codex/.codex-plugin/plugin.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      name: "codex-trio",
      version: "2.1.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      hooks: "./hooks.json",
    });
    // A root plugin.json would outrank the native one and suppress the hooks.
    expect(existsSync(join(dir, "dist/codex/plugin.json"))).toBe(false);
    expect(existsSync(join(dir, "dist/codex/mcp.json"))).toBe(false);
    expect(existsSync(join(dir, "dist/codex/skills/review/SKILL.md"))).toBe(true);

    // Native MCP shape: no type discriminator, and headers keep their values
    // under the key Codex actually reads.
    const mcp = JSON.parse(await readFile(join(dir, "dist/codex/.mcp.json"), "utf8"));
    // Every stdio server registers through the launcher, which supplies the
    // contract the native route implements none of. `cwd: "."` is what makes
    // the relative argv resolve: the route joins a declared cwd to the plugin
    // root, and a server declaring none never starts
    // (.capture/codex-native-mcp).
    expect(mcp.mcpServers.local).toEqual({
      command: "node",
      args: ["./runtime/mcp-launcher.mjs", "0"],
      cwd: ".",
    });
    const servers = JSON.parse(
      await readFile(join(dir, "dist/codex/runtime/mcp-servers.json"), "utf8"),
    );
    expect(servers.servers[0]).toMatchObject({ name: "local", command: "node" });
    expect(mcp.mcpServers.remote).toEqual({
      url: "https://example.invalid/mcp",
      http_headers: { Authorization: "Bearer literal" },
    });
    expect(mcp).not.toHaveProperty("$schema");

    // A relative command would resolve against the session cwd, not the cache.
    const hooks = JSON.parse(await readFile(join(dir, "dist/codex/hooks.json"), "utf8"));
    const commands = Object.values(
      hooks.hooks as Record<string, { hooks: { command: string }[] }[]>,
    ).flatMap((groups) => groups.flatMap((group) => group.hooks.map((entry) => entry.command)));
    expect(commands).toEqual(['node "${PLUGIN_ROOT}/hooknostic/hooknostic.mjs"']);
    expect(existsSync(join(dir, "dist/codex/hooknostic/hooknostic.mjs"))).toBe(true);

    const report = JSON.parse(json.out());
    expect(report.targets.codex.projection.components).toMatchObject({
      "agent-plugin.skills": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
      "agent-plugin.mcp.stdio": { support: "emulated", discovered: 1, emitted: 1, skipped: 0 },
      "agent-plugin.mcp.streamable-http": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
    });
  });

  it("reports a natively projected component the harness cannot consume as an omission", async () => {
    // Codex has no sse transport, and its native reader would register an sse
    // server as a streamable_http connection to the same url, so the projector
    // drops it. The build must report that as skipped, not emitted.
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-native-omission-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "pkg"), { recursive: true });
    await writeFile(
      join(dir, "pkg/plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "native-omission", version: "1.0.0" }),
    );
    await writeFile(
      join(dir, "pkg/mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          stdio: { type: "stdio", command: "node" },
          streamed: { type: "sse", url: "https://example.invalid/sse" },
        },
      }),
    );
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        components: { root: "./pkg", targets: ["codex"], onUnsupported: "warn" },
        targets: {
          codex: {
            version: "${CODEX_PLUGIN_MODE_RANGE}",
            delivery: "package",
            output: "./dist/codex",
          },
        },
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
      json.out(),
    ).toBe(0);
    const report = JSON.parse(json.out());
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", severity: "warn", component: "agent-plugin.mcp.sse" }),
    );
    expect(report.targets.codex.projection.components).toMatchObject({
      "agent-plugin.mcp.stdio": { support: "emulated", discovered: 1, emitted: 1, skipped: 0 },
      "agent-plugin.mcp.sse": { support: "unsupported", discovered: 1, emitted: 0, skipped: 1 },
    });
    expect(report.targets.codex.projection.omissions).toEqual([
      expect.objectContaining({ component: "agent-plugin.mcp.sse" }),
    ]);
    // The emitted MCP file is native-shaped and carries only what Codex can
    // actually speak; the portable one is gone because it would outrank the
    // native manifest and suppress hooks.
    const shipped = JSON.parse(await readFile(join(dir, "dist/codex/.mcp.json"), "utf8"));
    expect(Object.keys(shipped.mcpServers)).toEqual(["stdio"]);
    expect(shipped.mcpServers.stdio).not.toHaveProperty("type");
    expect(existsSync(join(dir, "dist/codex/mcp.json"))).toBe(false);
    expect(existsSync(join(dir, "dist/codex/plugin.json"))).toBe(false);
    expect(existsSync(join(dir, "dist/codex/.codex-plugin/plugin.json"))).toBe(true);
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
    await mkdir(join(dir, "dist/noproj"), { recursive: true });
    await writeFile(join(dir, "dist/noproj/previous"), "previous output");
    // Hookless, so the only thing this target could ever receive is the package.
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        components: { root: ".", targets: ["noproj"], onUnsupported: "warn" },
        targets: { noproj: { version: ">=1.0 <2", delivery: "package", output: "./dist/noproj" } }
      };`,
    );
    const json = captureIO();
    expect(
      await runBuild({
        config: join(dir, "hooknostic.config.ts"),
        json: true,
        // Every shipped adapter now has a projector, so the projector-less
        // case only exists as a double.
        registry: { noproj: noProjectorAdapter() },
        io: json.io,
      }),
    ).toBe(2);
    const report = JSON.parse(json.out());
    expect(report.targets.noproj.status).toBe("failed");
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: "HN205", severity: "error", target: "noproj", message: expect.stringContaining("no Agent Plugin projector") }),
    ]);
    // Nothing was committed: the previous output survives untouched, and the
    // "success" that used to accompany an empty directory is gone.
    expect(await readFile(join(dir, "dist/noproj/previous"), "utf8")).toBe("previous output");
    expect(existsSync(join(dir, "hooknostic-build.json"))).toBe(false);

    const human = captureIO();
    expect(
      await runBuild({ config: join(dir, "hooknostic.config.ts"), registry: { noproj: noProjectorAdapter() }, io: human.io }),
    ).toBe(2);
    expect(human.out()).toContain("FAIL   noproj");
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
        components: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } }
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

  it("projects declared executable files and keeps both digests independent of host modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-executable-"));
    cleanupDirs.push(dir);
    await mkdir(join(dir, "source/skills/review"), { recursive: true });
    await writeFile(join(dir, "source/plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "executable" }));
    await writeFile(join(dir, "source/skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
    const script = "skills/review/tool.sh";
    await writeFile(join(dir, "source", script), "#!/bin/sh\necho portable\n");
    const config = join(dir, "hooknostic.config.ts");
    await writeFile(config, `export default {
      components: { root: "source", targets: ["claude"], executableFiles: [${JSON.stringify(script)}] },
      targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "dist" } }
    };`);
    const build = async () => {
      const io = captureIO();
      expect(await runBuild({ config, json: true, registry: defaultAdapterRegistry(), io: io.io }), io.out() + io.err()).toBe(0);
      return JSON.parse(io.out());
    };
    await chmod(join(dir, "source", script), 0o600);
    const first = await build();
    const source = await loadAgentPlugin({ root: join(dir, "source"), executableFiles: [script] });
    expect(first.components.contentDigest).toBe(source.package?.contentDigest);
    if (process.platform !== "win32") expect((await stat(join(dir, "dist", script))).mode & 0o777).toBe(0o755);
    await chmod(join(dir, "source", script), 0o777);
    expect(await build()).toEqual(first);
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
        components: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } }
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
    expect(report.components.sourceFiles).toEqual(["plugin.json", "src/server.mjs"]);
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

  it.each(["out[1]", "out{a,b}", "#output", "!output"])(
    "excludes literal output %s from the next build inventory", async (output) => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-literal-output-"));
      cleanupDirs.push(dir);
      await writeFile(join(dir, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "literal-output" }));
      await writeFile(join(dir, "hooknostic.config.ts"), `export default {
        components: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: ${JSON.stringify(output)} } }
      };`);
      for (let build = 0; build < 2; build++) {
        const capture = captureIO();
        expect(await runBuild({
          config: join(dir, "hooknostic.config.ts"), json: true,
          registry: defaultAdapterRegistry(), io: capture.io,
        }), capture.out()).toBe(0);
        expect(JSON.parse(capture.out()).components.sourceFiles).toEqual(["plugin.json"]);
        expect(existsSync(join(dir, output, ".claude-plugin/plugin.json"))).toBe(true);
        expect(existsSync(join(dir, output, output))).toBe(false);
      }
    },
  );

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
        components: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./link/claude" } }
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
    expect(JSON.parse(capture.out()).components.sourceFiles).toEqual(["plugin.json"]);
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
        components: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } }
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
    expect(JSON.parse(capture.out()).components.sourceFiles).toEqual(["plugin.json"]);
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
        components: { root: "../alias", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } }
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
    expect(JSON.parse(capture.out()).components.sourceFiles).toEqual(["plugin.json"]);
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
        components: { root: "./alias", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./alias/dist/claude" } }
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
    expect(JSON.parse(capture.out()).components.sourceFiles).toEqual(["plugin.json"]);
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
        components: { root: ".", targets: ["claude"]${policy} },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } }
      };`;

    await writeFile(join(dir, "hooknostic.config.ts"), config(""));
    const strict = captureIO();
    expect(
      await runBuild({ config: join(dir, "hooknostic.config.ts"), json: true, registry: defaultAdapterRegistry(), io: strict.io }),
    ).toBe(2);
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

  it("reports a missing direct MCP source in the JSON build result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-missing-direct-mcp-"));
    cleanupDirs.push(dir);
    await writeFile(
      join(dir, "hooknostic.config.ts"),
      `export default {
        project: { root: "." },
        components: { mcp: "./missing-mcp.json", onInvalid: "warn" },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "project", output: "./.hooknostic/artifacts/claude" } }
      };`,
    );
    const capture = captureIO();

    await expect(runBuild({
      config: join(dir, "hooknostic.config.ts"),
      json: true,
      registry: defaultAdapterRegistry(),
      io: capture.io,
    })).resolves.toBe(2);
    expect(JSON.parse(capture.out()).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN503",
        severity: "error",
        message: expect.stringContaining("could not load direct MCP source"),
      }),
    );
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
        components: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } }
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
    ).toBe(2);
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
        components: { root: ".", targets: ["claude"] },
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } }
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
    ).toBe(2);
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
            claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" },
            opencode: { version: "${opencodeHarness.recommendedRange}", delivery: "package", output: "./dist/opencode" },
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
      expect(code).toBe(2);

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
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "." } },
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
    ).toBe(2);
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
        targets: { claude: { version: "${claudeHarness.recommendedRange}", delivery: "package", output: "./dist/claude" } },
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
    ).toBe(2);
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
  it("inspects hooks outside the projection version range", async () => {
    const registry = defaultAdapterRegistry();
    const adapter = registry.claude!;
    // Deliberately narrower projection coverage than the hook profile.
    registry.claude = { ...adapter, agentPluginProjector: {
      ...adapter.agentPluginProjector!, profiles: [],
    } };
    const capture = captureIO();
    expect(await runInspect({ target: "claude", capability: "tool.before.block",
      json: true, registry, io: capture.io }), capture.err()).toBe(0);
    expect(JSON.parse(capture.out()).capabilities).toEqual([
      { capability: "tool.before.block", level: "exact" },
    ]);
    const component = captureIO();
    expect(await runInspect({ target: "claude", component: "agent-plugin.manifest",
      registry, io: component.io })).toBe(2);
    expect(component.err()).toContain("HN203");
  });

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
    const failure = JSON.parse(invalidCapability.out());
    expect(failure.ok).toBe(false);
    expect(failure.errors.join("\n")).toContain("unknown capability");
    expect(failure.errors.join("\n")).toContain("without --capability");
  });
});
