import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA, parseMarkdownFrontmatter } from "@hooknostic/agent-plugin";

import { CODEX_PLUGIN_MODE_RANGE } from "../../adapter-codex/src/generate.js";
import { opencodeV1Adapter, opencodeV2Harness } from "../../adapter-opencode/src/index.js";
import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { buildProject } from "./build.js";
import { runProject } from "./project.js";
import { readProjectToml } from "./project-toml.js";

const dirs: string[] = [];
const evaluate = { alias: { "@hooknostic/sdk": fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)) } };
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const REVIEWER = [
  "---",
  "name: reviewer",
  "description: Reviews diffs for correctness. Use after code changes.",
  "native:",
  "  claude:",
  "    model: sonnet",
  "    tools: [Read, Grep]",
  "  codex:",
  "    model: gpt-probe",
  "    model_reasoning_effort: low",
  "  opencode:",
  "    temperature: 0.1",
  "---",
  'You review diffs. Quote "exact" lines.',
  "",
].join("\n");

/** A hookless project whose only component is the given subagent directory. */
async function fixture(definitions: Record<string, string>, options: { v2?: boolean; subagents?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-subagents-"));
  dirs.push(root);
  await mkdir(join(root, "agents"), { recursive: true });
  for (const [file, text] of Object.entries(definitions)) await writeFile(join(root, "agents", file), text);
  const registry = defaultAdapterRegistry();
  if (!options.v2) registry.opencode = opencodeV1Adapter();
  const targets = Object.fromEntries(
    Object.entries(registry).map(([name, adapter]) => [
      name,
      {
        adapter: name,
        version:
          name === "opencode" && options.v2 ? opencodeV2Harness.recommendedRange : adapter.harness.recommendedRange,
        delivery: "project",
        output: `.hooknostic/artifacts/${name}`,
      },
    ]),
  );
  const config = { project: { root: "." }, components: { subagents: options.subagents ?? ["./agents"] }, targets };
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(configPath, `export default ${JSON.stringify(config)};`);
  return { root, options: { configPath, registry, evaluate } };
}

describe("subagent project delivery", () => {
  it("writes each harness's native file, owns it, and detects a changed definition", async () => {
    const { root, options } = await fixture({ "reviewer.md": REVIEWER });

    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);

    const claude = parseMarkdownFrontmatter(await readFile(join(root, ".claude/agents/reviewer.md"), "utf8"), "claude");
    expect(claude).toEqual({
      data: {
        name: "reviewer",
        description: "Reviews diffs for correctness. Use after code changes.",
        model: "sonnet",
        tools: ["Read", "Grep"],
      },
      body: 'You review diffs. Quote "exact" lines.\n',
    });
    expect(readProjectToml(await readFile(join(root, ".codex/agents/reviewer.toml"), "utf8"))).toEqual({
      name: "reviewer",
      description: "Reviews diffs for correctness. Use after code changes.",
      developer_instructions: 'You review diffs. Quote "exact" lines.\n',
      model: "gpt-probe",
      model_reasoning_effort: "low",
    });
    const opencode = parseMarkdownFrontmatter(
      await readFile(join(root, ".opencode/agents/reviewer.md"), "utf8"),
      "opencode",
    );
    expect(opencode.data).toEqual({
      description: "Reviews diffs for correctness. Use after code changes.",
      mode: "subagent",
      temperature: 0.1,
    });
    for (const directory of [".claude/agents", ".opencode/agents"]) {
      expect(await readFile(join(root, directory, ".gitattributes"), "utf8")).toBe(
        ".gitattributes -text\nreviewer.md -text\n",
      );
    }
    expect(await readFile(join(root, ".codex/agents/.gitattributes"), "utf8")).toBe(
      ".gitattributes -text\nreviewer.toml -text\n",
    );

    const built = await buildProject({ ...options, dryRun: true });
    for (const target of ["claude", "codex", "opencode"]) {
      expect(built.report.targets[target]?.project?.components, target).toMatchObject({
        "subagents.definition": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
        "subagents.native": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
      });
    }

    await writeFile(join(root, "agents/reviewer.md"), REVIEWER.replace("You review diffs.", "You audit diffs."));
    expect((await runProject({ ...options, command: "verify" })).drift).toBe(true);
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(await readFile(join(root, ".claude/agents/reviewer.md"), "utf8")).toContain("You audit diffs.");
  }, 60_000);

  it("writes mode: subagent for OpenCode v2, whose default is primary", async () => {
    const { root, options } = await fixture({ "reviewer.md": REVIEWER }, { v2: true });

    const synced = await runProject({ ...options, command: "sync" });

    expect(synced.errors).toEqual([]);
    const opencode = parseMarkdownFrontmatter(
      await readFile(join(root, ".opencode/agents/reviewer.md"), "utf8"),
      "opencode",
    );
    expect(opencode.data).toMatchObject({ mode: "subagent" });
  }, 60_000);

  it("refuses native fields for a harness no adapter knows", async () => {
    const { options } = await fixture({
      "reviewer.md": REVIEWER.replace("  claude:\n", "  cluade:\n"),
    });

    const built = await buildProject({ ...options, dryRun: true });

    expect(built.ok).toBe(false);
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN503",
        severity: "error",
        component: "subagents.native",
        message: expect.stringContaining('unknown harness "cluade"'),
      }),
    );
  });

  it("refuses a native field the harness reserves, on that target only", async () => {
    const { options } = await fixture({
      "reviewer.md": REVIEWER.replace("    model: sonnet\n", "    hooks: {}\n"),
    });

    const built = await buildProject({ ...options, dryRun: true });

    const refused = built.report.diagnostics.filter((diagnostic) => diagnostic.code === "HN503");
    expect(refused).toEqual([
      expect.objectContaining({
        target: "claude",
        component: "subagents.native",
        message: expect.stringContaining("native.claude.hooks"),
      }),
    ]);
  });

  it("refuses definitions kept inside a harness's own agents directory", async () => {
    const { root, options } = await fixture({}, { subagents: ["./.claude/agents"] });
    await mkdir(join(root, ".claude/agents"), { recursive: true });
    await writeFile(join(root, ".claude/agents/reviewer.md"), REVIEWER);

    const built = await buildProject({ ...options, dryRun: true });

    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN501",
        target: "claude",
        component: "subagents.definition",
        message: expect.stringContaining("where claude reads its own agent files"),
      }),
    );
  });
});

