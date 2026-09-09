import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import type { McpLauncherDocument } from "@hooknostic/core";
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

function launcherDocument(plan: AgentPluginProjectionPlan): McpLauncherDocument {
  const artifact = plan.files.find(
    (candidate) => candidate.path === ".opencode/plugins/hooknostic-runtime/mcp-servers.json",
  )!;
  const text =
    typeof artifact.contents === "string"
      ? artifact.contents
      : new TextDecoder().decode(artifact.contents);
  return JSON.parse(text) as McpLauncherDocument;
}

function embeddedServers(plan: AgentPluginProjectionPlan): Record<string, Record<string, unknown>> {
  const match = injector(plan).match(/const mcpServers = JSON\.parse\((.*)\);/)!;
  return JSON.parse(JSON.parse(match[1]!) as string) as Record<string, Record<string, unknown>>;
}

describe("Agent Plugin to OpenCode projection", () => {
  // Every validatedOn record for this projection is 1.18.29. A profile reaching
  // below that would let a build claim exact/emulated support for a config hook,
  // a skills.paths merge and an MCP shape nothing has watched on those releases.
  it("declines versions below the ones its evidence covers", () => {
    const evidenced = opencodeAgentPluginProjector.profiles.flatMap((profile) =>
      (profile.source?.validatedOn ?? []).map((record) => record.version),
    );
    expect(evidenced.length).toBeGreaterThan(0);
    expect(evidenced.every((version) => version.startsWith("1.18."))).toBe(true);

    const older = { id: "opencode", version: ">=1.10 <1.18", mode: "local" as const, output: "d" };
    expect(resolveAgentPluginProjection(older, opencodeAgentPluginProjector).matrix).toBeUndefined();
  });

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
      "const here = dirname(fileURLToPath(import.meta.url));",
    );
    expect(injector(plan)).toContain('const pluginRoot = join(here, "package");');
    // A sibling of the package, so it is neither inside the author's namespace
    // nor at the level OpenCode's flat scan loads.
    expect(injector(plan)).toContain(
      'const launcher = join(here, "hooknostic-runtime", "mcp-launcher.mjs");',
    );
  });

  // OpenCode binds neither variable, so every stdio server runs through the
  // launcher. McpLocalConfig's own cwd description says a relative one "resolves
  // from the workspace directory", so the launcher is anchored absolutely; it
  // then chdirs the server itself.
  it("launches every stdio server through the generated launcher", async () => {
    const plan = await project(
      source({
        worker: {
          type: "stdio",
          command: "./bin/serve",
          cwd: "${PLUGIN_ROOT}/worker",
          // Declared, so the "no environment key" assertion below has something
          // to bite on: without it the emitted server has none either way.
          env: { TOKEN: "literal", CONFIG: "${PLUGIN_ROOT}/c.json" },
        },
        plain: { type: "stdio", command: "node", args: ["server.mjs"] },
      }),
    );
    const servers = embeddedServers(plan);
    expect(servers["worker"]).toEqual({
      type: "local",
      command: ["node", "__HOOKNOSTIC_LAUNCHER__", "0"],
      cwd: "__HOOKNOSTIC_PLUGIN_ROOT__",
      enabled: true,
    });
    expect(servers["plain"]).toMatchObject({
      command: ["node", "__HOOKNOSTIC_LAUNCHER__", "1"],
    });
    // Never emitted: whether OpenCode merges `environment` with the parent or
    // replaces it is uncaptured, and replacing would strip the PATH that
    // command[0] resolves through. The launcher applies it instead.
    for (const server of Object.values(servers)) expect(server).not.toHaveProperty("environment");
    expect(launcherDocument(plan).servers.map((entry) => entry.name)).toEqual(["worker", "plain"]);
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
  });

  // The module is what OpenCode actually runs, so the markers have to become
  // real absolute paths at load time -- on Windows too, where a JSON round-trip
  // of a plugin root would corrupt its backslashes.
  it("resolves both markers to real paths when the module is loaded", async () => {
    const plan = await project(
      source({
        srv: { type: "stdio", command: "node" },
        api: {
          type: "streamable-http",
          // Carries the marker AND an unrecognized placeholder: a client MUST
          // NOT expand in url or headers, so neither may be rewritten at load.
          url: "https://example.invalid/__HOOKNOSTIC_PLUGIN_ROOT__/${TENANT}/mcp",
        },
      }),
    );
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-opencode-injector-"));
    try {
      const modulePath = join(dir, "hooknostic-agent-plugin.mjs");
      await writeFile(modulePath, injector(plan));
      const config: { mcp?: Record<string, Record<string, unknown>> } = {};
      const plugin = await (await import(pathToFileURL(modulePath).href)).default();
      plugin.config(config);
      expect(config.mcp!["srv"]!["command"]).toEqual([
        "node",
        join(dir, "hooknostic-runtime", "mcp-launcher.mjs"),
        "0",
      ]);
      expect(config.mcp!["srv"]!["cwd"]).toBe(join(dir, "package"));
      // A remote server is returned untouched: neither the marker nor the
      // unrecognized placeholder is rewritten.
      expect(config.mcp!["api"]!["url"]).toBe(
        "https://example.invalid/__HOOKNOSTIC_PLUGIN_ROOT__/${TENANT}/mcp",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // U+2028 and U+2029 are JavaScript line terminators that JSON.stringify leaves
  // literal, and `description` and `version` are unconstrained strings in the
  // schema. Unescaped, a package's own metadata ends the generated `//` comment
  // and the rest of it RUNS -- confirmed by loading the module before the fix.
  it("neutralizes line terminators in the metadata comment", async () => {
    const pkg = source();
    pkg.manifest = {
      ...pkg.manifest,
      description: "harmless globalThis.HOOKNOSTIC_PWNED = 'yes'; //",
      version: "1.0.0 globalThis.HOOKNOSTIC_PWNED_TOO = 'yes'; //",
    };
    const plan = await project(pkg);
    const text = injector(plan);
    expect(text).not.toContain(" ");
    expect(text).not.toContain(" ");

    const dir = await mkdtemp(join(tmpdir(), "hooknostic-opencode-metadata-"));
    try {
      const modulePath = join(dir, "injector.mjs");
      await writeFile(modulePath, text);
      await import(pathToFileURL(modulePath).href);
      const scope = globalThis as Record<string, unknown>;
      expect(scope["HOOKNOSTIC_PWNED"]).toBeUndefined();
      expect(scope["HOOKNOSTIC_PWNED_TOO"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A backslash is an ordinary filename character on POSIX and a separator on
  // Windows, so a package built on one and consumed on the other resolves
  // outside the plugin root.
  it.each([
    ["command", { type: "stdio" as const, command: "./..\\..\\tool.exe" }],
    ["cwd", { type: "stdio" as const, command: "node", cwd: "./..\\..\\Windows" }],
  ])("omits a server whose %s would resolve differently on the consumer", async (_label, server) => {
    const plan = await project(source({ srv: server }));
    expect(Object.keys(embeddedServers(plan))).toEqual([]);
    expect(plan.summary.omissions).toContainEqual(
      expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "srv" }),
    );
  });

  it("keeps both generated files below the flat plugin scan", async () => {
    const plan = await project(source({ srv: { type: "stdio", command: "node" } }));
    const paths = plan.files.map((candidate) => candidate.path);
    expect(paths).toContain(".opencode/plugins/hooknostic-runtime/mcp-launcher.mjs");
    expect(paths).toContain(".opencode/plugins/hooknostic-runtime/mcp-servers.json");
    // OpenCode loads every module directly in .opencode/plugins/ and a
    // non-function export fails the whole module, so the launcher must not sit
    // at that level.
    expect(
      paths.filter((path) => /^\.opencode\/plugins\/[^/]+$/.test(path)),
    ).toEqual([".opencode/plugins/hooknostic-agent-plugin.js"]);
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

  // Inverted: the refusal existed because package text used to flow through the
  // module's textual substitution. It no longer does -- the declaration goes to
  // the servers document, which the module never reads -- so refusing would
  // drop a harmless package.
  it("keeps a package containing the substitution marker", async () => {
    const plan = await project(
      source({
        odd: { type: "stdio", command: "node", args: ["__HOOKNOSTIC_PLUGIN_ROOT__/x"] },
        api: {
          type: "streamable-http",
          url: "https://example.invalid/__HOOKNOSTIC_PLUGIN_ROOT__/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      }),
    );
    expect(plan.summary.omissions).toEqual([]);
    const servers = embeddedServers(plan);
    // The emitted local server carries only Hooknostic's own markers, so the
    // package's literal text cannot be rewritten...
    expect(servers["odd"]).toMatchObject({
      command: ["node", "__HOOKNOSTIC_LAUNCHER__", "0"],
    });
    // ...and it survives verbatim where the launcher reads it.
    expect(launcherDocument(plan).servers[0]!.args).toEqual(["__HOOKNOSTIC_PLUGIN_ROOT__/x"]);
    // A remote server is never walked, so its marker-bearing url is untouched.
    expect(servers["api"]).toMatchObject({
      url: "https://example.invalid/__HOOKNOSTIC_PLUGIN_ROOT__/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
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

  it("emits a server whose paths need ${PLUGIN_DATA}", async () => {
    const plan = await project(
      source({ stateful: { type: "stdio", command: "node", args: ["${PLUGIN_DATA}/state"] } }),
    );
    // The launcher creates and binds the directory, so this is no longer a
    // portable shape with no representation here.
    expect(Object.keys(embeddedServers(plan))).toEqual(["stateful"]);
    expect(plan.summary.omissions).toEqual([]);
    expect(launcherDocument(plan).servers[0]!.args).toEqual(["${PLUGIN_DATA}/state"]);
  });

  it("omits a working directory that climbs out of the directory it is anchored on", async () => {
    for (const cwd of ["${PLUGIN_ROOT}/../escape", "${PLUGIN_DATA}/../escape"]) {
      const plan = await project(source({ srv: { type: "stdio", command: "node", cwd } }));
      expect(Object.keys(embeddedServers(plan))).toEqual([]);
      expect(plan.summary.omissions).toContainEqual(
        expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "srv" }),
      );
    }
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
