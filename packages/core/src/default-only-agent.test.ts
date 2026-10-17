import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { piAdapter } from "../../adapter-pi/src/index.js";
import type { HarnessAdapter } from "./adapter.js";
import { buildProject } from "./build.js";
import { runProject } from "./project.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const definition = (name: string, mode = "primary", native = "") =>
  `---\nname: ${name}\ndescription: A test role.\nmode: ${mode}\n${native}---\nInstructions for ${name}.\n`;

async function fixture(
  options: {
    adapter?: HarnessAdapter;
    definitions?: Record<string, string>;
    components?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-default-only-"));
  dirs.push(root);
  await mkdir(join(root, "agents"));
  for (const [name, text] of Object.entries(options.definitions ?? { planner: definition("planner") }))
    await writeFile(join(root, "agents", `${name}.md`), text);
  const adapter = options.adapter ?? piAdapter();
  const config = {
    project: { root: "." },
    components: { agents: ["./agents"], defaultAgent: "planner", ...options.components },
    targets: {
      role: {
        adapter: adapter.id,
        version: adapter.harness.recommendedRange,
        delivery: "project",
        output: ".hooknostic/artifacts/role",
      },
    },
  };
  const configPath = join(root, "hooknostic.config.ts");
  const configure = () => writeFile(configPath, `export default ${JSON.stringify(config)};`);
  await configure();
  return { root, config, configure, options: { configPath, registry: { [adapter.id]: adapter } } };
}

describe("a project default without named agent support", () => {
  it.each(["pi", "another-harness"])(
    "delivers the fixed default independently on %s",
    async (id) => {
      // Changing the adapter id proves core does not special-case Pi.
      const { root, options } = await fixture({ adapter: { ...piAdapter(), id } });
      await mkdir(join(root, ".pi"));
      await writeFile(join(root, ".pi/SYSTEM.md"), "Authored system prompt.\n");
      const synced = await runProject({ ...options, command: "sync" });
      expect(synced.errors).toEqual([]);
      expect(await readFile(join(root, ".pi/APPEND_SYSTEM.md"), "utf8")).toBe("Instructions for planner.\n");
      expect(await readFile(join(root, ".pi/.gitattributes"), "utf8")).toBe(
        ".gitattributes -text\nAPPEND_SYSTEM.md -text\n",
      );
      expect(await readFile(join(root, ".pi/SYSTEM.md"), "utf8")).toBe("Authored system prompt.\n");
      expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
      const built = await buildProject({ ...options, dryRun: true });
      expect(built.ok).toBe(true);
      expect(built.report.targets["role"]?.project?.components).toEqual({
        "agents.default": { support: "emulated", discovered: 1, emitted: 1, skipped: 0 },
      });
      expect(built.report.targets["role"]?.project?.guidance.join(" ")).toContain("--append-system-prompt");

      await writeFile(
        join(root, "agents/planner.md"),
        definition("planner").replace("Instructions", "Updated instructions"),
      );
      expect((await runProject({ ...options, command: "verify" })).drift).toBe(true);
      expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
      expect(await readFile(join(root, ".pi/APPEND_SYSTEM.md"), "utf8")).toBe("Updated instructions for planner.\n");
    },
    60_000,
  );

  it("reports every other selected definition, and refuses them under the default policy", async () => {
    const { options, config, configure } = await fixture({
      definitions: {
        planner: definition("planner"),
        reviewer: definition("reviewer", "subagent"),
        writer: definition("writer"),
      },
    });
    const failed = await buildProject({ ...options, dryRun: true });
    expect(failed.ok).toBe(false);
    expect(failed.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", component: "agents.definition", severity: "error" }),
    );
    Object.assign(config.components, { onUnsupported: "warn" });
    await configure();
    const built = await buildProject({ ...options, dryRun: true });
    expect(built.ok).toBe(true);
    expect(built.report.targets["role"]?.project?.components).toMatchObject({
      "agents.default": { emitted: 1 },
      "agents.definition": { support: "unsupported", discovered: 2, emitted: 0, skipped: 2 },
    });
    expect(built.report.targets["role"]?.project?.omissions).toEqual([
      expect.objectContaining({ component: "agents.definition", name: "reviewer" }),
      expect.objectContaining({ component: "agents.definition", name: "writer" }),
    ]);
    expect(built.plan?.flatMap((target) => target.integration?.files ?? [])).toContainEqual({
      path: ".pi/APPEND_SYSTEM.md",
      contents: "Instructions for planner.\n",
      mode: 0o644,
    });
  }, 60_000);

  it("still reports the delegation half of an all-mode default", async () => {
    const { root, options } = await fixture({
      definitions: { planner: definition("planner", "all") },
      components: { onUnsupported: "warn" },
    });
    const built = await buildProject({ ...options, dryRun: true });
    expect(built.ok).toBe(true);
    expect(built.report.targets["role"]?.project?.components).toMatchObject({
      "agents.default": { emitted: 1 },
      "agents.definition": { support: "unsupported", discovered: 1, emitted: 0, skipped: 1 },
    });
    expect(built.report.targets["role"]?.project?.omissions).toContainEqual(
      expect.objectContaining({ name: "planner", component: "agents.definition" }),
    );
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(await readFile(join(root, ".pi/APPEND_SYSTEM.md"), "utf8")).toBe("Instructions for planner.\n");
  }, 60_000);

  it("keeps native Pi fields unsupported rather than turning them into project settings", async () => {
    const { root, options, config, configure } = await fixture({
      definitions: {
        planner: definition(
          "planner",
          "primary",
          "native:\n  pi:\n    defaultModel: role-model\n    defaultTools: [read]\n",
        ),
      },
    });
    const failed = await buildProject({ ...options, dryRun: true });
    expect(failed.ok).toBe(false);
    expect(failed.report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN205", component: "agents.native", severity: "error" }),
    );
    Object.assign(config.components, { onUnsupported: "warn" });
    await configure();
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    await expect(readFile(join(root, ".pi/settings.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(root, ".pi/APPEND_SYSTEM.md"), "utf8")).not.toContain("defaultModel");
  }, 60_000);

  it("removes an owned append when the target deselects the default", async () => {
    const { root, options, config, configure } = await fixture();
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(await readFile(join(root, ".pi/APPEND_SYSTEM.md"), "utf8")).toBe("Instructions for planner.\n");
    Object.assign(config.targets.role, { agents: { exclude: ["planner"] } });
    await configure();
    const built = await buildProject({ ...options, dryRun: true });
    expect(built.ok).toBe(true);
    expect(built.report.targets["role"]?.project?.components).toEqual({});
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    await expect(readFile(join(root, ".pi/APPEND_SYSTEM.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(root, ".pi/.gitattributes"), "utf8")).rejects.toThrow();
  }, 60_000);

  it.each(["unowned", "modified"])(
    "refuses an %s append without overwriting it",
    async (state) => {
      const { root, options } = await fixture();
      if (state === "modified") expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
      else await mkdir(join(root, ".pi"));
      await writeFile(join(root, ".pi/APPEND_SYSTEM.md"), "Authored append.\n");
      const synced = await runProject({ ...options, command: "sync" });
      expect(synced.ok).toBe(false);
      expect(synced.errors.join(" ")).toContain("unowned or modified generated file: .pi/APPEND_SYSTEM.md");
      expect(await readFile(join(root, ".pi/APPEND_SYSTEM.md"), "utf8")).toBe("Authored append.\n");
    },
    60_000,
  );
});
