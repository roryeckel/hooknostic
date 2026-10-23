import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentDefinition,
  type AgentPluginPackage,
  type AgentPluginProjectionPlan,
} from "@hooknostic/agent-plugin";
import { diagnosticsFromAgentPluginDegradations, resolveAgentPluginProjection } from "@hooknostic/core";

import { opencodeV2Harness } from "./harness.js";
import {
  opencodeV2Projector,
  opencodeV2ProjectProfiles,
  projectOpenCodeV2Components,
  projectOpenCodeV2Integration,
} from "./project.js";

type Plugin = { id: string; setup(ctx: unknown): unknown };
const roots: string[] = [];
const served: string[] = [];
(globalThis as { served?: string[] }).served = served;
afterEach(async () => {
  served.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const output = ".hooknostic/artifacts/opencode";
const text = (contents: string | Uint8Array): string =>
  typeof contents === "string" ? contents : new TextDecoder().decode(contents);

/** A checkout with generated v2 wiring whose probe artifact records which copy served. */
async function checkout(
  root: string,
  label: string,
  integrated = true,
): Promise<{ plugin: Plugin; components: Plugin }> {
  const artifact = ".opencode/plugins/hooknostic.js";
  await mkdir(join(root, output, ".opencode/plugins"), { recursive: true });
  await writeFile(
    join(root, output, artifact),
    `export default { id: "hooknostic.probe.opencode", setup() { globalThis.served.push(${JSON.stringify(label)}); } };\n`,
  );
  const integration = projectOpenCodeV2Integration([{ path: artifact, contents: "" }], output, "hooknostic.config.ts");
  const components = await projectOpenCodeV2Components(
    {
      origin: "direct",
      skills: [],
      mcp: {
        root: ".",
        config: {
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: { probe: { type: "streamable-http", url: `https://${label}.invalid/mcp` } },
        },
      },
    },
    root,
    output,
    "hooknostic.config.ts",
    {},
  );
  for (const file of [...integration.files, ...components.files].filter((f) => f.path.startsWith(".opencode/"))) {
    await mkdir(join(root, file.path, ".."), { recursive: true });
    await writeFile(join(root, file.path), text(file.contents));
  }
  if (integrated) {
    await mkdir(join(root, ".hooknostic"), { recursive: true });
    await writeFile(join(root, ".hooknostic/integration.json"), "{}\n");
  }
  const load = async (path: string) =>
    ((await import(pathToFileURL(join(root, path)).href)) as { default: Plugin }).default;
  return { plugin: await load(artifact), components: await load(".opencode/plugins/hooknostic-components.js") };
}

async function layout(nestedIntegrated = true) {
  const base = await mkdtemp(join(tmpdir(), "hooknostic-v2-nested-"));
  roots.push(base);
  const outerRoot = join(base, "outer");
  const nestedRoot = join(outerRoot, ".claude", "worktrees", "nested");
  const inside = join(nestedRoot, "src");
  await mkdir(inside, { recursive: true });
  return {
    outerRoot,
    inside,
    outer: await checkout(outerRoot, "outer"),
    nested: await checkout(nestedRoot, "nested", nestedIntegrated),
  };
}

async function serve(copies: Plugin[], directory: string): Promise<string[]> {
  const urls: string[] = [];
  const ctx = {
    location: { directory },
    mcp: {
      transform: async (edit: (editor: { set(name: string, server: { url: string }): void }) => void) =>
        edit({ set: (_name, server) => urls.push(server.url) }),
    },
  };
  for (const copy of copies) await copy.setup(ctx);
  return urls;
}

describe("OpenCode v2 project wiring in nested checkouts", () => {
  it("serves a nested checkout from its own copy, under a distinct id", async () => {
    const { outer, nested, inside } = await layout();
    expect(outer.plugin.id).not.toBe(nested.plugin.id);
    expect(outer.components.id).not.toBe(nested.components.id);
    expect(outer.plugin.id).toMatch(/^hooknostic\.probe\.opencode\.[0-9a-f]{12}$/);
    const urls = await serve([outer.plugin, nested.plugin, outer.components, nested.components], inside);
    expect(served).toEqual(["nested"]);
    expect(urls).toEqual(["https://nested.invalid/mcp"]);
  });

  it("leaves the outer checkout's own sessions to the outer copy", async () => {
    const { outer, nested, outerRoot } = await layout();
    const urls = await serve([outer.plugin, nested.plugin, outer.components, nested.components], outerRoot);
    expect(served).toEqual(["outer"]);
    expect(urls).toEqual(["https://outer.invalid/mcp"]);
  });

  it("falls back to the outer copy when the nested checkout has no integration", async () => {
    const { outer, inside } = await layout(false);
    const urls = await serve([outer.plugin, outer.components], inside);
    expect(served).toEqual(["outer"]);
    expect(urls).toEqual(["https://outer.invalid/mcp"]);
  });
});

describe("OpenCode v2 package projection of agent definitions", () => {
  const target = {
    id: "opencode",
    version: opencodeV2Harness.recommendedRange,
    delivery: "package" as const,
    output: "dist",
  };
  const support = resolveAgentPluginProjection(target, opencodeV2Projector).matrix!;
  const pkg: AgentPluginPackage = {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "portable-tools", version: "1.0.0" },
    skills: [],
    files: [{ path: "plugin.json", contents: new TextEncoder().encode("{}"), mode: 0o644 }],
    contentDigest: "sha256:source",
  };
  const definition = (
    name: string,
    native: AgentDefinition["native"] = {},
    mode: AgentDefinition["mode"] = "subagent",
  ): AgentDefinition => ({
    name,
    mode,
    description: `${name} description`,
    instructions: `${name} instructions\n`,
    native,
    source: `/project/agents/${name}.md`,
  });

  async function registeredAgents(
    plan: AgentPluginProjectionPlan,
    agents: Record<string, Record<string, unknown>> = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-v2-agents-"));
    roots.push(root);
    const modulePath = join(root, "hooknostic-agent-plugin.js");
    const artifact = plan.files.find((file) => file.path === "hooknostic-agent-plugin.js")!;
    await writeFile(join(root, "package.json"), '{ "type": "module" }\n');
    await writeFile(modulePath, text(artifact.contents));
    const plugin = ((await import(pathToFileURL(modulePath).href)) as { default: Plugin }).default;
    // The editor has no add; update on an unknown id upserts (.capture/agents).
    await plugin.setup({
      agent: {
        transform: async (
          edit: (editor: {
            update(id: string, fn: (agent: Record<string, unknown>) => void): void;
            remove(id: string): void;
          }) => void,
        ) =>
          edit({
            update: (id, fn) => {
              const agent = agents[id] ?? { request: { settings: {}, headers: {}, body: {} }, permissions: [] };
              fn(agent);
              agents[id] = agent;
            },
            remove: (id) => {
              delete agents[id];
            },
          }),
      },
    });
    return agents;
  }

  it.each([true, false])(
    "preserves hidden=%s on a packaged primary agent without a native shortfall",
    async (hidden) => {
      const plan = await opencodeV2Projector.project(pkg, {
        target,
        hookArtifacts: [],
        support,
        onUnsupported: "error",
        agents: [definition("planner", { opencode: { hidden } }, "primary")],
      });
      expect(plan.issues).toEqual([]);
      expect(plan.summary.omissions).toEqual([]);
      expect(plan.summary.degradations ?? []).toEqual([]);
      expect(plan.summary.components["agents.native"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
      expect((await registeredAgents(plan))["portable-tools-planner"]).toMatchObject({
        id: "portable-tools-planner",
        description: "planner description",
        mode: "primary",
        system: "planner instructions\n",
        hidden,
      });
    },
  );

  it.each([
    ["provider/model", { providerID: "provider", id: "model" }],
    ["provider/team/model#high", { providerID: "provider", id: "team/model", variant: "high" }],
    [
      { providerID: "provider", model: "model", variant: "high" },
      { providerID: "provider", id: "model", variant: "high" },
    ],
  ])("translates the native model selection %j and scalar fields", async (model, expected) => {
    const plan = await opencodeV2Projector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      agents: [definition("reviewer", { opencode: { model, color: "#123AbC", hidden: false, steps: 2 } })],
    });
    expect(plan.issues).toEqual([]);
    expect((await registeredAgents(plan))["portable-tools-reviewer"]).toMatchObject({
      model: expected,
      color: "#123AbC",
      hidden: false,
      steps: 2,
    });
    expect(plan.summary.omissions).toEqual([]);
    expect(plan.summary.degradations ?? []).toEqual([]);
    expect(plan.summary.components["agents.native"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
  });

  it("merges request maps and appends permissions with consuming-host path expansion", async () => {
    const resources = [
      "~/private/file",
      "$HOME/private/file",
      "$HOME\\private\\file",
      "~",
      "$HOME",
      "$HOME-other",
      "/absolute/file",
    ];
    const permissions = resources.map((resource) => ({ action: "read", resource, effect: "deny" }));
    permissions.push({ action: "shell", resource: "echo $HOME", effect: "deny" });
    const plan = await opencodeV2Projector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      agents: [
        definition("reviewer", {
          opencode: {
            request: { headers: { override: "agent" }, body: { override: [1, false, null] } },
            permissions,
          },
        }),
      ],
    });
    const existing = {
      request: {
        settings: { keep: true },
        headers: { keep: "header", override: "old" },
        body: { keep: "body", override: "old" },
      },
      permissions: [{ action: "read", resource: "guard", effect: "ask" }],
      model: { providerID: "existing", id: "existing" },
    };
    const registered = (await registeredAgents(plan, { "portable-tools-reviewer": existing }))[
      "portable-tools-reviewer"
    ]!;
    expect(registered["request"]).toEqual({
      settings: { keep: true },
      headers: { keep: "header", override: "agent" },
      body: { keep: "body", override: [1, false, null] },
    });
    expect(registered["model"]).toEqual({ providerID: "existing", id: "existing" });
    expect(registered["permissions"]).toEqual([
      { action: "read", resource: "guard", effect: "ask" },
      ...[
        join(homedir(), "private/file"),
        join(homedir(), "private/file"),
        join(homedir(), "private\\file"),
        homedir(),
        homedir(),
        "$HOME-other",
        "/absolute/file",
      ].map((resource) => ({ action: "read", resource, effect: "deny" })),
      { action: "shell", resource: "echo $HOME", effect: "deny" },
    ]);
    expect(plan.summary.omissions).toEqual([]);
    expect(plan.summary.degradations).toEqual([
      expect.objectContaining({ id: "agent-request-ignored", name: "reviewer" }),
    ]);
    const options = { target: target.id, adapter: "opencode", onDegraded: "error" as const, support };
    expect(diagnosticsFromAgentPluginDegradations(plan.summary.degradations!, options)).toEqual([
      expect.objectContaining({ code: "HN101", severity: "error", component: "agents.native" }),
    ]);
    expect(
      diagnosticsFromAgentPluginDegradations(plan.summary.degradations!, {
        ...options,
        accept: ["opencode:agent-request-ignored"],
      }),
    ).toEqual([expect.objectContaining({ code: "HN101", severity: "info" })]);
  });

  it.each([true, false])("applies disabled=%s to an existing qualified id", async (disabled) => {
    const plan = await opencodeV2Projector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      agents: [
        definition(
          "planner",
          { opencode: { disabled, model: "provider/model", request: { body: { flag: true } } } },
          "primary",
        ),
      ],
    });
    const agents = await registeredAgents(plan, {
      "portable-tools-planner": { request: { settings: {}, headers: {}, body: {} }, permissions: [], system: "old" },
    });
    expect(Object.hasOwn(agents, "portable-tools-planner")).toBe(!disabled);
    if (!disabled)
      expect(agents["portable-tools-planner"]).toMatchObject({
        system: "planner instructions\n",
        model: { providerID: "provider", id: "model" },
      });
    expect(plan.summary.degradations?.map((item) => item.id) ?? []).toEqual(
      disabled ? [] : ["primary-agent-model-ignored", "agent-request-ignored"],
    );
    expect(plan.summary.omissions).toEqual([]);
  });

  it.each([
    { mystery: true },
    { temperature: 0.2 },
    { hidden: "false" },
    { disabled: 1 },
    { color: "red" },
    { steps: 0 },
    { steps: 1.5 },
    { steps: Infinity },
    { model: "no-provider" },
    { model: "provider/model#" },
    { model: { providerID: "provider", id: "model" } },
    { model: { providerID: "provider", model: "model", variant: 1 } },
    { model: { providerID: "provider", model: "model", extra: true } },
    { request: { settings: { timeout: false } } },
    { request: { headers: { key: 1 } } },
    { request: { body: [] } },
    { request: { body: { invalid: undefined } } },
    { request: { body: { invalid: NaN } } },
    { permissions: "deny" },
    { permissions: [{ action: "read", resource: "*", effect: "block" }] },
    { permissions: [{ action: "read", resource: "*", effect: "deny", ignored: true }] },
  ])("rejects invalid or unrecognized native configuration %j", async (native) => {
    const plan = await opencodeV2Projector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
      agents: [definition("reviewer", { opencode: native })],
    });
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        scope: "agent",
        component: "agents.native",
        path: "/project/agents/reviewer.md",
        message: expect.stringContaining("native.opencode."),
      }),
    ]);
  });

  it("does not report empty request overlays as an active request shortfall", async () => {
    const plan = await opencodeV2Projector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      agents: [definition("reviewer", { opencode: { request: { headers: {}, body: {} } } })],
    });
    expect(plan.summary.degradations ?? []).toEqual([]);
  });

  it("reports the same model and request limitations on project delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-v2-native-project-"));
    roots.push(root);
    const projectSupport = resolveAgentPluginProjection(
      { ...target, delivery: "project" },
      { profiles: opencodeV2ProjectProfiles },
    ).matrix!;
    const plan = await projectOpenCodeV2Components(
      {
        origin: "direct",
        skills: [],
        agents: [
          definition(
            "planner",
            { opencode: { model: "provider/model", request: { headers: { custom: "value" } } } },
            "primary",
          ),
        ],
      },
      root,
      output,
      "hooknostic.config.ts",
      { support: projectSupport },
    );
    expect(plan.degradations?.map((item) => item.id)).toEqual(["primary-agent-model-ignored", "agent-request-ignored"]);
    expect(plan.files.some((file) => file.path === ".opencode/agents/planner.md")).toBe(true);
  });

  it("upserts each agent definition through the agent domain under its plugin-qualified id", async () => {
    const plan = await opencodeV2Projector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
      agents: [definition("reviewer", { opencode: { model: "provider/model" } }), definition("planner", {}, "primary")],
    });
    expect(plan.issues).toEqual([]);
    const agents = await registeredAgents(plan);
    expect(agents).toMatchObject({
      "portable-tools-reviewer": {
        id: "portable-tools-reviewer",
        description: "reviewer description",
        mode: "subagent",
        system: "reviewer instructions\n",
        model: { providerID: "provider", id: "model" },
      },
      // Registered in its own mode: v2 makes it a session's agent, not a subagent.
      "portable-tools-planner": {
        id: "portable-tools-planner",
        description: "planner description",
        mode: "primary",
        system: "planner instructions\n",
      },
    });
    expect(support["agents.native"]?.level).toBe("exact");
    expect(plan.summary.degradations ?? []).toEqual([]);
    expect(plan.summary.omissions).toEqual([]);
    expect(plan.summary.components["agents.definition"]).toEqual({ discovered: 2, emitted: 2, skipped: 0 });
    expect(plan.summary.components["agents.primary"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(plan.summary.components["agents.native"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
  });

  it("registers no agents for a package with none", async () => {
    const plan = await opencodeV2Projector.project(pkg, { target, hookArtifacts: [], support, onUnsupported: "error" });
    const artifact = plan.files.find((file) => file.path === "hooknostic-agent-plugin.js")!;
    expect(text(artifact.contents)).not.toContain("ctx.agent");
  });
});
