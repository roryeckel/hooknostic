import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA, RELATIVE_SKILL_TEXT } from "@hooknostic/agent-plugin";

import { opencodeV1Adapter } from "../../adapter-opencode/src/index.js";
import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { buildProject } from "./build.js";
import { runProject } from "./project.js";
import { projectSkillFiles } from "./project-components.js";
import { readProjectToml } from "./project-toml.js";
const dirs: string[] = [];
const registry = defaultAdapterRegistry();
registry.opencode = opencodeV1Adapter();
const evaluate = { alias: { "@hooknostic/sdk": fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)) } };
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-local-"));
  dirs.push(root);
  await writeFile(
    join(root, "hooks.ts"),
    `import { definePlugin, hook, block } from "@hooknostic/sdk";
export default definePlugin({ name: "sample-project", hooks: [hook("tool.before", { id: "guard", timeoutMs: 4000, match: { kind: "shell" }, capabilities: { "tool.before.block": "required" }, async run() { return block("project marker"); } })] });`,
  );
  const targets = Object.fromEntries(
    Object.entries(registry).map(([name, adapter]) => [
      name,
      {
        adapter: name,
        version: adapter.harness.recommendedRange,
        delivery: "project",
        output: `.hooknostic/artifacts/${name}`,
      },
    ]),
  );
  const config = { project: { root: "." }, entry: "./hooks.ts", targets, ...extra };
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(configPath, `export default ${JSON.stringify(config)};`);
  return { root, config, options: { configPath, registry, evaluate } };
}
describe("complete project integration", () => {
  it("anchors a dot MCP override to its nested source directory for every target", async () => {
    const { root, options } = await fixture({
      components: {
        mcp: "./services/mcp.json",
        mcpOverrides: Object.fromEntries(Object.keys(registry).map((id) => [id, { servers: { probe: { cwd: "." } } }])),
      },
    });
    await mkdir(join(root, "services"));
    await writeFile(
      join(root, "services/mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { probe: { type: "stdio", command: "node", args: ["-e", "console.log(process.cwd())"] } },
      }),
    );
    // Give the same project a spelling with a different directory depth.
    // A launcher offset computed between lexical and real paths is invalid.
    const alias = join(root, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    options.configPath = join(alias, "hooknostic.config.ts");
    const result = await buildProject(options);
    expect(result.ok, JSON.stringify(result.report.diagnostics)).toBe(true);
    for (const id of Object.keys(registry)) {
      const run = spawnSync(process.execPath, [join(root, `.hooknostic/artifacts/${id}/mcp-launcher.mjs`), "0"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim(), id).toBe(join(root, "services"));
    }
  });

  it("wires all three harnesses, verifies cleanly, and detects stale source", async () => {
    const { root, options } = await fixture();
    const dry = await runProject({ ...options, command: "sync", dryRun: true });
    expect(dry.errors).toEqual([]);
    expect(dry.changes).toContain(".codex/hooks.json");
    await expect(readFile(join(root, ".codex/hooks.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
    expect(await readFile(join(root, ".hooknostic/.gitattributes"), "utf8")).toBe("** -text\n");
    const codex = JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8"));
    expect(codex.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
    await mkdir(join(root, "backend/nested"), { recursive: true });
    const hookRun = spawnSync(codex.hooks.PreToolUse[0].hooks[0].command, {
      cwd: join(root, "backend/nested"),
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: root,
        session_id: "sample",
        tool_name: "Bash",
        tool_input: { command: "echo test" },
      }),
      shell: true,
      timeout: 10_000,
    });
    expect(hookRun.status, hookRun.stderr).toBe(0);
    expect(hookRun.stdout).toContain("project marker");
    expect(await readFile(join(root, ".opencode/plugins/hooknostic.js"), "utf8")).toContain(
      ".hooknostic/artifacts/opencode",
    );
    const source = await readFile(join(root, "hooks.ts"), "utf8");
    await writeFile(join(root, "hooks.ts"), source.replace("4000", "9000"));
    expect((await runProject({ ...options, command: "verify" })).drift).toBe(true);
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].timeout,
    ).toBe(10);
  });
  it("honors a named target at runtime", async () => {
    const adapter = registry.claude!;
    const { root, options } = await fixture({
      targets: {
        primary: {
          adapter: "claude",
          version: adapter.harness.recommendedRange,
          delivery: "project",
          output: "generated hooks/primary",
        },
      },
    });
    const path = join(root, "hooks.ts");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace('id: "guard",', 'id: "guard", targets: { include: ["primary"] },'),
    );
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    const run = spawnSync(process.execPath, [join(root, "generated hooks/primary/runtime/hooknostic.mjs")], {
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: root,
        session_id: "sample",
        tool_name: "Bash",
        tool_input: { command: "echo test" },
      }),
    });
    expect(run.stdout).toContain("project marker");
  });
  it("copies direct skills and resources without requiring package metadata", async () => {
    const { root, options } = await fixture({
      components: {
        skills: ["./skills"],
        exclude: ["**/__pycache__/**", "**/*.pyc", "sample/assets/**", "sample/references/test-credentials.md"],
      },
    });
    await mkdir(join(root, "skills/sample/references"), { recursive: true });
    await mkdir(join(root, "skills/sample/assets"), { recursive: true });
    await mkdir(join(root, "skills/sample/__pycache__"), { recursive: true });
    await writeFile(
      join(root, "skills/sample/SKILL.md"),
      "---\nname: sample\ndescription: Synthetic skill\n---\nRead references/note.md.\n",
    );
    await writeFile(join(root, "skills/sample/references/note.md"), "resource\n");
    await writeFile(join(root, "skills/sample/references/test-credentials.md"), "ignored\n");
    await writeFile(join(root, "skills/sample/assets/session.json"), "ignored\n");
    await writeFile(join(root, "skills/sample/__pycache__/probe.pyc"), "ignored\n");
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect(await readFile(join(root, ".claude/skills/sample/references/note.md"), "utf8")).toBe("resource\n");
    await expect(readFile(join(root, ".claude/skills/sample/references/test-credentials.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, ".claude/skills/sample/assets/session.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, ".claude/skills/sample/__pycache__/probe.pyc"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, ".claude/skills/.gitattributes"), "utf8")).toBe("** -text\n");
    expect(await readFile(join(root, ".agents/skills/sample/SKILL.md"), "utf8")).toContain("Synthetic skill");
  });

  it("warns per target when a declared mode lands in a skill discovered in place", async () => {
    // `.claude/skills` is Claude's own destination, so Claude discovers this
    // skill where it already is and owns nothing to chmod. Codex and OpenCode
    // copy it to `.agents/skills`, where the declaration is live -- which is
    // why this warns rather than failing, and why it is not an omission: the
    // skill is delivered on every target.
    const { root, options } = await fixture({
      components: { skills: ["./.claude/skills"], executableFiles: ["review/bin/tool"] },
    });
    await mkdir(join(root, ".claude/skills/review/bin"), { recursive: true });
    await writeFile(
      join(root, ".claude/skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review a change\n---\n",
    );
    await writeFile(join(root, ".claude/skills/review/bin/tool"), "#!/bin/sh\n");

    const built = await buildProject(options);
    const warnings = built.report.diagnostics.filter((diagnostic) => diagnostic.code === "HN104");

    expect(warnings).toEqual([
      expect.objectContaining({
        severity: "warn",
        target: "claude",
        component: "agent-plugin.skills",
        message: expect.stringContaining('components.executableFiles "review/bin/tool" names a file this target'),
      }),
    ]);
    // The skill is present, not skipped: an omission would have decremented it.
    expect(built.report.targets["claude"]?.project?.omissions).toEqual([]);
    expect(built.report.targets["claude"]?.project?.components["agent-plugin.skills"]).toMatchObject({ emitted: 1 });
    // And the declaration is honoured where the target does own the tree.
    // One warning, not three: the other two targets copy the skill to
    // `.agents/skills`, where they own the tree and the declaration is live.
    for (const target of ["codex", "opencode"]) {
      expect(built.report.targets[target]?.project?.components["agent-plugin.skills"], target).toMatchObject({
        emitted: 1,
      });
    }
  }, 60_000);

  it("writes each target's skill directory into a skill's body", async () => {
    const { root, options } = await fixture({ components: { skills: ["./skills"] } });
    await mkdir(join(root, "skills/sample/scripts"), { recursive: true });
    const frontmatter = "---\nname: sample\ndescription: Runs its launcher\n---\n";
    const body = (dir: string) => `Run \`node "${dir}/scripts/status.mjs"\`, then ${dir}/scripts/again.\r\n`;
    await writeFile(join(root, "skills/sample/SKILL.md"), frontmatter + body("${SKILL_DIR}"));
    await writeFile(join(root, "skills/sample/scripts/status.mjs"), "");

    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect(await readFile(join(root, ".claude/skills/sample/SKILL.md"), "utf8")).toBe(
      frontmatter + body("${CLAUDE_SKILL_DIR}"),
    );
    expect(await readFile(join(root, ".agents/skills/sample/SKILL.md"), "utf8")).toBe(frontmatter + body("."));
  }, 60_000);

  it("fails a target whose skill text keeps a reference that target shows as written", async () => {
    const { root, options } = await fixture({
      components: { skills: ["./skills"], accept: ["codex:skill-reference-unexpanded"] },
    });
    await mkdir(join(root, "skills/sample"), { recursive: true });
    await writeFile(
      join(root, "skills/sample/SKILL.md"),
      '---\nname: sample\ndescription: Claude-only text\n---\nRun node "${CLAUDE_PLUGIN_ROOT}/x.mjs" in ${HOME}.\n',
    );

    const built = await buildProject(options);
    const reported = built.report.diagnostics.filter((diagnostic) => diagnostic.code === "HN101");
    // Claude leaves ${CLAUDE_PLUGIN_ROOT} as written outside a plugin, and so
    // does every other target; ${HOME} is the shell's to expand, not reported.
    expect(reported.map((diagnostic) => [diagnostic.target, diagnostic.severity]).sort()).toEqual([
      ["claude", "error"],
      ["codex", "info"],
      ["opencode", "error"],
    ]);
    expect(reported[0]).toMatchObject({
      component: "agent-plugin.skills",
      degradation: expect.stringMatching(/:skill-reference-unexpanded$/),
      message: expect.stringContaining('"${CLAUDE_PLUGIN_ROOT}"'),
    });
    expect(reported.map((diagnostic) => diagnostic.message).join("\n")).not.toContain("HOME");
    expect(built.report.targets["codex"]?.project?.degradations).toEqual([
      expect.objectContaining({ id: "codex:skill-reference-unexpanded", name: "sample" }),
    ]);
    expect(built.report.targets["claude"]?.status).toBe("failed");
    expect(built.ok).toBe(false);
  }, 60_000);

  it("fails every target on a frontmatter reference, which no harness expands", async () => {
    const { root, options } = await fixture({ components: { skills: ["./skills"] } });
    await mkdir(join(root, "skills/sample"), { recursive: true });
    await writeFile(
      join(root, "skills/sample/SKILL.md"),
      "---\nname: sample\ndescription: Run ${PLUGIN_ROOT}/x\n---\nNothing to expand here.\n",
    );

    const built = await buildProject(options);
    const reported = built.report.diagnostics.filter((diagnostic) => diagnostic.code === "HN101");
    expect(reported.map((diagnostic) => diagnostic.target).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(reported[0]?.message).toContain("No harness expands a reference in the frontmatter");
  }, 60_000);

  it("reports a skill directory it cannot rewrite in a skill discovered in place", async () => {
    const { root, options } = await fixture({ components: { skills: ["./.claude/skills"] } });
    await mkdir(join(root, ".claude/skills/review"), { recursive: true });
    const text = '---\nname: review\ndescription: Review a change\n---\nRun node "${SKILL_DIR}/review.mjs".\n';
    await writeFile(join(root, ".claude/skills/review/SKILL.md"), text);

    const built = await buildProject(options);
    const reported = built.report.diagnostics.filter((diagnostic) => diagnostic.code === "HN101");
    expect(reported).toEqual([
      expect.objectContaining({
        severity: "error",
        target: "claude",
        message: expect.stringContaining("discovers this skill where it is"),
      }),
    ]);
    // The author's own file is left alone.
    expect(await readFile(join(root, ".claude/skills/review/SKILL.md"), "utf8")).toBe(text);
  }, 60_000);

  it("carries a skill file's declared mode into the projection", () => {
    // The middle link of the chain the loader and the writer already pin: the
    // loader assigns 0755 from `components.executableFiles`, `applyProject`
    // chmods it (project-recovery.test.ts), and this is the step between,
    // which is a `map` that could drop the field without failing either end.
    // Asserted on the returned files rather than on disk because Windows
    // reports no POSIX bit -- the projection is the portable artifact, and
    // ADR-0013 is a claim about it, not about the host.
    const projected = projectSkillFiles(
      {
        origin: "direct",
        skills: [
          {
            name: "sample",
            source: join(tmpdir(), "hooknostic-absent-source", "sample"),
            files: [
              { path: "SKILL.md", contents: new Uint8Array(), mode: 0o644 },
              { path: "scripts/helper.sh", contents: new Uint8Array(), mode: 0o755 },
            ],
          },
        ],
      },
      join(tmpdir(), "hooknostic-absent-root"),
      ".claude/skills",
      { target: RELATIVE_SKILL_TEXT, harness: "the target" },
    );

    expect(projected.files.map((file) => [file.path, file.mode])).toEqual([
      [".claude/skills/sample/SKILL.md", 0o644],
      [".claude/skills/sample/scripts/helper.sh", 0o755],
      [".claude/skills/.gitattributes", 0o644],
    ]);
  });

  it("carries declared MCP command resolution through build and project reports", async () => {
    const codex = registry.codex!;
    const { root, options } = await fixture({
      components: { mcp: "./mcp.json", targets: ["codex"] },
      targets: {
        codex: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/codex",
        },
      },
    });
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          local: { type: "stdio", command: "hooknostic-missing-runtime" },
          shipped: { type: "stdio", command: "./bin/server" },
          remote: { type: "streamable-http", url: "https://example.test/mcp" },
        },
      }),
    );

    const built = await buildProject({ ...options, dryRun: true });
    const expected = [
      {
        server: "local",
        command: "hooknostic-missing-runtime",
        resolution: "ambient",
      },
      { server: "shipped", command: "./bin/server", resolution: "project" },
    ];
    expect((built.report as typeof built.report & { mcpServers?: unknown }).mcpServers).toEqual(expected);

    const projected = await runProject({ ...options, command: "sync", dryRun: true });
    expect((projected as typeof projected & { mcpServers?: unknown }).mcpServers).toEqual(expected);
  });
  it("relinquishes copied skills when their native destination becomes the source", async () => {
    const codex = registry.codex!;
    const { root, config, options } = await fixture({
      components: { skills: ["./skills"] },
      targets: {
        codex: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/codex",
        },
      },
    });
    await mkdir(join(root, "skills/sample"), { recursive: true });
    await writeFile(
      join(root, "skills/sample/SKILL.md"),
      "---\nname: sample\ndescription: Synthetic skill\n---\nOriginal\n",
    );
    await writeFile(join(root, "skills/sample/local.txt"), "native resource\n");
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    const native = join(root, ".agents/skills/sample/SKILL.md");
    const resource = join(root, ".agents/skills/sample/local.txt");
    const attributes = join(root, ".agents/skills/.gitattributes");
    await writeFile(native, "---\nname: sample\ndescription: Native source\n---\nAuthored\n");
    await writeFile(attributes, "# Native policy\n** -text\n");
    await writeFile(
      options.configPath,
      `export default ${JSON.stringify({
        ...config,
        components: { skills: ["./.agents/skills"], exclude: ["sample/local.txt"] },
      })};`,
    );

    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(await readFile(native, "utf8")).toContain("Authored");
    expect(await readFile(resource, "utf8")).toBe("native resource\n");
    expect(await readFile(attributes, "utf8")).toBe("# Native policy\n** -text\n");
    const manifest = await readFile(join(root, ".hooknostic/integration.json"), "utf8");
    expect(manifest).not.toContain(".agents/skills/sample/SKILL.md");
    expect(manifest).not.toContain(".agents/skills/sample/local.txt");
    expect(manifest).not.toContain(".agents/skills/.gitattributes");
    await writeFile(native, "---\nname: sample\ndescription: Native source\n---\nEdited\n");
    await writeFile(attributes, "# Edited native policy\n** -text\n");
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
  });
  it("ignores unselected package targets when loading direct components", async () => {
    const claude = registry.claude!;
    const codex = registry.codex!;
    const { root, options } = await fixture({
      components: { skills: ["./skills"], targets: ["local"] },
      targets: {
        local: {
          adapter: "claude",
          version: claude.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/local",
        },
        unrelated: {
          adapter: "codex",
          version: codex.agentPluginProjector!.profiles.at(-1)!.range,
          delivery: "package",
          output: "dist/unrelated",
        },
      },
    });
    await mkdir(join(root, "skills/sample"), { recursive: true });
    await writeFile(join(root, "skills/sample/SKILL.md"), "---\nname: sample\ndescription: Synthetic skill\n---\n");

    const result = await runProject({ ...options, command: "sync" });
    expect(result.errors).toEqual([]);
    expect(await readFile(join(root, ".claude/skills/sample/SKILL.md"), "utf8")).toContain("Synthetic skill");
  });
  it("does not validate, report, or materialize components owned only by a package target", async () => {
    const claude = registry.claude!;
    const opencode = registry.opencode!;
    const { root, options } = await fixture();
    const callKey = `HOOKNOSTIC_PROJECT_MATERIALIZER_${root.replace(/[^A-Za-z0-9]/g, "_")}`;
    delete process.env[callKey];
    await writeFile(join(root, "plugin.json"), "{ deliberately invalid package-only JSON");
    await writeFile(join(root, "packages.lock"), "locked\n");
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { packageOnly: { type: "stdio", command: "package-runner" } },
      }),
    );
    await writeFile(
      options.configPath,
      `export default {
        project: { root: "." },
        entry: "./hooks.ts",
        components: {
          root: ".",
          targets: ["bundle"],
          materialize: [{
            provider: {
              id: "must-not-run",
              validate() {
                process.env[${JSON.stringify(callKey)}] = "validate";
                return [];
              },
              plan() {
                process.env[${JSON.stringify(callKey)}] = "plan";
                throw new Error("package materializer ran during a project command");
              },
            },
            inputs: { lock: "packages.lock" },
            into: "generated",
          }],
        },
        targets: {
          local: {
            adapter: "claude",
            version: ${JSON.stringify(claude.harness.recommendedRange)},
            delivery: "project",
            output: ".hooknostic/artifacts/local",
          },
          bundle: {
            adapter: "opencode",
            version: ${JSON.stringify(opencode.harness.recommendedRange)},
            delivery: "package",
            output: "dist/bundle",
          },
        },
      };`,
    );

    try {
      const dry = await runProject({ ...options, command: "sync", dryRun: true });
      expect(dry.errors).toEqual([]);
      expect(dry.mcpServers).toEqual([]);
      expect(process.env[callKey]).toBeUndefined();

      const synced = await runProject({ ...options, command: "sync" });
      expect(synced.errors).toEqual([]);
      expect(process.env[callKey]).toBeUndefined();

      const verified = await runProject({ ...options, command: "verify" });
      expect(verified.ok).toBe(true);
      expect(verified.mcpServers).toEqual([]);
      expect(process.env[callKey]).toBeUndefined();
    } finally {
      delete process.env[callKey];
    }
  });
  it("keeps synchronized project wiring out of package component sources", async () => {
    const claude = registry.claude!;
    const codex = registry.codex!;
    const { root, options } = await fixture({
      components: { root: ".", targets: ["bundle"] },
      targets: {
        bundle: {
          adapter: "claude",
          version: claude.harness.recommendedRange,
          delivery: "package",
          output: "dist/bundle",
        },
        local: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/local",
        },
      },
    });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "mixed-delivery" }),
    );
    await writeFile(join(root, "portable.txt"), "portable package content\n");

    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(await readFile(join(root, ".codex/hooks.json"), "utf8")).toContain("PreToolUse");

    const built = await buildProject(options);
    expect(built.ok).toBe(true);
    expect(built.report.components?.sourceFiles).toContain("portable.txt");
    expect(built.report.components?.sourceFiles).not.toContain(".codex/hooks.json");
    expect(await readFile(join(root, "dist/bundle/portable.txt"), "utf8")).toBe("portable package content\n");
    await expect(readFile(join(root, "dist/bundle/.codex/hooks.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects duplicate project adapters and partial synchronization", async () => {
    const adapter = registry.claude!;
    const target = {
      adapter: "claude",
      version: adapter.harness.recommendedRange,
      delivery: "project",
      output: "dist/a",
    };
    const { options } = await fixture({ targets: { a: target, b: { ...target, output: "dist/b" } } });
    expect((await runProject({ ...options, command: "sync" })).errors.join()).toContain("duplicate project");
    expect((await runProject({ ...options, command: "sync", targets: ["a"] })).errors.join()).toContain("partial");
  });
  it("projects MCP declarations without expanding environment values", async () => {
    const { root, options } = await fixture({ components: { mcp: "./mcp.json" } });
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          sample: {
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: { TOKEN: "${UNRESOLVED_TOKEN}" },
          },
        },
      }),
    );
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect(await readFile(join(root, ".hooknostic/artifacts/claude/mcp-servers.json"), "utf8")).toContain(
      "${UNRESOLVED_TOKEN}",
    );
    expect(await readFile(join(root, ".hooknostic/integration.json"), "utf8")).not.toContain("TOKEN");
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
  });
  // Claude's project stdio cell is `emulated`, so an `exact` floor puts it below.
  it.each(["warn", "error"] as const)(
    "reports a project component below compatibility as HN206 and still emits it (onBelowMinimum %s)",
    async (onBelowMinimum) => {
      const claude = registry.claude!;
      const { root, options } = await fixture({
        components: { mcp: "./mcp.json" },
        targets: {
          claude: {
            adapter: "claude",
            version: claude.harness.recommendedRange,
            delivery: "project",
            output: ".hooknostic/artifacts/claude",
            compatibility: { minimum: "exact", onBelowMinimum },
          },
        },
      });
      await writeFile(
        join(root, "mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: { sample: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] } },
        }),
      );

      const built = await buildProject({ ...options, dryRun: true });
      const stdio = built.report.diagnostics.filter((item) => item.component === "agent-plugin.mcp.stdio");
      expect(stdio).toEqual([
        expect.objectContaining({ code: "HN206", severity: onBelowMinimum, target: "claude", support: "emulated" }),
      ]);
      expect(built.ok).toBe(onBelowMinimum === "warn");
      if (onBelowMinimum === "error") return;
      const project = built.report.targets.claude?.project;
      expect(project?.components["agent-plugin.mcp.stdio"]).toEqual({
        support: "emulated",
        discovered: 1,
        emitted: 1,
        skipped: 0,
      });
      expect(project?.omissions).toEqual([]);
    },
  );
  it("synchronizes prototype-key MCP server names for Claude and Codex", async () => {
    const claude = registry.claude!;
    const codex = registry.codex!;
    const { root, options } = await fixture({
      components: { mcp: "./mcp.json" },
      targets: {
        claude: {
          adapter: "claude",
          version: claude.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/claude",
        },
        codex: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/codex",
        },
      },
    });
    await writeFile(
      join(root, "mcp.json"),
      `{"$schema":"${AGENT_PLUGIN_MCP_SCHEMA}","mcpServers":{"__proto__":{"type":"streamable-http","url":"https://proto.invalid/mcp"},"constructor":{"type":"streamable-http","url":"https://constructor.invalid/mcp"},"prototype":{"type":"streamable-http","url":"https://prototype.invalid/mcp"}}}`,
    );

    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    const claudeServers = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers as Record<
      string,
      unknown
    >;
    const codexServers = readProjectToml(await readFile(join(root, ".codex/config.toml"), "utf8"))
      .mcp_servers as Record<string, unknown>;
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(claudeServers, name)).toBe(true);
      expect(Object.hasOwn(codexServers, name)).toBe(true);
    }
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
  });
  it.each([undefined, "error"] as const)(
    "emits Claude package remotes Claude would expand and reports the deviation (onDeviation %s)",
    async (onDeviation) => {
      const claude = registry.claude!;
      const { root, options } = await fixture({
        components: {
          root: "./portable",
          targets: ["claude"],
          ...(onDeviation === undefined ? {} : { onDeviation }),
        },
        targets: {
          claude: {
            adapter: "claude",
            version: claude.harness.recommendedRange,
            delivery: "project",
            output: ".hooknostic/artifacts/claude",
          },
        },
      });
      await mkdir(join(root, "portable"));
      await writeFile(
        join(root, "portable/plugin.json"),
        JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "portable" }),
      );
      await writeFile(
        join(root, "portable/mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            referenced: {
              type: "streamable-http",
              url: "https://example.invalid/${RUNTIME_TOKEN}/mcp",
              headers: { Authorization: "Bearer ${RUNTIME_TOKEN}" },
            },
            literal: { type: "streamable-http", url: "https://example.invalid/mcp" },
          },
        }),
      );

      const built = await buildProject({ ...options, dryRun: true });
      const project = built.report.targets.claude?.project;
      expect(project?.components["agent-plugin.mcp.streamable-http"]).toEqual({
        support: "exact",
        discovered: 2,
        emitted: 2,
        skipped: 0,
      });
      expect(project?.omissions).toEqual([]);
      expect(project?.deviations).toEqual([
        expect.objectContaining({ id: "claude:mcp-environment-expansion", name: "referenced" }),
      ]);
      const synced = await runProject({ ...options, command: "sync" });
      const hn106 = expect.objectContaining({
        code: "HN106",
        severity: onDeviation ?? "warn",
        component: "agent-plugin.mcp.streamable-http",
        deviation: "claude:mcp-environment-expansion",
      });
      if (onDeviation === "error") {
        expect(synced.ok).toBe(false);
        expect(synced.diagnostics).toContainEqual(hn106);
        return;
      }
      expect(synced.errors).toEqual([]);
      expect(synced.diagnostics).toContainEqual(hn106);
      const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
      expect(Object.keys(mcp.mcpServers).sort()).toEqual(["literal", "referenced"]);
    },
  );
  it("forwards packaged MCP environment declarations through Codex project delivery", async () => {
    const codex = registry.codex!;
    const { root, config, options } = await fixture({
      components: {
        root: "./portable",
        targets: ["codex"],
        mcpEnvironment: Object.fromEntries([
          ["credentialed", ["SERVICE_USER", "SERVICE_API_KEY", "SERVICE_USER"]],
          ["__proto__", ["PROTOTYPE_TOKEN"]],
        ]),
      },
      targets: {
        codex: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/codex",
        },
      },
    });
    // The ordinary object-literal spelling of `__proto__` changes the object's
    // prototype. Parse the serialized config so it remains an own data property,
    // matching a computed property in an authored TypeScript config.
    await writeFile(options.configPath, `export default JSON.parse(${JSON.stringify(JSON.stringify(config))});`);
    await mkdir(join(root, "portable"));
    await writeFile(
      join(root, "portable/plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "portable" }),
    );
    await writeFile(
      join(root, "portable/mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: Object.fromEntries([
          ["credentialed", { type: "stdio", command: "node" }],
          ["plain", { type: "stdio", command: "node" }],
          ["__proto__", { type: "stdio", command: "node" }],
        ]),
      }),
    );

    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    const servers = readProjectToml(await readFile(join(root, ".codex/config.toml"), "utf8")).mcp_servers as Record<
      string,
      { env_vars?: string[] }
    >;
    expect(servers.credentialed?.env_vars).toEqual(["SERVICE_API_KEY", "SERVICE_USER"]);
    expect(servers.plain).not.toHaveProperty("env_vars");
    expect(Object.hasOwn(servers, "__proto__")).toBe(true);
    expect(servers["__proto__"]?.env_vars).toEqual(["PROTOTYPE_TOKEN"]);
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
  });
  it("applies independent target MCP arguments, cwd, and timeout translations", async () => {
    const { root, options } = await fixture({
      components: {
        mcp: "./config/mcp.json",
        targets: ["codex", "opencode"],
        mcpOverrides: {
          codex: {
            startupTimeoutMs: 60_000,
            servers: { serena: { args: ["start-mcp-server", "--context", "codex", "--project", "${SERENA_PROJECT}"] } },
          },
          opencode: {
            servers: {
              serena: {
                args: ["start-mcp-server", "--context", "ide"],
                cwd: "${PLUGIN_ROOT}/..",
                startupTimeoutMs: 60_000,
              },
            },
          },
        },
      },
    });
    await mkdir(join(root, "config"));
    await writeFile(
      join(root, "config/mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          serena: {
            type: "stdio",
            command: "uvx",
            args: ["start-mcp-server", "--context", "claude-code"],
            cwd: "${PLUGIN_ROOT}",
          },
        },
      }),
    );
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect(
      JSON.parse(await readFile(join(root, ".hooknostic/artifacts/codex/mcp-servers.json"), "utf8")).servers[0],
    ).toMatchObject({ args: ["start-mcp-server", "--context", "codex", "--project", "${SERENA_PROJECT}"] });
    expect(
      JSON.parse(await readFile(join(root, ".hooknostic/artifacts/opencode/mcp-servers.json"), "utf8")).servers[0],
    ).toMatchObject({ args: ["start-mcp-server", "--context", "ide"], cwd: "${PLUGIN_ROOT}/.." });
    const codexServers = readProjectToml(await readFile(join(root, ".codex/config.toml"), "utf8"))
      .mcp_servers as Record<string, { startup_timeout_sec: number; env_vars?: string[] }>;
    expect(codexServers.serena!.startup_timeout_sec).toBe(60);
    expect(codexServers.serena!.env_vars).toEqual(["SERENA_PROJECT"]);
    const componentPath = join(root, ".opencode/plugins/hooknostic-components.js");
    const plugin = await (await import(pathToFileURL(componentPath).href)).default();
    const opencodeConfig: { mcp?: Record<string, { timeout?: number }> } = {};
    plugin.config(opencodeConfig);
    expect(opencodeConfig.mcp?.serena?.timeout).toBe(60_000);
    expect(await readFile(join(root, "config/mcp.json"), "utf8")).toContain("claude-code");
  });
  it.each([
    ["unknown server", { codex: { servers: { missing: { args: [] } } } }, "unknown server"],
    ["remote argv", { codex: { servers: { remote: { args: [] } } } }, "only on a stdio server"],
    [
      "cwd outside project",
      { codex: { servers: { local: { cwd: "${PLUGIN_ROOT}/.." } } } },
      "unsupported portable command or working-directory semantics",
    ],
    ["unsupported timeout", { claude: { startupTimeoutMs: 1000 } }, "cannot represent project MCP startup timeouts"],
  ])("rejects invalid target MCP overrides: %s", async (_name, mcpOverrides, message) => {
    const { root, options } = await fixture({ components: { mcp: "./mcp.json", mcpOverrides } });
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          local: { type: "stdio", command: "node" },
          remote: { type: "streamable-http", url: "https://example.invalid/mcp" },
        },
      }),
    );
    expect((await runProject({ ...options, command: "sync" })).errors.join()).toContain(message);
  });
  it("rejects a direct MCP cwd override whose symlink escapes the project", async () => {
    const codex = registry.codex!;
    const { root, options } = await fixture({
      components: { mcp: "./config/mcp.json", mcpOverrides: { codex: { servers: { sample: { cwd: "./linked" } } } } },
      targets: {
        codex: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/codex",
        },
      },
    });
    const outside = await mkdtemp(join(tmpdir(), "hooknostic-cwd-outside-"));
    dirs.push(outside);
    await mkdir(join(root, "config"));
    await symlink(outside, join(root, "config/linked"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(
      join(root, "config/mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { sample: { type: "stdio", command: "node" } },
      }),
    );

    const result = await runProject({ ...options, command: "sync" });
    expect(result.errors.join()).toContain("unsupported portable command or working-directory semantics");
    await expect(readFile(join(root, ".codex/config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("accepts a direct MCP cwd override whose symlink stays inside the project", async () => {
    const codex = registry.codex!;
    const { root, options } = await fixture({
      components: { mcp: "./config/mcp.json", mcpOverrides: { codex: { servers: { sample: { cwd: "./linked" } } } } },
      targets: {
        codex: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/codex",
        },
      },
    });
    await mkdir(join(root, "config"));
    await mkdir(join(root, "worker"));
    await symlink(join(root, "worker"), join(root, "config/linked"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(
      join(root, "config/mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { sample: { type: "stdio", command: "node" } },
      }),
    );

    const result = await runProject({ ...options, command: "sync" });
    expect(result.errors).toEqual([]);
    expect(await readFile(join(root, ".codex/config.toml"), "utf8")).toContain("sample");
  });
  it("launches Codex project MCP from nested directories and detects registration drift", async () => {
    const { root, config, options } = await fixture({ components: { mcp: "./sources/mcp.json", targets: ["codex"] } });
    await mkdir(join(root, "sources/worker"), { recursive: true });
    await mkdir(join(root, "nested/deeper"), { recursive: true });
    const program =
      "console.log(JSON.stringify({cwd:process.cwd(),root:process.env.PLUGIN_ROOT,data:process.env.PLUGIN_DATA,ref:process.env.REF,args:process.argv.slice(1)}))";
    await writeFile(
      join(root, "sources/mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "http://127.0.0.1:1/mcp",
            headers: { Authorization: "${UNCHANGED}" },
          },
          probe: {
            type: "stdio",
            command: "node",
            args: ["-e", program, "${PLUGIN_ROOT}/support.txt"],
            env: { REF: "${UNCHANGED}" },
            cwd: "./worker",
          },
        },
      }),
    );
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    const path = join(root, ".codex/config.toml");
    const before = await readFile(path, "utf8");
    const servers = readProjectToml(before).mcp_servers as Record<
      string,
      { args: string[]; env_http_headers: Record<string, string> }
    >;
    expect(servers.remote!.env_http_headers.Authorization).toBe("UNCHANGED");
    const execution = spawnSync(process.execPath, servers.probe!.args, {
      cwd: join(root, "nested/deeper"),
      env: { ...process.env, UNCHANGED: "runtime-reference" },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(execution.status, execution.stderr).toBe(0);
    expect(JSON.parse(execution.stdout)).toEqual({
      cwd: join(root, "sources/worker"),
      root: join(root, "sources"),
      data: join(root, ".hooknostic/data"),
      ref: "runtime-reference",
      args: [join(root, "sources") + "/support.txt"],
    });
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
    };
    git(["init"]);
    git(["config", "core.autocrlf", "true"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Synthetic project MCP fixture",
    ]);
    const linked = join(root, "linked-worktree");
    git(["worktree", "add", "--detach", linked, "HEAD"]);
    await mkdir(join(linked, "nested/deeper"), { recursive: true });
    await mkdir(join(linked, "sources/worker"), { recursive: true });
    const linkedRun = spawnSync(process.execPath, servers.probe!.args, {
      cwd: join(linked, "nested/deeper"),
      env: { ...process.env, UNCHANGED: "runtime-reference" },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(linkedRun.status, linkedRun.stderr).toBe(0);
    expect(JSON.parse(linkedRun.stdout).root).toBe(join(linked, "sources"));
    git(["worktree", "remove", "--force", linked]);
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
    await writeFile(path, before.replace("127.0.0.1:1", "127.0.0.1:2"));
    expect((await runProject({ ...options, command: "verify" })).errors.join()).toContain("modified");
    await writeFile(path, before);
    delete config.targets.codex;
    await writeFile(options.configPath, `export default ${JSON.stringify({ ...config, components: undefined })};`);
    expect((await runProject({ ...options, command: "sync" })).errors).toEqual([]);
    expect(readProjectToml(await readFile(path, "utf8")).mcp_servers).toBeUndefined();
  });
  it("warns HN107 only for Codex hooks synchronized into a linked worktree, naming the root checkout", async () => {
    const { root, options } = await fixture();
    const git = (cwd: string, args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
    };
    git(root, ["init", "--quiet"]);
    git(root, ["add", "hooks.ts", "hooknostic.config.ts"]);
    git(root, [
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Synthetic linked worktree fixture",
    ]);
    const rootHooks = await runProject({ ...options, command: "sync" });
    expect(rootHooks.errors).toEqual([]);
    expect(rootHooks.diagnostics.filter((d) => d.code === "HN107")).toEqual([]);

    // The live layout: a worktree nested inside the root checkout.
    const linked = join(root, ".claude", "worktrees", "linked");
    git(root, ["worktree", "add", "--detach", "--quiet", linked, "HEAD"]);
    const linkedOptions = { ...options, configPath: join(linked, "hooknostic.config.ts") };
    const rootCheckout = await realpath(root);
    for (const command of ["sync", "verify"] as const) {
      const result = await runProject({ ...linkedOptions, command });
      expect(result.errors, command).toEqual([]);
      expect(result.ok, command).toBe(true);
      const warnings = result.diagnostics.filter((d) => d.code === "HN107");
      expect(warnings, command).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ severity: "warn", target: "codex" });
      expect(warnings[0]!.message).toContain(`root checkout ${rootCheckout}`);
      expect(warnings[0]!.message).toContain(`runs the root checkout's ${join(rootCheckout, ".codex", "hooks.json")}`);
    }
    // Still written: the artifact is useful once it reaches the root checkout.
    expect(await readFile(join(linked, ".codex/hooks.json"), "utf8")).toContain("PreToolUse");
    git(root, ["worktree", "remove", "--force", linked]);
  });
  it("removes a configured project target without disturbing the others", async () => {
    const { root, config, options } = await fixture();
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    delete config.targets.opencode;
    await writeFile(options.configPath, `export default ${JSON.stringify(config)};`);
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    await expect(readFile(join(root, ".opencode/plugins/hooknostic.js"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
    expect(await readFile(join(root, ".codex/hooks.json"), "utf8")).toContain("PreToolUse");
  });
  it("removes the final project target from an empty desired target set", async () => {
    const codex = registry.codex!;
    const { root, config, options } = await fixture({
      targets: {
        codex: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/codex",
        },
      },
    });
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(await readFile(join(root, ".codex/hooks.json"), "utf8")).toContain("PreToolUse");

    await writeFile(options.configPath, `export default ${JSON.stringify({ ...config, targets: {} })};`);
    const removed = await runProject({ ...options, command: "sync" });

    expect(removed.errors).toEqual([]);
    expect(removed.ok).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8")).hooks.PreToolUse).toEqual([]);
    await expect(
      readFile(join(root, ".hooknostic/artifacts/codex/.codex/hooknostic/hooknostic.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".hooknostic/.gitignore"), "utf8")).toContain("/data/");
    expect(await readFile(join(root, ".hooknostic/integration.json"), "utf8")).not.toContain(".codex/hooks.json");
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
  });
  it("rejects mutated native timeout values and runtimes during verification", async () => {
    const { root, options } = await fixture();
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    const path = join(root, ".codex/hooks.json");
    const before = await readFile(path, "utf8");
    await writeFile(path, before.replace('"timeout": 5', '"timeout": 1'));
    expect((await runProject({ ...options, command: "verify" })).errors.join()).toContain("modified");
    await writeFile(path, before);
    await writeFile(join(root, ".hooknostic/artifacts/codex/.codex/hooknostic/hooknostic.mjs"), "tampered");
    expect((await runProject({ ...options, command: "verify" })).errors.join()).toContain("modified");
  });
  it("reports every explicitly degraded project MCP omission", async () => {
    const { root, config, options } = await fixture({ components: { mcp: "./mcp.json" } });
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { sample: { type: "sse", url: "http://127.0.0.1:1/sse" } },
      }),
    );
    expect((await runProject({ ...options, command: "sync" })).errors.join()).toContain("SSE");
    await writeFile(
      options.configPath,
      `export default ${JSON.stringify({ ...config, components: { mcp: "./mcp.json", onUnsupported: "warn" } })};`,
    );
    const result = await runProject({ ...options, command: "sync" });
    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ target: "codex", component: "agent-plugin.mcp.sse", severity: "warn" }),
    );
    expect(await readFile(join(root, ".opencode/plugins/hooknostic-components.js"), "utf8")).toContain(
      "127.0.0.1:1/sse",
    );
  });
  it("keeps later project target verdicts independent after an earlier target fails", async () => {
    const codex = registry.codex!;
    const opencode = registry.opencode!;
    const { root, options } = await fixture({
      components: { mcp: "./mcp.json" },
      targets: {
        codex: {
          adapter: "codex",
          version: codex.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/codex",
        },
        opencode: {
          adapter: "opencode",
          version: opencode.harness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/opencode",
        },
      },
    });
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { sample: { type: "sse", url: "http://127.0.0.1:1/sse" } },
      }),
    );

    const result = await buildProject({ ...options, dryRun: true });

    expect(result.ok).toBe(false);
    expect(result.report.targets.codex?.status).toBe("failed");
    expect(result.report.targets.opencode?.status).toBe("success");
    expect(result.report.targets.opencode?.project?.components["agent-plugin.mcp.sse"]).toEqual({
      support: "exact",
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
    await expect(
      readFile(join(root, ".hooknostic/artifacts/opencode/.opencode/plugins/hooknostic-components.js")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("resolves a nested configuration relative to its declared project root", async () => {
    const { root, config, options } = await fixture();
    await mkdir(join(root, "configuration"));
    const configPath = join(root, "configuration/config.ts");
    await writeFile(
      configPath,
      `export default ${JSON.stringify({ ...config, project: { root: ".." }, entry: "../hooks.ts", targets: Object.fromEntries(Object.entries(config.targets).map(([id, target]) => [id, { ...target, output: "../" + target.output }])) })};`,
    );
    const result = await runProject({ ...options, configPath, command: "sync" });
    expect(result.errors).toEqual([]);
    expect(await readFile(join(root, ".hooknostic/integration.json"), "utf8")).toContain("configuration/config.ts");
  });
  it("build generates artifacts without changing project discovery files", async () => {
    const { root, options } = await fixture();
    expect((await buildProject(options)).ok).toBe(true);
    await expect(readFile(join(root, ".codex/hooks.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