/** A hookless package build whose subagents are configured beside the package root. */
async function packageFixture(
  definitions: Record<string, string>,
  options: {
    targets?: Record<string, { version: string }>;
    subagents?: string;
    components?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-package-subagents-"));
  dirs.push(root);
  const directory = options.subagents ?? "agents";
  await mkdir(join(root, "pkg"), { recursive: true });
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(
    join(root, "pkg/plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "portable-tools", version: "1.0.0" }),
  );
  for (const [file, text] of Object.entries(definitions)) await writeFile(join(root, directory, file), text);
  const registry = defaultAdapterRegistry();
  const targets = Object.fromEntries(
    Object.entries(options.targets ?? { claude: { version: registry.claude!.harness.recommendedRange } }).map(
      ([name, target]) => [name, { ...target, delivery: "package", output: `dist/${name}` }],
    ),
  );
  const config = {
    components: { root: "./pkg", subagents: [`./${directory}`], ...options.components },
    targets,
  };
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(configPath, `export default ${JSON.stringify(config)};`);
  return { root, options: { configPath, registry, evaluate } };
}

describe("subagent package delivery", () => {
  it("projects definitions configured beside a package into the Claude plugin", async () => {
    const { root, options } = await packageFixture({ "reviewer.md": REVIEWER });

    const built = await buildProject(options);

    expect(built.report.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(built.ok).toBe(true);
    const agent = parseMarkdownFrontmatter(await readFile(join(root, "dist/claude/agents/reviewer.md"), "utf8"), "a");
    expect(agent.data).toEqual({
      name: "reviewer",
      description: "Reviews diffs for correctness. Use after code changes.",
      model: "sonnet",
      tools: ["Read", "Grep"],
    });
    expect(built.report.targets["claude"]?.projection?.components).toMatchObject({
      "subagents.definition": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
      "subagents.native": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
    });
  }, 60_000);

  it("translates a definitions directory inside the package root instead of shipping it", async () => {
    // Copied verbatim, pkg/agents/reviewer.md would land on the very path the
    // translation is emitted at, and Claude would read the portable file --
    // `native:` block and all -- as its own agent.
    const { root, options } = await packageFixture({ "reviewer.md": REVIEWER }, { subagents: "pkg/agents" });

    const built = await buildProject(options);

    expect(built.report.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const agent = parseMarkdownFrontmatter(await readFile(join(root, "dist/claude/agents/reviewer.md"), "utf8"), "a");
    expect(agent.data).not.toHaveProperty("native");
    expect(agent.data).toMatchObject({ model: "sonnet" });
  }, 60_000);

  it("refuses subagents for a Codex package, which has no agents route, unless told to warn", async () => {
    const targets = { codex: { version: CODEX_PLUGIN_MODE_RANGE } };
    const refused = await buildProject({
      ...(await packageFixture({ "reviewer.md": REVIEWER }, { targets })).options,
      dryRun: true,
    });
    expect(refused.ok).toBe(false);
    expect(refused.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", target: "codex", component: "subagents.definition" }),
    );

    const warned = await buildProject({
      ...(await packageFixture({ "reviewer.md": REVIEWER }, { targets, components: { onUnsupported: "warn" } }))
        .options,
      dryRun: true,
    });
    expect(warned.ok).toBe(true);
    expect(warned.report.targets["codex"]?.projection?.components).toMatchObject({
      "subagents.definition": { support: "unsupported", discovered: 1, emitted: 0, skipped: 1 },
    });
  }, 60_000);

  it("refuses a native field the harness reserves, as project delivery does", async () => {
    const { options } = await packageFixture({
      "reviewer.md": REVIEWER.replace("    model: sonnet\n", "    hooks: {}\n"),
    });

    const built = await buildProject({ ...options, dryRun: true });

    expect(built.ok).toBe(false);
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN503",
        target: "claude",
        component: "subagents.native",
        message: expect.stringContaining("native.claude.hooks"),
      }),
    );
  }, 60_000);

  it("fails on a native field a Claude plugin agent ignores, unless it is accepted", async () => {
    const definition = { "reviewer.md": REVIEWER.replace("    model: sonnet\n", "    permissionMode: plan\n") };

    const failed = await buildProject({ ...(await packageFixture(definition)).options, dryRun: true });
    expect(failed.ok).toBe(false);
    expect(failed.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN101", severity: "error", target: "claude" }),
    );

    const accepted = await buildProject({
      ...(await packageFixture(definition, { components: { accept: ["claude:plugin-agent-field-ignored"] } })).options,
      dryRun: true,
    });
    expect(accepted.ok).toBe(true);
  }, 60_000);
});
