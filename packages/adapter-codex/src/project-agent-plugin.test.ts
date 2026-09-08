import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginFile,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginProjectionPlan,
} from "@hooknostic/agent-plugin";
import { diagnosticsFromAgentPluginIssues, resolveAgentPluginProjection } from "@hooknostic/core";
import { codexAgentPluginProjector } from "./project-agent-plugin.js";

const encoder = new TextEncoder();
const file = (path: string): AgentPluginFile => ({
  path,
  contents: encoder.encode(path),
  mode: 0o644,
});

function source(
  servers: Record<string, AgentPluginMcpServer> = {},
  manifest: Partial<AgentPluginPackage["manifest"]> = {},
): AgentPluginPackage {
  return {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: {
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
      name: "portable-tools",
      version: "1.2.3",
      ...manifest,
    },
    skills: [],
    ...(Object.keys(servers).length === 0
      ? {}
      : { mcp: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: servers } }),
    files: [file("plugin.json"), file("mcp.json"), file("src/server.mjs")],
    contentDigest: "sha256:source",
  };
}

const target = { id: "codex", version: ">=0.148 <1", mode: "plugin" as const, output: "dist" };
// Resolved from the projector's own profiles rather than restated, so these
// tests cannot disagree with the matrix the build reports.
const support = resolveAgentPluginProjection(target, codexAgentPluginProjector).matrix!;

const project = (pkg: AgentPluginPackage) =>
  codexAgentPluginProjector.project(pkg, {
    target,
    hookArtifacts: [],
    support,
    onUnsupported: "error",
  });

function nativeMcp(plan: AgentPluginProjectionPlan): Record<string, Record<string, unknown>> {
  const artifact = plan.files.find((candidate) => candidate.path === ".mcp.json")!;
  const text =
    typeof artifact.contents === "string"
      ? artifact.contents
      : new TextDecoder().decode(artifact.contents);
  return (JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
}

function manifestOf(plan: AgentPluginProjectionPlan): Record<string, unknown> {
  const artifact = plan.files.find((candidate) => candidate.path === ".codex-plugin/plugin.json")!;
  const text =
    typeof artifact.contents === "string"
      ? artifact.contents
      : new TextDecoder().decode(artifact.contents);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("Agent Plugin to Codex projection", () => {
  // The native route expands no Agent Plugins placeholder and binds no
  // PLUGIN_ROOT env, unlike the portable route it replaces, but it does resolve
  // `cwd` against the plugin root (.capture/codex-native-mcp). Passing the
  // placeholder through would hand the server literal text.
  it("re-anchors plugin-root paths against an explicit working directory", async () => {
    const plan = await project(
      source({
        srv: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/src/server.mjs", "--flag"],
        },
      }),
    );
    expect(nativeMcp(plan)["srv"]).toEqual({
      command: "node",
      args: ["src/server.mjs", "--flag"],
      cwd: ".",
    });
  });

  it("re-anchors against a declared working directory rather than the plugin root", async () => {
    const plan = await project(
      source({
        srv: {
          type: "stdio",
          command: "./bin/serve",
          args: ["${PLUGIN_ROOT}/src/server.mjs"],
          cwd: "${PLUGIN_ROOT}/worker",
        },
      }),
    );
    expect(nativeMcp(plan)["srv"]).toEqual({
      command: "../bin/serve",
      args: ["../src/server.mjs"],
      cwd: "worker",
    });
  });

  it("omits a server whose paths need ${PLUGIN_DATA}", async () => {
    const plan = await project(
      source({
        stateful: { type: "stdio", command: "node", args: ["${PLUGIN_DATA}/state.json"] },
        plain: { type: "stdio", command: "node" },
      }),
    );
    expect(Object.keys(nativeMcp(plan))).toEqual(["plain"]);
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 2,
      emitted: 1,
      skipped: 1,
    });
    expect(plan.summary.omissions).toContainEqual(
      expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "stateful" }),
    );
    // onUnsupported is "error" here, so a dropped server fails the build rather
    // than shipping a plugin quietly missing one.
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ severity: "error", component: "agent-plugin.mcp.stdio" }),
    );
    // HN205 "valid component unsupported", not HN503 "invalid package": the
    // package is fine, this target cannot represent one of its servers. The
    // component's level is `emulated`, so analysis raises nothing of its own
    // and this is the only diagnostic the omission produces.
    expect(diagnosticsFromAgentPluginIssues(plan.issues, "codex")).toContainEqual(
      expect.objectContaining({ code: "HN205", component: "agent-plugin.mcp.stdio" }),
    );
  });

  it("keeps a server whose name would collide with Object.prototype", async () => {
    const plan = await project(
      source({ ["__proto__"]: { type: "stdio", command: "node" } } as Record<
        string,
        AgentPluginMcpServer
      >),
    );
    // Assigned into a plain `{}` this reaches the inherited setter, so
    // JSON.stringify drops it while the summary still counts it emitted.
    expect(Object.keys(nativeMcp(plan))).toEqual(["__proto__"]);
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
  });

  it("carries the manifest metadata Codex accepts rather than dropping it", async () => {
    const plan = await project(
      source(
        {},
        {
          description: "portable description",
          author: { name: "Author" },
          homepage: "https://example.invalid",
          repository: "https://example.invalid/repo",
          license: "MIT",
          keywords: ["one", "two"],
        },
      ),
    );
    expect(manifestOf(plan)).toMatchObject({
      name: "portable-tools",
      version: "1.2.3",
      description: "portable description",
      author: { name: "Author" },
      homepage: "https://example.invalid",
      repository: "https://example.invalid/repo",
      license: "MIT",
      keywords: ["one", "two"],
    });
  });
});
