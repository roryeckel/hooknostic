import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentDefinition,
  loadAgentPlugin,
  parseMarkdownFrontmatter,
} from "@hooknostic/agent-plugin";
import { buildPluginIR, resolveAgentPluginProjection } from "@hooknostic/core";
import { block, definePlugin, hook } from "@hooknostic/sdk";

import { generateCopilotArtifacts } from "./generate.js";
import { copilotAdapter } from "./index.js";
import { copilotAgentPluginProjector } from "./project-agent-plugin.js";
import { COPILOT_SKILL_POLICY_VALIDATION } from "./skill-policy.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const packageSupport = copilotAgentPluginProjector.profiles.find(
  (profile) => profile.components["agent-plugin.skills.invocation-policy"]?.level === "exact",
)!.components;

async function packageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-copilot-package-"));
  cleanup.push(root);
  const files: Record<string, string> = {
    "plugin.json": JSON.stringify(
      {
        $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
        name: "projector-probe",
        version: "1.0.0",
        description: "Projector probe",
      },
      null,
      2,
    ),
    "skills/deploy/SKILL.md":
      "---\nname: deploy\ndescription: Deploy probe.\n---\n\nRun ${SKILL_DIR}/deploy.sh from ${PLUGIN_ROOT}.\n",
    "skills/gated/SKILL.md":
      '---\nname: gated\ndescription: Withheld probe.\nmetadata:\n  hooknostic/allow-implicit-invocation: "false"\n---\n\nGated body.\n',
    "mcp.json": JSON.stringify(
      {
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          local: { type: "stdio", command: "node", args: ["${HOME}/server.js"] },
          remote: { type: "streamable-http", url: "https://example.invalid/mcp", headers: { "X-Key": "${TOKEN}" } },
          events: { type: "sse", url: "https://example.invalid/sse" },
        },
      },
      null,
      2,
    ),
    "com.github.copilot/agents/helper.agent.md": "# Helper\n",
    "com.github.copilot/hooks/hooks.json": JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          { type: "command", exec: "node", args: ["-e", "console.log('authored-marker')"] },
          { type: "command", exec: "node", args: ["${PLUGIN_ROOT}/runtime/hooknostic.mjs", "--audit"] },
        ],
      },
    }),
    "package.json": JSON.stringify({ name: "projector-probe", dependencies: { "is-number": "7.0.0" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

function hookArtifacts() {
  const { ir, diagnostics } = buildPluginIR(
    definePlugin({
      name: "projector-probe",
      hooks: [
        hook("tool.before", {
          id: "guard",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return block("no");
          },
        }),
      ],
    }),
  );
  expect(diagnostics).toEqual([]);
  const target = {
    id: "copilot",
    version: COPILOT_SKILL_POLICY_VALIDATION.version,
    delivery: "package" as const,
    output: ".",
  };
  return generateCopilotArtifacts(
    ir!,
    target,
    { code: "// runtime\n" },
    {
      runtime: { onHookError: "continue", timeoutMs: 5_000, contextCharLimit: 16_000, notifyCharLimit: 2_000 },
    },
  ).map((artifact) => ({
    path: artifact.path,
    contents: artifact.contents as string,
  }));
}

describe("Copilot Agent Plugin projector", () => {
  it("rates the invocation policy exact", () => {
    expect(packageSupport["agent-plugin.skills.invocation-policy"]).toMatchObject({
      level: "exact",
    });
  });

  it("refuses a package target older than the captured build", () => {
    const older = resolveAgentPluginProjection(
      {
        id: "copilot",
        version: `>=1.0 <${COPILOT_SKILL_POLICY_VALIDATION.version}`,
        delivery: "package",
        output: ".",
      },
      { profiles: copilotAgentPluginProjector.profiles },
    );
    expect(older.matrix).toBeUndefined();
    expect(older.diagnostics).toContainEqual(expect.objectContaining({ code: "HN203" }));
  });

  it("projects an Agent Plugins package with Copilot hooks, skills and MCP intact", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      runtimePackage: { manifest: "package.json", lockfile: "package-lock.json" },
      support: packageSupport,
      onUnsupported: "warn",
    });

    const paths = plan.files.map((file) => file.path);
    expect(paths).toContain("plugin.json");
    expect(paths).toContain("skills/deploy/SKILL.md");
    expect(paths).toContain("skills/gated/SKILL.md");
    expect(paths).toContain("mcp.json");
    expect(paths).toContain("com.github.copilot/agents/helper.agent.md");
    expect(paths).toContain("com.github.copilot/hooks/hooks.json");
    expect(paths).toContain("runtime/hooknostic.mjs");
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain("package-lock.json");

    const manifest = JSON.parse(plan.files.find((file) => file.path === "plugin.json")!.contents as string);
    expect(manifest).toMatchObject({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "projector-probe" });

    const skill = plan.files.find((file) => file.path === "skills/deploy/SKILL.md")!;
    expect(new TextDecoder().decode(skill.contents as Uint8Array)).toContain(
      "<absolute path of the directory containing this SKILL.md>/deploy.sh",
    );

    const hooks = plan.files.find((file) => file.path === "com.github.copilot/hooks/hooks.json")!;
    expect(hooks.contents).toContain("runtime/hooknostic.mjs");
    expect(hooks.contents).toContain("preToolUse");
    // The author's own hook entries are preserved beside the compiled dispatcher.
    expect(hooks.contents).toContain("authored-marker");
    expect(hooks.contents).toContain("sessionStart");

    // The exact gate is applied to an owned package skill: the portable
    // declaration stays and the native flag withholds model selection while
    // the plugin-namespaced slash invocation remains available.
    const gated = plan.files.find((file) => file.path === "skills/gated/SKILL.md")!;
    const gatedText = new TextDecoder().decode(gated.contents as Uint8Array);
    expect(gatedText).toContain("disable-model-invocation: true");
    expect(gatedText).toContain("hooknostic/allow-implicit-invocation");
    // The only omission is the dropped runtime package: the skipped count
    // below and this list must agree, or the summary reports "0 omitted".
    expect(plan.summary.omissions).toEqual([expect.objectContaining({ component: "agent-plugin.runtime-package" })]);
    expect(plan.summary.components["agent-plugin.skills.invocation-policy"]).toEqual({
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
    expect(plan.summary.components["agent-plugin.runtime-package"]).toEqual({
      discovered: 1,
      emitted: 0,
      skipped: 1,
    });
    expect(plan.summary.components["agent-plugin.client-extension.files"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });

    // A projection that merges an authored hook entry must still pass the
    // adapter's own artifact validation; that validator sees the final file,
    // not just the compiled one.
    const diagnostics = await copilotAdapter().validateArtifacts!(
      plan.files.map((file) => ({
        path: file.path,
        contents: typeof file.contents === "string" ? file.contents : Buffer.from(file.contents),
      })),
      { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package", output: "." },
    );
    expect(diagnostics).toEqual([]);
  });

  it("reports the ambient-reference deviation for every server Copilot expands", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: packageSupport,
      onUnsupported: "warn",
    });
    expect(plan.summary.deviations).toEqual([
      expect.objectContaining({ id: "mcp-environment-expansion", component: "agent-plugin.mcp.stdio", name: "local" }),
      expect.objectContaining({
        id: "mcp-environment-expansion",
        component: "agent-plugin.mcp.streamable-http",
        name: "remote",
      }),
    ]);
  });

  it("rewrites the skill text and declares both skill shortfalls", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: packageSupport,
      onUnsupported: "warn",
    });
    expect(plan.summary.degradations?.map((entry) => entry.id).sort()).toEqual([
      "skill-directory-model-substitution",
      "skill-reference-unexpanded",
    ]);
  });

  it("drops a skill and an MCP server the loader rejected", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "skills/broken"), { recursive: true });
    await writeFile(join(root, "skills/broken/SKILL.md"), "no frontmatter here\n");
    await writeFile(
      join(root, "mcp.json"),
      `${JSON.stringify(
        {
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            ok: { type: "stdio", command: "node" },
            bad: { type: "stdio", command: "" },
          },
        },
        null,
        2,
      )}\n`,
    );
    const loaded = await loadAgentPlugin({ root });
    expect(loaded.issues.some((issue) => issue.severity === "warn")).toBe(true);
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: packageSupport,
      onUnsupported: "warn",
    });
    expect(plan.files.map((file) => file.path)).not.toContain("skills/broken/SKILL.md");
    const mcp = JSON.parse(plan.files.find((file) => file.path === "mcp.json")!.contents as string);
    expect(Object.keys(mcp.mcpServers)).toEqual(["ok"]);
  });

  it("accepts a components-only package with no hooks document", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-copilot-components-only-"));
    cleanup.push(root);
    await mkdir(join(root, "skills", "only"), { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "components-only" }),
    );
    await writeFile(join(root, "skills", "only", "SKILL.md"), "---\nname: only\ndescription: Components only.\n---\n");
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: [],
      support: packageSupport,
      onUnsupported: "warn",
    });
    expect(plan.files.map((file) => file.path)).not.toContain("com.github.copilot/hooks/hooks.json");
    const diagnostics = await copilotAdapter().validateArtifacts!(
      plan.files.map((file) => ({
        path: file.path,
        contents: typeof file.contents === "string" ? file.contents : Buffer.from(file.contents),
      })),
      { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package", output: "." },
    );
    expect(diagnostics).toEqual([]);
  });

  it("applies the native gate to an owned package skill without an acceptance", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: packageSupport,
      onUnsupported: "warn",
    });
    const gated = plan.files.find((file) => file.path === "skills/gated/SKILL.md")!;
    expect(new TextDecoder().decode(gated.contents as Uint8Array)).toContain("disable-model-invocation: true");
    expect(
      plan.summary.degradations?.some((entry) => entry.component === "agent-plugin.skills.invocation-policy"),
    ).toBe(false);
  });

  it("rejects a compiled hooks entry that does not carry the dispatcher shape", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const artifacts = hookArtifacts().map((artifact) => {
      if (artifact.path !== "com.github.copilot/hooks/hooks.json") return artifact;
      const parsed = JSON.parse(artifact.contents) as { hooks: Record<string, { args: string[] }[]> };
      parsed.hooks.preToolUse![0]!.args[1] = "postToolUse";
      return { path: artifact.path, contents: JSON.stringify(parsed) };
    });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: artifacts,
      support: packageSupport,
      onUnsupported: "warn",
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: "com.github.copilot/hooks/hooks.json",
        message: expect.stringContaining("generated dispatcher shape"),
      }),
    );
  });

  it("does not classify an authored PascalCase hook as a generated dispatcher", async () => {
    const root = await packageRoot();
    await writeFile(
      join(root, "com.github.copilot/hooks/hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          SessionStart: [
            {
              type: "command",
              exec: "node",
              args: ["${PLUGIN_ROOT}/runtime/hooknostic.mjs", "sessionStart"],
            },
          ],
        },
      }),
    );
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: [],
      support: packageSupport,
      onUnsupported: "warn",
    });
    const diagnostics = await copilotAdapter().validateArtifacts!(
      plan.files.map((file) => ({
        path: file.path,
        contents: typeof file.contents === "string" ? file.contents : Buffer.from(file.contents),
      })),
      { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package", output: "." },
    );
    expect(diagnostics).toEqual([]);
  });

  it("rejects a package runtime that collides with the compiled dispatcher path", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(join(root, "runtime", "hooknostic.mjs"), "// authored runtime\n");
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: packageSupport,
      onUnsupported: "warn",
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: "runtime/hooknostic.mjs",
        message: expect.stringContaining("authored"),
      }),
    );
  });

  it("keeps an authored runtime when no compiled runtime replaces it", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(join(root, "runtime", "hooknostic.mjs"), "// authored runtime\n");
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: [],
      support: packageSupport,
      onUnsupported: "warn",
    });
    const authoredRuntime = plan.files.find((file) => file.path === "runtime/hooknostic.mjs");
    expect(
      typeof authoredRuntime?.contents === "string"
        ? authoredRuntime.contents
        : Buffer.from(authoredRuntime!.contents!).toString("utf8"),
    ).toBe("// authored runtime\n");
    expect(plan.summary.copiedPaths).toContain("runtime/hooknostic.mjs");
  });

  it("carries an authored hooks document when the package has no compiled hooks", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: [],
      support: packageSupport,
      onUnsupported: "warn",
    });
    const hooks = plan.files.find((file) => file.path === "com.github.copilot/hooks/hooks.json");
    expect(hooks?.contents).toContain("authored-marker");
    const diagnostics = await copilotAdapter().validateArtifacts!(
      plan.files.map((file) => ({
        path: file.path,
        contents: typeof file.contents === "string" ? file.contents : Buffer.from(file.contents),
      })),
      { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package", output: "." },
    );
    expect(diagnostics).toEqual([]);
  });

  // Entries 1.0.101's loader rejected (hooks-malformed probe). In a plugin one
  // of these rejects the whole hooks.json, so the merged dispatcher never runs.
  const REJECTED_ENTRIES: readonly [string, string, unknown][] = [
    ["a primitive", "sessionStart", 42],
    ["null", "sessionStart", null],
    ["an empty object", "sessionStart", {}],
    ["a command with no runner", "sessionStart", { type: "command" }],
    ["args without exec", "sessionStart", { type: "command", args: ["x"] }],
    ["exec beside a shell field", "sessionStart", { type: "command", exec: "node", bash: "exit 0" }],
    ["an unknown type", "sessionStart", { type: "bogus", exec: "node" }],
    ["a string timeoutSec", "sessionStart", { type: "command", exec: "node", timeoutSec: "soon" }],
    ["a string timeout", "sessionStart", { type: "command", bash: "exit 0", timeout: "soon" }],
    ["string args", "sessionStart", { type: "command", exec: "node", args: "x" }],
    ["a numeric arg", "sessionStart", { type: "command", exec: "node", args: ["x", 7] }],
    ["a string env", "sessionStart", { type: "command", bash: "exit 0", env: "A=1" }],
    ["a numeric env value", "sessionStart", { type: "command", exec: "node", env: { A: 1 } }],
    ["a numeric cwd", "sessionStart", { type: "command", bash: "exit 0", cwd: 5 }],
    ["a numeric exec", "sessionStart", { type: "command", exec: 42 }],
    ["a numeric bash", "sessionStart", { type: "command", bash: 42 }],
    ["an http hook without a url", "sessionStart", { type: "http" }],
    ["a plain http hook on preToolUse", "preToolUse", { type: "http", url: "http://example.invalid/hook" }],
    ["a prompt hook without a prompt", "sessionStart", { type: "prompt" }],
    ["a prompt hook off sessionStart", "agentStop", { type: "prompt", prompt: "x" }],
  ];

  // Entries the plugin loader accepted beside a sibling that then ran
  // (plugin-hooks-valid-shapes probe).
  const ACCEPTED_ENTRIES: readonly [string, string, unknown][] = [
    ["exec with args", "sessionStart", { type: "command", exec: "node", args: ["x"] }],
    ["exec without a type", "sessionStart", { exec: "node", args: ["x"] }],
    ["exec without args", "sessionStart", { type: "command", exec: "node" }],
    [
      "cwd, env and timeoutSec",
      "sessionStart",
      { type: "command", exec: "node", cwd: ".", env: { A: "1" }, timeoutSec: 10 },
    ],
    ["the timeout alias", "sessionStart", { type: "command", exec: "node", timeout: 10 }],
    ["a matcher", "sessionStart", { type: "command", exec: "node", matcher: "startup|new" }],
    ["an unknown field", "sessionStart", { type: "command", exec: "node", probeUnknown: true }],
    ["bash and powershell", "sessionStart", { type: "command", bash: "exit 0", powershell: "exit 0" }],
    ["bash alone", "sessionStart", { type: "command", bash: "exit 0" }],
    ["powershell alone", "sessionStart", { type: "command", powershell: "exit 0" }],
    ["command", "sessionStart", { type: "command", command: "exit 0" }],
    ["a sessionStart prompt", "sessionStart", { type: "prompt", prompt: "x" }],
    ["an http hook", "sessionStart", { type: "http", url: "http://example.invalid/hook" }],
    ["an https hook on preToolUse", "preToolUse", { type: "http", url: "https://example.invalid/hook" }],
  ];

  async function projectAuthoredEntry(event: string, entry: unknown) {
    const root = await packageRoot();
    await writeFile(
      join(root, "com.github.copilot/hooks/hooks.json"),
      JSON.stringify({ version: 1, hooks: { [event]: [entry] } }),
    );
    const loaded = await loadAgentPlugin({ root });
    return copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: packageSupport,
      onUnsupported: "warn",
    });
  }

  it.each(REJECTED_ENTRIES)("rejects an authored hook entry that is %s", async (_, event, entry) => {
    const plan = await projectAuthoredEntry(event, entry);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        path: "com.github.copilot/hooks/hooks.json",
        message: expect.stringContaining(`hooks.${event}[0]`),
      }),
    );
  });

  it.each(ACCEPTED_ENTRIES)("merges an authored hook entry with %s", async (_, event, entry) => {
    const plan = await projectAuthoredEntry(event, entry);
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const hooks = plan.files.find((file) => file.path === "com.github.copilot/hooks/hooks.json");
    expect(JSON.parse(hooks!.contents as string).hooks[event]).toContainEqual(entry);
  });

  it("fails validation for a hooks document with a malformed entry", async () => {
    const diagnostics = await copilotAdapter().validateArtifacts!(
      [
        { path: "plugin.json", contents: JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "probe" }) },
        {
          path: "com.github.copilot/hooks/hooks.json",
          contents: JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command" }] } }),
        },
      ],
      { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package", output: "." },
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN301", message: expect.stringContaining("hooks.sessionStart[0]") }),
    );
  });

  it("carries every compiled hook artifact path into the plan", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const artifacts = hookArtifacts();
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: artifacts,
      support: packageSupport,
      onUnsupported: "warn",
    });
    for (const artifact of artifacts) {
      expect(plan.files.map((file) => file.path)).toContain(artifact.path);
    }
  });

  const agent = (name: string, mode: AgentDefinition["mode"] = "subagent", native = {}): AgentDefinition => ({
    name,
    description: `${name} description`,
    mode,
    instructions: `${name} instructions\n`,
    native: { copilot: native },
    source: `/project/agents/${name}.md`,
  });

  const project = (portable: Awaited<ReturnType<typeof loadAgentPlugin>>["package"], agents: AgentDefinition[]) =>
    copilotAgentPluginProjector.project(portable!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: [],
      support: packageSupport,
      onUnsupported: "warn",
      agents,
    });

  it("writes each definition to the plugin's agents directory as <name>.agent.md", async () => {
    const loaded = await loadAgentPlugin({ root: await packageRoot() });
    const plan = await project(loaded.package, [agent("reviewer", "subagent", { tools: ["read"], model: "glm53" })]);
    expect(plan.issues).toEqual([]);
    const file = plan.files.find((candidate) => candidate.path === "agents/reviewer.agent.md");
    expect(file).toBeDefined();
    const text = typeof file!.contents === "string" ? file!.contents : new TextDecoder().decode(file!.contents);
    expect(parseMarkdownFrontmatter(text, "agents/reviewer.agent.md")).toEqual({
      data: { name: "reviewer", description: "reviewer description", tools: ["read"], model: "glm53" },
      body: "reviewer instructions\n",
    });
    expect(plan.summary.components["agents.definition"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(plan.summary.components["agents.native"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(plan.summary.copiedPaths).not.toContain("agents/reviewer.agent.md");
  });

  it("reports a primary-only definition as also delegable and omits a package default", async () => {
    const loaded = await loadAgentPlugin({ root: await packageRoot() });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: COPILOT_SKILL_POLICY_VALIDATION.version, delivery: "package" },
      hookArtifacts: [],
      support: packageSupport,
      onUnsupported: "warn",
      agents: [agent("planner", "primary")],
      defaultAgent: "planner",
    });
    expect(plan.summary.deviations).toContainEqual(
      expect.objectContaining({ id: "primary-agent-delegable", component: "agents.primary", name: "planner" }),
    );
    expect(plan.summary.omissions).toContainEqual(
      expect.objectContaining({ component: "agents.default", name: "planner" }),
    );
    expect(plan.summary.components["agents.default"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
  });

  it("refuses an agent path the package already provides", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "agents"), { recursive: true });
    await writeFile(join(root, "agents/reviewer.agent.md"), "authored");
    const loaded = await loadAgentPlugin({ root });
    const plan = await project(loaded.package, [agent("reviewer")]);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ severity: "error", component: "agents.definition", path: "agents/reviewer.agent.md" }),
    );
  });
});
