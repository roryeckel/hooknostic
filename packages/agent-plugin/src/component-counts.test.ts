import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "./agent-definitions.js";
import { componentSummary, discoverComponents } from "./component-counts.js";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginSkill,
} from "./types.js";

const encoder = new TextEncoder();

function source(
  options: {
    servers?: Record<string, AgentPluginMcpServer>;
    files?: string[];
    skills?: number;
    extensions?: Record<string, Record<string, unknown>>;
  } = {},
): AgentPluginPackage {
  const paths = ["plugin.json", ...(options.files ?? [])];
  const skills: AgentPluginSkill[] = Array.from({ length: options.skills ?? 0 }, (_, index) => ({
    name: `skill-${index}`,
    description: `Skill ${index}`,
    directory: `skills/skill-${index}`,
    manifestPath: `skills/skill-${index}/SKILL.md`,
  }));
  return {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: {
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
      name: "portable-tools",
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    },
    skills,
    ...(options.servers === undefined
      ? {}
      : { mcp: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: options.servers } }),
    files: paths.map((path) => ({ path, contents: encoder.encode(path), mode: 0o644 })),
    contentDigest: "sha256:test",
  };
}

const stdio = { type: "stdio", command: "node" } as const;
const sse = { type: "sse", url: "https://example.invalid/sse" } as const;

describe("componentSummary", () => {
  it("counts each MCP transport under its own component", () => {
    const counts = componentSummary(source({ servers: { a: stdio, b: stdio, c: sse } }));
    expect(counts["agent-plugin.mcp.stdio"]).toEqual({ discovered: 2, emitted: 2, skipped: 0 });
    expect(counts["agent-plugin.mcp.sse"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(counts["agent-plugin.mcp.streamable-http"]).toBeUndefined();
  });

  it("counts the runtime package and client extension so neither drops out of the report", () => {
    const counts = componentSummary(
      source({
        skills: 2,
        files: ["com.example.client/overlay.json"],
        extensions: { "com.example.client": { flag: true } },
      }),
      { namespace: "com.example.client", hasRuntimePackage: true },
    );
    expect(counts["agent-plugin.manifest"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
    expect(counts["agent-plugin.skills"]).toEqual({ discovered: 2, emitted: 2, skipped: 0 });
    // One overlay file plus the manifest extension.
    expect(counts["agent-plugin.client-extension.files"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
    expect(counts["agent-plugin.runtime-package"]).toEqual({
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
  });

  it("does not discover a client extension when the harness reads no namespace", () => {
    const counts = componentSummary(
      source({
        files: ["com.example.client/overlay.json"],
        extensions: { "com.example.client": { flag: true } },
      }),
    );
    expect(counts["agent-plugin.client-extension.files"]).toBeUndefined();
  });

  it("splits a component the harness will not consume into emitted and skipped", () => {
    const counts = componentSummary(source({ servers: { a: stdio, b: sse, c: sse } }), {
      skipped: (component, discovered) => (component === "agent-plugin.mcp.sse" ? discovered : 0),
    });
    expect(counts["agent-plugin.mcp.sse"]).toEqual({ discovered: 2, emitted: 0, skipped: 2 });
    expect(counts["agent-plugin.mcp.stdio"]).toEqual({ discovered: 1, emitted: 1, skipped: 0 });
  });

  it("never reports more skipped than discovered", () => {
    // A projector's own arithmetic is not trusted into the report: a negative
    // `emitted` would read as a component the harness gains rather than loses.
    const counts = componentSummary(source({ skills: 1 }), { skipped: () => 99 });
    expect(counts["agent-plugin.skills"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
  });

  it("omits every component the package does not contain", () => {
    expect(Object.keys(componentSummary(source()))).toEqual(["agent-plugin.manifest"]);
  });
});

describe("discoverComponents", () => {
  const agent = (name: string, native: AgentDefinition["native"] = {}): AgentDefinition => ({
    name,
    description: `${name} description`,
    instructions: `${name} instructions`,
    native,
    source: `/agents/${name}.md`,
  });

  it("counts agent definitions configured beside the package, and native fields only for the harness asked about", () => {
    const agents = [
      agent("reviewer", { claude: { model: "sonnet" } }),
      agent("planner", { opencode: { model: "x/y" } }),
      agent("tester"),
    ];
    const claude = discoverComponents(source(), { agents, harness: "claude" });
    expect(claude.get("agents.definition")).toBe(3);
    expect(claude.get("agents.native")).toBe(1);
    // Another harness's native block is not this harness's component.
    expect(discoverComponents(source(), { agents, harness: "codex" }).has("agents.native")).toBe(false);
    // Without a harness, native fields are never attributed to one.
    expect(discoverComponents(source(), { agents }).has("agents.native")).toBe(false);
  });

  it("discovers no agent component when none is configured", () => {
    const discovered = discoverComponents(source(), { agents: [], harness: "claude" });
    expect([...discovered.keys()]).toEqual(["agent-plugin.manifest"]);
  });

  it("feeds componentSummary, so a skipped agent definition is reported rather than dropped", () => {
    const counts = componentSummary(source(), {
      agents: [agent("reviewer", { codex: { model: "m" } })],
      harness: "codex",
      skipped: (component, discovered) => (component.startsWith("agents.") ? discovered : 0),
    });
    expect(counts["agents.definition"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
    expect(counts["agents.native"]).toEqual({ discovered: 1, emitted: 0, skipped: 1 });
  });
});
