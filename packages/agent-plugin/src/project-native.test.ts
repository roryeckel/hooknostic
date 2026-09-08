import { describe, expect, it } from "vitest";
import { createNativeAgentPluginProjector } from "./project-native.js";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginComponentId,
  type AgentPluginComponentSupport,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginProjectionProfile,
} from "./types.js";

const encoder = new TextEncoder();
const target = { id: "native", version: "1.0.0", mode: "local" as const };

const profiles: readonly AgentPluginProjectionProfile[] = [
  {
    range: ">=1 <2",
    components: {},
    source: { date: "2026-09-08", validatedOn: [] },
  },
];

function source(options: {
  servers?: Record<string, AgentPluginMcpServer>;
  files?: string[];
  extensions?: Record<string, Record<string, unknown>>;
} = {}): AgentPluginPackage {
  const paths = ["plugin.json", ...(options.files ?? [])];
  return {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: {
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
      name: "portable-tools",
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    },
    skills: [],
    ...(options.servers === undefined
      ? {}
      : { mcp: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: options.servers } }),
    files: paths.map((path) => ({ path, contents: encoder.encode(path), mode: 0o644 })),
    contentDigest: "sha256:test",
  };
}

const project = async (
  pkg: AgentPluginPackage,
  support: Partial<Record<AgentPluginComponentId, AgentPluginComponentSupport>>,
) =>
  createNativeAgentPluginProjector<typeof target>({ profiles }).project(pkg, {
    target,
    hookArtifacts: [],
    support,
    onUnsupported: "warn",
  });

const stdio = { type: "stdio", command: "node" } as const;
const sse = { type: "sse", url: "https://example.invalid/sse" } as const;

describe("native Agent Plugin projection", () => {
  it("reports a component the harness cannot consume as skipped, not emitted", async () => {
    const plan = await project(source({ servers: { local: stdio, remote: sse } }), {
      "agent-plugin.manifest": { level: "exact" },
      "agent-plugin.mcp.stdio": { level: "exact" },
      "agent-plugin.mcp.sse": { level: "unsupported" },
    });

    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
    expect(plan.summary.components["agent-plugin.mcp.sse"]).toEqual({
      discovered: 1,
      emitted: 0,
      skipped: 1,
    });
    expect(plan.summary.omissions).toEqual([
      { component: "agent-plugin.mcp.sse", reason: expect.stringContaining("unsupported") },
    ]);
  });

  it("still ships the unsupported component's bytes verbatim", async () => {
    // Passthrough is the whole contract: filtering an sse server would mean
    // re-serializing mcp.json, and the server would then fail to reappear when
    // the harness gains support without a rebuild.
    const pkg = source({ files: ["mcp.json"], servers: { remote: sse } });
    const plan = await project(pkg, { "agent-plugin.mcp.sse": { level: "unsupported" } });

    expect(plan.files.map((file) => file.path).sort()).toEqual(["mcp.json", "plugin.json"]);
    expect(plan.summary.copiedPaths).toEqual(["mcp.json", "plugin.json"]);
  });

  it("treats a component missing from the matrix as unsupported", async () => {
    const plan = await project(source({ servers: { remote: sse } }), {});

    expect(plan.summary.components["agent-plugin.mcp.sse"]).toEqual({
      discovered: 1,
      emitted: 0,
      skipped: 1,
    });
  });

  it("counts the runtime package and client extension so neither drops out of the report", async () => {
    const projector = createNativeAgentPluginProjector<typeof target>({
      profiles,
      namespace: "com.example.harness",
    });
    const plan = await projector.project(
      source({
        files: ["com.example.harness/settings.json"],
        extensions: { "com.example.harness": { setting: true } },
      }),
      {
        target,
        hookArtifacts: [],
        runtimePackage: { manifest: "package.json", lockfile: "package-lock.json" },
        support: { "agent-plugin.client-extension.files": { level: "exact" } },
        onUnsupported: "warn",
      },
    );

    expect(plan.summary.components["agent-plugin.client-extension.files"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
    expect(plan.summary.components["agent-plugin.runtime-package"]).toEqual({
      discovered: 1,
      emitted: 0,
      skipped: 1,
    });
  });

  it("does not discover a client extension when the harness reads no namespace", async () => {
    const plan = await project(
      source({
        files: ["com.example.harness/settings.json"],
        extensions: { "com.example.harness": { setting: true } },
      }),
      {
        "agent-plugin.manifest": { level: "exact" },
        "agent-plugin.client-extension.files": { level: "unsupported" },
      },
    );

    expect(plan.summary.components).not.toHaveProperty("agent-plugin.client-extension.files");
    expect(plan.summary.omissions).toEqual([]);
  });
});
