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
  directories?: string[],
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
    ...(directories === undefined ? {} : { directories }),
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
    // The portable documents ship too. Codex drops them because a root
    // plugin.json outranks its native manifest; nested here they outrank
    // nothing, and a server may name one with ${PLUGIN_ROOT}.
    expect(paths).toContain(".opencode/plugins/package/plugin.json");
    expect(paths).toContain(".opencode/plugins/package/mcp.json");
  });

  // Under `onInvalid: "warn"` the loader reports an invalid skill and carries
  // on: the skill leaves `skills` while its files stay in `files`. Copying its
  // SKILL.md into the tree `skills.paths` names would hand OpenCode the skill
  // the loader said it skipped.
  it("drops a rejected skill's subtree while keeping a directory that is not a skill", async () => {
    const rejected = source({}, [
      "skills/broken/SKILL.md",
      "skills/broken/bin/serve.mjs",
      "skills/shared/logo.png",
      "skills/review-notes/SKILL.md",
    ]);
    const plan = await project({
      ...rejected,
      skills: [
        ...rejected.skills,
        {
          name: "review-notes",
          description: "Keep review notes",
          directory: "skills/review-notes",
          manifestPath: "skills/review-notes/SKILL.md",
        },
      ],
    });
    const paths = plan.files.map((candidate) => candidate.path);
    const nested = (path: string) => `.opencode/plugins/package/${path}`;
    // The whole rejected subtree goes, matching Claude and Codex.
    expect(paths).not.toContain(nested("skills/broken/SKILL.md"));
    expect(paths).not.toContain(nested("skills/broken/bin/serve.mjs"));
    expect(plan.summary.copiedPaths).not.toContain(nested("skills/broken/SKILL.md"));
    // `skills/shared` declares no SKILL.md, so it is not a skill and nothing is
    // wrong with this package -- dropping it would be a bug in a valid build.
    expect(paths).toContain(nested("skills/shared/logo.png"));
    // `skills/review-notes` is not inside `skills/review`, so a prefix test
    // would drop a declared skill.
    expect(paths).toContain(nested("skills/review-notes/SKILL.md"));
    expect(paths).toContain(nested("skills/review/SKILL.md"));
    expect(injector(plan)).toContain('const own = join(pluginRoot, "skills");');
    expect(plan.summary.components["agent-plugin.skills"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
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

  // McpLocalConfig has a cwd, and its own description says a relative one
  // "resolves from the workspace directory" -- so an absolute one is required,
  // and the portable default of the plugin root has to be stated rather than
  // left off, or a conformant `./bin/server` looks for itself in the user's
  // project.
  it("states the working directory absolutely, including the portable default", async () => {
    const plan = await project(
      source({
        worker: { type: "stdio", command: "./bin/serve", cwd: "${PLUGIN_ROOT}/worker" },
        plain: { type: "stdio", command: "node", args: ["server.mjs"] },
      }),
    );
    const servers = embeddedServers(plan);
    expect(servers["worker"]).toMatchObject({
      command: ["./bin/serve"],
      cwd: "__HOOKNOSTIC_PLUGIN_ROOT__/worker",
    });
    expect(servers["plain"]).toMatchObject({
      command: ["node", "server.mjs"],
      cwd: "__HOOKNOSTIC_PLUGIN_ROOT__",
    });
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
  });

  // Staging creates parents for emitted files only, so a directory carrying no
  // files -- a server's cwd, typically -- has to be named in the plan or it
  // never reaches the output and the server cannot start.
  it("carries an empty package directory into the nested package", async () => {
    const plan = await project(
      source(
        { worker: { type: "stdio", command: "node", cwd: "./worker" } },
        [],
        ["worker"],
      ),
    );
    expect(plan.directories).toContain(".opencode/plugins/package/worker");
  });

  it("refuses a package that already contains the substitution marker", async () => {
    const plan = await project(
      source({
        odd: { type: "stdio", command: "node", args: ["__HOOKNOSTIC_PLUGIN_ROOT__/x"] },
      }),
    );
    // Substitution is textual, so this value would be rewritten into an install
    // path the package never asked for.
    expect(Object.keys(embeddedServers(plan))).toEqual([]);
    expect(plan.summary.omissions).toContainEqual(
      expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "odd" }),
    );
  });

  it("leaves remote fields and unrecognized placeholders literal", async () => {
    const plan = await project(
      source({
        api: {
          type: "streamable-http",
          url: "https://example.invalid/${TENANT}/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      }),
    );
    // Agent Plugins 1.0: clients MUST NOT expand in url or headers, and
    // unrecognized placeholder-like text MUST stay literal. Resolving ${TOKEN}
    // from the environment would send a host secret to a package-chosen host.
    expect(embeddedServers(plan)["api"]).toMatchObject({
      type: "remote",
      url: "https://example.invalid/${TENANT}/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
    expect(injector(plan)).not.toContain("process.env");
    // Substitution is confined to a local server's argv, cwd and environment;
    // a remote server is returned untouched rather than walked.
    expect(injector(plan)).toContain('server.type !== "local"');
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
