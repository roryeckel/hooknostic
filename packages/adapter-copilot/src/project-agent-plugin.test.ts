import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA, loadAgentPlugin } from "@hooknostic/agent-plugin";
import { buildPluginIR } from "@hooknostic/core";
import { block, definePlugin, hook } from "@hooknostic/sdk";

import { generateCopilotArtifacts } from "./generate.js";
import { copilotHarness } from "./harness.js";
import { copilotAdapter } from "./index.js";
import { copilotAgentPluginProjector } from "./project-agent-plugin.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
  const target = { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" as const, output: "." };
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
  it("projects an Agent Plugins package with Copilot hooks, skills and MCP intact", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      runtimePackage: { manifest: "package.json", lockfile: "package-lock.json" },
      support: copilotAgentPluginProjector.profiles[0]!.components,
      onUnsupported: "warn",
    });

    const paths = plan.files.map((file) => file.path);
    expect(paths).toContain("plugin.json");
    expect(paths).toContain("skills/deploy/SKILL.md");
    expect(paths).toContain("mcp.json");
    expect(paths).toContain("com.github.copilot/agents/helper.agent.md");
    expect(paths).toContain("com.github.copilot/hooks/hooks.json");
    expect(paths).toContain("runtime/hooknostic.mjs");
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain("package-lock.json");
    expect(paths).not.toContain("skills/gated/SKILL.md");

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

    // A gated skill is omitted rather than emitted with a flag that would make
    // it unreachable on 1.0.101.
    expect(plan.summary.omissions).toEqual([
      expect.objectContaining({ component: "agent-plugin.skills.invocation-policy", name: "gated" }),
    ]);
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
      { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package", output: "." },
    );
    expect(diagnostics).toEqual([]);
  });

  it("reports the ambient-reference deviation for every server Copilot expands", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: copilotAgentPluginProjector.profiles[0]!.components,
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
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: copilotAgentPluginProjector.profiles[0]!.components,
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
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: copilotAgentPluginProjector.profiles[0]!.components,
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
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: [],
      support: copilotAgentPluginProjector.profiles[0]!.components,
      onUnsupported: "warn",
    });
    expect(plan.files.map((file) => file.path)).not.toContain("com.github.copilot/hooks/hooks.json");
    const diagnostics = await copilotAdapter().validateArtifacts!(
      plan.files.map((file) => ({
        path: file.path,
        contents: typeof file.contents === "string" ? file.contents : Buffer.from(file.contents),
      })),
      { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package", output: "." },
    );
    expect(diagnostics).toEqual([]);
  });

  it("permits the documented acceptance of an unprojectable invocation policy", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: copilotAgentPluginProjector.profiles[0]!.components,
      onUnsupported: "warn",
      accept: ["copilot:skill-implicit-invocation-unenforced"],
    });
    // The declaration is now accepted rather than rejected as unknown (HN501).
    expect(plan.files.map((file) => file.path)).toContain("skills/gated/SKILL.md");
    expect(plan.summary.degradations).toContainEqual(
      expect.objectContaining({
        id: "skill-implicit-invocation-unenforced",
        component: "agent-plugin.skills.invocation-policy",
        name: "gated",
      }),
    );
  });

  it("rejects a package runtime that collides with the compiled dispatcher path", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(join(root, "runtime", "hooknostic.mjs"), "// authored runtime\n");
    const loaded = await loadAgentPlugin({ root });
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: hookArtifacts(),
      support: copilotAgentPluginProjector.profiles[0]!.components,
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
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: [],
      support: copilotAgentPluginProjector.profiles[0]!.components,
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
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: [],
      support: copilotAgentPluginProjector.profiles[0]!.components,
      onUnsupported: "warn",
    });
    const hooks = plan.files.find((file) => file.path === "com.github.copilot/hooks/hooks.json");
    expect(hooks?.contents).toContain("authored-marker");
    const diagnostics = await copilotAdapter().validateArtifacts!(
      plan.files.map((file) => ({
        path: file.path,
        contents: typeof file.contents === "string" ? file.contents : Buffer.from(file.contents),
      })),
      { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package", output: "." },
    );
    expect(diagnostics).toEqual([]);
  });

  it("carries every compiled hook artifact path into the plan", async () => {
    const root = await packageRoot();
    const loaded = await loadAgentPlugin({ root });
    const artifacts = hookArtifacts();
    const plan = await copilotAgentPluginProjector.project(loaded.package!, {
      target: { id: "copilot", version: copilotHarness.recommendedRange, delivery: "package" },
      hookArtifacts: artifacts,
      support: copilotAgentPluginProjector.profiles[0]!.components,
      onUnsupported: "warn",
    });
    for (const artifact of artifacts) {
      expect(plan.files.map((file) => file.path)).toContain(artifact.path);
    }
  });
});
