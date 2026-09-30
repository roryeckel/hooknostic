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

/** A primary-only agent with a native model on every harness. */
const PLANNER = [
  "---",
  "name: planner",
  "description: Plans a change before any code is written.",
  "mode: primary",
  "native:",
  "  claude:",
  "    model: opus",
  "  opencode:",
  "    model: provider/planner-model",
  "---",
  "You plan changes.",
  "",
].join("\n");

/** An agent offered both ways. */
const WRITER = ["---", "name: writer", "description: Writes docs.", "mode: all", "---", "You write docs.", ""].join(
  "\n",
);

/** A hookless project whose only component is the given agent definition directory. */
async function fixture(
  definitions: Record<string, string>,
  options: { v2?: boolean; agents?: string[]; components?: Record<string, unknown> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-agents-"));
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
  const config = {
    project: { root: "." },
    components: { agents: options.agents ?? ["./agents"], ...options.components },
    targets,
  };
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(configPath, `export default ${JSON.stringify(config)};`);
  return { root, options: { configPath, registry, evaluate } };
}

describe("agent definition project delivery", () => {
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
        "agents.definition": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
        "agents.native": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
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

  it("delivers each mode where the harness can, and says where it cannot", async () => {
    const { root, options } = await fixture(
      { "planner.md": PLANNER, "reviewer.md": REVIEWER, "writer.md": WRITER },
      { components: { onUnsupported: "warn" } },
    );

    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);

    // OpenCode enforces the mode, so it is written as authored.
    for (const [name, mode] of [
      ["planner", "primary"],
      ["reviewer", "subagent"],
      ["writer", "all"],
    ] as const) {
      const opencode = parseMarkdownFrontmatter(
        await readFile(join(root, `.opencode/agents/${name}.md`), "utf8"),
        name,
      );
      expect(opencode.data, name).toMatchObject({ mode });
    }
    // Claude has no mode: one file serves every use.
    const claude = parseMarkdownFrontmatter(await readFile(join(root, ".claude/agents/planner.md"), "utf8"), "claude");
    expect(claude.data).toEqual({
      name: "planner",
      description: "Plans a change before any code is written.",
      model: "opus",
    });
    // Codex cannot run a session as an agent: the `all` agent is still a
    // custom agent, and the primary-only one has nothing to deliver.
    expect(readProjectToml(await readFile(join(root, ".codex/agents/writer.toml"), "utf8"))).toMatchObject({
      name: "writer",
    });
    await expect(readFile(join(root, ".codex/agents/planner.toml"), "utf8")).rejects.toThrow();

    const built = await buildProject({ ...options, dryRun: true });
    const targets = built.report.targets;
    expect(targets["codex"]?.project?.components).toMatchObject({
      "agents.definition": { support: "exact", discovered: 3, emitted: 2, skipped: 1 },
      "agents.primary": { support: "unsupported", discovered: 2, emitted: 0, skipped: 2 },
    });
    expect(targets["codex"]?.project?.omissions).toContainEqual(
      expect.objectContaining({ component: "agents.definition", name: "planner" }),
    );
    for (const target of ["claude", "opencode"]) {
      expect(targets[target]?.project?.components, target).toMatchObject({
        "agents.definition": { support: "exact", discovered: 3, emitted: 3, skipped: 0 },
        "agents.primary": { support: "exact", discovered: 2, emitted: 2, skipped: 0 },
      });
    }
    // Claude offers every agent for delegation, which a primary-only one is
    // not meant to be; an `all` agent is meant to be.
    expect(targets["claude"]?.project?.deviations).toEqual([
      expect.objectContaining({ id: "claude:primary-agent-delegable", component: "agents.primary", name: "planner" }),
    ]);
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN106", severity: "warn", target: "claude" }),
    );
  }, 60_000);

  it("refuses a primary definition for Codex unless told to warn", async () => {
    const { options } = await fixture({ "planner.md": PLANNER });

    const built = await buildProject({ ...options, dryRun: true });

    expect(built.ok).toBe(false);
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", severity: "error", target: "codex", component: "agents.primary" }),
    );
    expect(
      built.report.diagnostics.filter((diagnostic) => diagnostic.severity === "error" && diagnostic.target !== "codex"),
    ).toEqual([]);
  }, 60_000);

  it("reports a native model OpenCode v2 ignores for a session run as the agent, and only there", async () => {
    const definitions = {
      "planner.md": PLANNER,
      // The same model on a subagent reaches it: nothing to report.
      "reviewer.md": REVIEWER.replace("    temperature: 0.1\n", "    model: provider/reviewer-model\n"),
    };
    const components = { onUnsupported: "warn" };

    const v2 = await buildProject({ ...(await fixture(definitions, { v2: true, components })).options, dryRun: true });
    expect(v2.ok).toBe(false);
    expect(v2.report.targets["opencode"]?.project?.degradations).toEqual([
      expect.objectContaining({
        id: "opencode:primary-agent-model-ignored",
        component: "agents.native",
        name: "planner",
      }),
    ]);
    expect(v2.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN101", severity: "error", target: "opencode" }),
    );

    const accepted = await buildProject({
      ...(
        await fixture(definitions, {
          v2: true,
          components: { ...components, accept: ["opencode:primary-agent-model-ignored"] },
        })
      ).options,
      dryRun: true,
    });
    expect(accepted.ok).toBe(true);

    // OpenCode v1 runs such a session on the agent's model.
    const v1 = await buildProject({ ...(await fixture(definitions, { components })).options, dryRun: true });
    expect(v1.ok).toBe(true);
    expect(v1.report.targets["opencode"]?.project?.degradations).toBeUndefined();
  }, 60_000);

  it("starts every session as the default agent, emulating it on Codex", async () => {
    const { root, options } = await fixture(
      { "planner.md": PLANNER, "reviewer.md": REVIEWER },
      { components: { defaultAgent: "planner" } },
    );

    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);

    expect(JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8"))).toMatchObject({
      agent: "planner",
    });
    expect(await readFile(join(root, ".opencode/plugins/hooknostic-components.js"), "utf8")).toContain(
      'config.default_agent = "planner";',
    );
    // Codex has no agent a session runs as: the project's configuration
    // carries the agent's instructions instead, and the primary-only planner
    // gets no custom agent file, since nothing could spawn it as one.
    expect(readProjectToml(await readFile(join(root, ".codex/config.toml"), "utf8"))).toEqual({
      developer_instructions: "You plan changes.\n",
    });
    await expect(readFile(join(root, ".codex/agents/planner.toml"), "utf8")).rejects.toThrow();

    const built = await buildProject({ ...options, dryRun: true });
    // The delivered default already runs as the session, so Codex's missing
    // main-session route does not fail the build over it.
    expect(built.ok).toBe(true);
    const targets = built.report.targets;
    expect(targets["codex"]?.project?.components).toMatchObject({
      "agents.default": { support: "emulated", discovered: 1, emitted: 1, skipped: 0 },
    });
    expect(targets["codex"]?.project?.components?.["agents.primary"]).toBeUndefined();
    for (const target of ["claude", "opencode"]) {
      expect(targets[target]?.project?.components?.["agents.default"], target).toEqual({
        support: "exact",
        discovered: 1,
        emitted: 1,
        skipped: 0,
      });
    }
  }, 60_000);

  it("sets the OpenCode v2 default through the agent editor", async () => {
    const { root, options } = await fixture(
      { "planner.md": PLANNER },
      { v2: true, components: { defaultAgent: "planner", accept: ["opencode:primary-agent-model-ignored"] } },
    );

    const synced = await runProject({ ...options, command: "sync" });

    expect(synced.errors).toEqual([]);
    const module = await readFile(join(root, ".opencode/plugins/hooknostic-components.js"), "utf8");
    expect(module).toContain('await ctx.agent.transform(editor => editor.default("planner"));');
  }, 60_000);

  it("writes only the Codex keys a default agent is known to honour, and reports the rest", async () => {
    const planner = PLANNER.replace(
      "  opencode:\n",
      "  codex:\n    model: gpt-planner\n    model_reasoning_effort: low\n    sandbox_mode: danger-full-access\n  opencode:\n",
    );
    const { root, options } = await fixture(
      { "planner.md": planner },
      { components: { defaultAgent: "planner", onUnsupported: "warn" } },
    );

    const synced = await runProject({ ...options, command: "sync" });

    expect(synced.errors).toEqual([]);
    // At the top of the project's configuration a sandbox_mode would loosen
    // every session, so it is never written there.
    expect(readProjectToml(await readFile(join(root, ".codex/config.toml"), "utf8"))).toEqual({
      developer_instructions: "You plan changes.\n",
      model: "gpt-planner",
      model_reasoning_effort: "low",
    });
    const built = await buildProject({ ...options, dryRun: true });
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN205",
        target: "codex",
        component: "agents.native",
        message: expect.stringContaining("sandbox_mode"),
      }),
    );
  }, 60_000);

  it.each([
    ["a name no definition has", "nobody", "not a loaded agent definition"],
    ["a subagent", "reviewer", "whose mode is subagent"],
  ])("refuses a default agent that is %s", async (_label, defaultAgent, message) => {
    const { options } = await fixture({ "reviewer.md": REVIEWER }, { components: { defaultAgent } });

    const built = await buildProject({ ...options, dryRun: true });

    expect(built.ok).toBe(false);
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN503",
        component: "agents.default",
        message: expect.stringContaining(message),
      }),
    );
  });

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
        component: "agents.native",
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
        component: "agents.native",
        message: expect.stringContaining("native.claude.hooks"),
      }),
    ]);
  });

  it("refuses definitions kept inside a harness's own agents directory", async () => {
    const { root, options } = await fixture({}, { agents: ["./.claude/agents"] });
    await mkdir(join(root, ".claude/agents"), { recursive: true });
    await writeFile(join(root, ".claude/agents/reviewer.md"), REVIEWER);

    const built = await buildProject({ ...options, dryRun: true });

    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN501",
        target: "claude",
        component: "agents.definition",
        message: expect.stringContaining("where claude reads its own agent files"),
      }),
    );
  });
});

