import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginFile,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginProjectionPlan,
} from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";
import { opencodeAgentPluginProjector } from "./project-agent-plugin.js";

const encoder = new TextEncoder();
const file = (path: string): AgentPluginFile => ({
  path,
  contents: encoder.encode(path),
  mode: 0o644,
});

function source(
  servers: Record<string, AgentPluginMcpServer> = {},
  files: string[] = [],
): AgentPluginPackage {
  return {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "portable-tools", version: "1.2.3" },
    skills: [
      {
        name: "review",
        description: "Review code",
        directory: "skills/review",
        manifestPath: "skills/review/SKILL.md",
      },
    ],
    ...(Object.keys(servers).length === 0
      ? {}
      : { mcp: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: servers } }),
    files: [
      file("plugin.json"),
      file("mcp.json"),
      file("skills/review/SKILL.md"),
      ...files.map(file),
    ],
    contentDigest: "sha256:source",
  };
}

const target = { id: "opencode", version: ">=1.18 <2", mode: "local" as const, output: "dist" };
const support = resolveAgentPluginProjection(target, opencodeAgentPluginProjector).matrix!;

const project = (pkg: AgentPluginPackage) =>
  opencodeAgentPluginProjector.project(pkg, {
    target,
    hookArtifacts: [],
    support,
    onUnsupported: "error",
  });

function injector(plan: AgentPluginProjectionPlan): string {
  const artifact = plan.files.find(
    (candidate) => candidate.path === ".opencode/plugins/hooknostic-agent-plugin.js",
  )!;
  return typeof artifact.contents === "string"
    ? artifact.contents
    : new TextDecoder().decode(artifact.contents);
}

function embeddedServers(plan: AgentPluginProjectionPlan): Record<string, Record<string, unknown>> {
  const match = injector(plan).match(/const mcpServers = JSON\.parse\((.*)\);/)!;
  return JSON.parse(JSON.parse(match[1]!) as string) as Record<string, Record<string, unknown>>;
}

describe("Agent Plugin to OpenCode projection", () => {
  // An MCP server names its implementation with ${PLUGIN_ROOT}/..., so copying
  // only the skill trees leaves that argv pointing at a file the output does not
  // contain -- a server reported emitted that cannot start.
  it("ships the whole package, not only its skills", async () => {
    const plan = await project(source({}, ["src/server.mjs", "assets/data.json"]));
    const paths = plan.files.map((candidate) => candidate.path);
    expect(paths).toContain(".opencode/plugins/package/src/server.mjs");
    expect(paths).toContain(".opencode/plugins/package/assets/data.json");
    expect(paths).toContain(".opencode/plugins/package/skills/review/SKILL.md");
    // Replaced by the generated module, so shipping them would be dead weight.
    expect(paths).not.toContain(".opencode/plugins/package/plugin.json");
    expect(paths).not.toContain(".opencode/plugins/package/mcp.json");
  });

  it("nests package content below the flat plugin scan", async () => {
    const plan = await project(source({}, ["helper.js", "index.ts"]));
    // OpenCode loads EVERY module directly in .opencode/plugins/ and a
    // non-function export fails the whole module, so package code must never
    // land at that level.
    const topLevel = plan.files
      .map((candidate) => candidate.path)
      .filter((path) => /^\.opencode\/plugins\/[^/]+$/.test(path));
    expect(topLevel).toEqual([".opencode/plugins/hooknostic-agent-plugin.js"]);
  });

  it("points ${PLUGIN_ROOT} at the nested package, not at the module", async () => {
    const plan = await project(source({}, ["src/server.mjs"]));
    expect(injector(plan)).toContain(
      'const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "package");',
    );
  });

  it("omits a server declaring a working directory OpenCode cannot express", async () => {
    const plan = await project(
      source({
        worker: { type: "stdio", command: "node", args: ["s.mjs"], cwd: "${PLUGIN_ROOT}/worker" },
        plain: { type: "stdio", command: "node" },
      }),
    );
    expect(Object.keys(embeddedServers(plan))).toEqual(["plain"]);
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 2,
      emitted: 1,
      skipped: 1,
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ severity: "error", component: "agent-plugin.mcp.stdio" }),
    );
  });

  it("omits a server whose paths need ${PLUGIN_DATA}", async () => {
    const plan = await project(
      source({ stateful: { type: "stdio", command: "node", args: ["${PLUGIN_DATA}/state"] } }),
    );
    expect(Object.keys(embeddedServers(plan))).toEqual([]);
    expect(plan.summary.omissions).toContainEqual(
      expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "stateful" }),
    );
  });

  it("keeps a server whose name would collide with Object.prototype", async () => {
    const plan = await project(
      source({ ["__proto__"]: { type: "stdio", command: "node" } } as Record<
        string,
        AgentPluginMcpServer
      >),
    );
    // Written as an object literal this key would set the prototype, so the
    // module is emitted as JSON text and parsed at load time instead.
    expect(Object.keys(embeddedServers(plan))).toEqual(["__proto__"]);
    expect(injector(plan)).toContain("Object.defineProperty(config.mcp, name, {");
  });
});
