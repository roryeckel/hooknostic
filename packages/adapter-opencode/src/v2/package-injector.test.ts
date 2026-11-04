import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginPackage,
  loadAgentPlugin,
} from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";

import { opencodeV2Harness } from "./harness.js";
import { opencodeV2Projector } from "./project.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const target = {
  id: "opencode",
  version: opencodeV2Harness.recommendedRange,
  delivery: "package" as const,
  output: ".",
  npmName: "@hooknostic-probe/v2",
};

/** A package whose projection carries two MCP servers and one skill. */
async function packageFixture(): Promise<AgentPluginPackage> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-v2-injector-"));
  dirs.push(root);
  await mkdir(join(root, "skills/greet"), { recursive: true });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "combined-example", version: "1.0.0" }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] },
        remote: { type: "streamable-http", url: "https://example.invalid/mcp" },
      },
    }),
  );
  await writeFile(join(root, "server.mjs"), "process.exit(0);\n");
  await writeFile(
    join(root, "skills/greet/SKILL.md"),
    "---\nname: greet\ndescription: Generated skill probe\n---\nGreet the user.\n",
  );
  const loaded = await loadAgentPlugin({ root });
  expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  return loaded.package!;
}

type Inherited = Record<string, { disabled?: boolean }>;

interface InjectorContext {
  location: { directory: string };
  mcp: {
    transform(
      edit: (editor: {
        get(name: string): Inherited[string] | undefined;
        set(name: string, server: unknown): void;
      }) => void,
    ): Promise<void>;
  };
  skill: { transform(edit: (editor: { add(skill: { id: string }): void }) => void): Promise<void> };
}

/** The generated injector beside its package tree, imported the way OpenCode loads it. */
async function loadInjector(source: AgentPluginPackage, inherited: Inherited = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-v2-injector-out-"));
  dirs.push(dir);
  const plan = await opencodeV2Projector.project(source, {
    target,
    hookArtifacts: [],
    onUnsupported: "error",
    support: resolveAgentPluginProjection(target, opencodeV2Projector).matrix!,
  });
  for (const file of plan.files) {
    const path = join(dir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
  }
  const plugin = await import(pathToFileURL(join(dir, "hooknostic-agent-plugin.js")).href);
  const sets: string[] = [];
  const skills: { id: string }[] = [];
  const transforms = { mcp: 0, skill: 0 };
  const ctx: InjectorContext = {
    location: { directory: dir },
    mcp: {
      transform: async (edit) => {
        transforms.mcp += 1;
        edit({ get: (name) => inherited[name], set: (name) => sets.push(name) });
      },
    },
    skill: {
      transform: async (edit) => {
        transforms.skill += 1;
        edit({ add: (skill) => skills.push(skill) });
      },
    },
  };
  return { plugin: plugin.default as { setup(ctx: InjectorContext): Promise<void> }, ctx, sets, skills, transforms };
}

describe("OpenCode v2 package injector and a host's disabled server", () => {
  it("leaves a package server the host disabled alone and still adds skills", async () => {
    const { plugin, ctx, sets, skills, transforms } = await loadInjector(await packageFixture(), {
      local: { disabled: true },
    });
    await plugin.setup(ctx);
    expect(sets).toEqual(["remote"]);
    expect(transforms.skill).toBe(1);
    expect(skills.map((skill) => skill.id)).toEqual(["combined-example/greet"]);
  });

  it("replaces a same-named package server the host left enabled", async () => {
    const { plugin, ctx, sets } = await loadInjector(await packageFixture(), { local: { disabled: false } });
    await plugin.setup(ctx);
    expect(sets).toEqual(["local", "remote"]);
  });

  it("registers package servers the host never declared", async () => {
    const { plugin, ctx, sets } = await loadInjector(await packageFixture());
    await plugin.setup(ctx);
    expect(sets).toEqual(["local", "remote"]);
  });
});