/** A hookless package build whose agent definitions are configured beside the package root. */
async function packageFixture(
  definitions: Record<string, string>,
  options: {
    targets?: Record<string, { version: string }>;
    agents?: string;
    components?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-package-agents-"));
  dirs.push(root);
  const directory = options.agents ?? "agents";
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
    components: { root: "./pkg", agents: [`./${directory}`], ...options.components },
    targets,
  };
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(configPath, `export default ${JSON.stringify(config)};`);
  return { root, options: { configPath, registry, evaluate } };
}

describe("agent definition package delivery", () => {
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
      "agents.definition": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
      "agents.native": { support: "exact", discovered: 1, emitted: 1, skipped: 0 },
    });
  }, 60_000);

  it("translates a definitions directory inside the package root instead of shipping it", async () => {
    // Copied verbatim, pkg/agents/reviewer.md would land on the very path the
    // translation is emitted at, and Claude would read the portable file --
    // `native:` block and all -- as its own agent.
    const { root, options } = await packageFixture({ "reviewer.md": REVIEWER }, { agents: "pkg/agents" });

    const built = await buildProject(options);

    expect(built.report.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const agent = parseMarkdownFrontmatter(await readFile(join(root, "dist/claude/agents/reviewer.md"), "utf8"), "a");
    expect(agent.data).not.toHaveProperty("native");
    expect(agent.data).toMatchObject({ model: "sonnet" });
  }, 60_000);

  it("refuses agent definitions for a Codex package, which has no agents route, unless told to warn", async () => {
    const targets = { codex: { version: CODEX_PLUGIN_MODE_RANGE } };
    const refused = await buildProject({
      ...(await packageFixture({ "reviewer.md": REVIEWER }, { targets })).options,
      dryRun: true,
    });
    expect(refused.ok).toBe(false);
    expect(refused.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", target: "codex", component: "agents.definition" }),
    );

    const warned = await buildProject({
      ...(await packageFixture({ "reviewer.md": REVIEWER }, { targets, components: { onUnsupported: "warn" } }))
        .options,
      dryRun: true,
    });
    expect(warned.ok).toBe(true);
    expect(warned.report.targets["codex"]?.projection?.components).toMatchObject({
      "agents.definition": { support: "unsupported", discovered: 1, emitted: 0, skipped: 1 },
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
        component: "agents.native",
        message: expect.stringContaining("native.claude.hooks"),
      }),
    );
  }, 60_000);

  it("reports a primary-only agent a Claude plugin still offers for delegation", async () => {
    const { root, options } = await packageFixture({ "planner.md": PLANNER, "writer.md": WRITER });

    const built = await buildProject(options);

    expect(built.ok).toBe(true);
    expect(await readFile(join(root, "dist/claude/agents/planner.md"), "utf8")).toContain("You plan changes.");
    expect(built.report.targets["claude"]?.projection?.components).toMatchObject({
      "agents.definition": { support: "exact", discovered: 2, emitted: 2, skipped: 0 },
      "agents.primary": { support: "exact", discovered: 2, emitted: 2, skipped: 0 },
    });
    expect(built.report.targets["claude"]?.projection?.deviations).toEqual([
      expect.objectContaining({ id: "claude:primary-agent-delegable", name: "planner" }),
    ]);
  }, 60_000);

  it("does not let a package set the default agent", async () => {
    const definitions = { "planner.md": PLANNER };

    const refused = await buildProject({
      ...(await packageFixture(definitions, { components: { defaultAgent: "planner" } })).options,
      dryRun: true,
    });
    expect(refused.ok).toBe(false);
    expect(refused.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", target: "claude", component: "agents.default" }),
    );

    const { root, options } = await packageFixture(definitions, {
      components: { defaultAgent: "planner", onUnsupported: "warn" },
    });
    const warned = await buildProject(options);
    expect(warned.ok).toBe(true);
    await expect(readFile(join(root, "dist/claude/settings.json"), "utf8")).rejects.toThrow();
    expect(warned.report.targets["claude"]?.projection?.components?.["agents.default"]).toEqual({
      support: "unsupported",
      discovered: 1,
      emitted: 0,
      skipped: 1,
    });
    expect(warned.report.targets["claude"]?.projection?.omissions).toContainEqual(
      expect.objectContaining({ component: "agents.default", name: "planner" }),
    );
  }, 60_000);

  it("refuses a primary definition for a Codex package, which has no agents route either", async () => {
    const targets = { codex: { version: CODEX_PLUGIN_MODE_RANGE } };

    const built = await buildProject({
      ...(await packageFixture({ "planner.md": PLANNER }, { targets })).options,
      dryRun: true,
    });

    expect(built.ok).toBe(false);
    expect(built.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", target: "codex", component: "agents.primary" }),
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
