import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginFile,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginProjectionPlan,
  loadAgentPlugin,
} from "@hooknostic/agent-plugin";
import type { McpLauncherDocument } from "@hooknostic/core";
import {
  diagnosticsFromAgentPluginIssues,
  resolveAgentPluginProjection,
  validateGeneratedArtifacts,
} from "@hooknostic/core";

import { CODEX_AGENT_PLUGIN_NAMESPACE, codexAgentPluginProjector } from "./project-agent-plugin.js";

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
    ...(Object.keys(servers).length === 0 ? {} : { mcp: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: servers } }),
    files: [file("plugin.json"), file("mcp.json"), file("src/server.mjs")],
    contentDigest: "sha256:source",
  };
}

const target = { id: "codex", version: ">=0.153 <1", delivery: "package" as const, output: "dist" };
// Resolved from the projector's own profiles rather than restated, so these
// tests cannot disagree with the matrix the build reports.
const support = resolveAgentPluginProjection(target, codexAgentPluginProjector).matrix!;

const project = (pkg: AgentPluginPackage, hookArtifacts: { path: string; contents: string }[] = []) =>
  codexAgentPluginProjector.project(pkg, {
    target,
    hookArtifacts,
    support,
    onUnsupported: "error",
  });

function nativeMcp(plan: AgentPluginProjectionPlan): Record<string, Record<string, unknown>> {
  const artifact = plan.files.find((candidate) => candidate.path === ".mcp.json")!;
  const text = typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
  return (JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
}

function launcherDocument(plan: AgentPluginProjectionPlan): McpLauncherDocument {
  const artifact = plan.files.find((candidate) => candidate.path === "runtime/mcp-servers.json")!;
  const text = typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
  return JSON.parse(text) as McpLauncherDocument;
}

function manifestOf(plan: AgentPluginProjectionPlan): Record<string, unknown> {
  const artifact = plan.files.find((candidate) => candidate.path === ".codex-plugin/plugin.json")!;
  const text = typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("Agent Plugin to Codex projection", () => {
  describe("skill text (ADR-0028)", () => {
    const withSkill = (body: string): AgentPluginPackage => ({
      ...source(),
      skills: [
        { name: "status", description: "Status", directory: "skills/status", manifestPath: "skills/status/SKILL.md" },
      ],
      files: [
        ...source().files,
        {
          path: "skills/status/SKILL.md",
          contents: encoder.encode(`---\nname: status\ndescription: Status\n---\n${body}`),
          mode: 0o644,
        },
      ],
    });
    const text = (plan: AgentPluginProjectionPlan) => {
      const contents = plan.files.find((candidate) => candidate.path === "skills/status/SKILL.md")!.contents;
      return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
    };

    it("writes `.` for ${SKILL_DIR}, a path Codex's models resolve against the skill's directory", async () => {
      const plan = await project(withSkill('Run `node "${SKILL_DIR}/scripts/status.mjs"`.\n'));
      expect(text(plan)).toBe('---\nname: status\ndescription: Status\n---\nRun `node "./scripts/status.mjs"`.\n');
      expect(plan.summary.copiedPaths).not.toContain("skills/status/SKILL.md");
      expect(plan.summary.degradations).toBeUndefined();
    });

    it("reports a Claude Code variable Codex shows as written", async () => {
      const plan = await project(withSkill('Run "${CLAUDE_PLUGIN_ROOT}/x" and "${CLAUDE_SKILL_DIR}/y".\n'));
      expect(text(plan)).toContain("${CLAUDE_PLUGIN_ROOT}/x");
      expect(plan.summary.copiedPaths).toContain("skills/status/SKILL.md");
      expect(plan.summary.degradations).toEqual([
        {
          id: "skill-reference-unexpanded",
          component: "agent-plugin.skills",
          name: "status",
          path: "skills/status/SKILL.md",
          reason:
            'skill "status" contains "${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_SKILL_DIR}", which Codex shows the model as written.',
        },
      ]);
      expect(support["agent-plugin.skills"]?.degradations?.map((item) => item.id)).toEqual([
        "skill-reference-unexpanded",
      ]);
    });
  });

  // The native route expands no Agent Plugins placeholder and binds neither
  // variable, but it does join a declared `cwd` to the plugin root and honour it
  // at spawn (.capture/codex-native-mcp). So every server registers the same way
  // and the launcher supplies the contract; the portable text moves into the
  // generated document unexpanded, for the launcher to resolve at spawn time.
  it("registers every stdio server through the launcher, portable text intact", async () => {
    const plan = await project(
      source({
        srv: {
          type: "stdio",
          command: "./bin/serve",
          args: ["${PLUGIN_ROOT}/src/server.mjs", "${PLUGIN_DATA}/state", "--flag"],
          env: { CONFIG: "${PLUGIN_ROOT}/c.json", PLAIN: "literal" },
          cwd: "${PLUGIN_ROOT}/worker",
        },
      }),
    );
    expect(nativeMcp(plan)["srv"]).toEqual({
      command: "node",
      args: ["./runtime/mcp-launcher.mjs", "0"],
      cwd: ".",
    });
    expect(launcherDocument(plan)).toEqual({
      plugin: "portable-tools",
      servers: [
        {
          name: "srv",
          command: "./bin/serve",
          args: ["${PLUGIN_ROOT}/src/server.mjs", "${PLUGIN_DATA}/state", "--flag"],
          env: { CONFIG: "${PLUGIN_ROOT}/c.json", PLAIN: "literal" },
          cwd: "${PLUGIN_ROOT}/worker",
        },
      ],
    });
    expect(plan.files.some((candidate) => candidate.path === "runtime/mcp-launcher.mjs")).toBe(true);
  });

  it("carries a runner command through untouched, whatever language it launches", async () => {
    // The dominant real-world shape: of 24 stdio servers configured on one
    // developer machine, every third-party one was a runner (`npx`, `bun`,
    // `uvx`, `docker`, `php`) rather than an interpreter plus a bundled entry.
    const plan = await project(
      source({
        python: { type: "stdio", command: "uvx", args: ["mcp-server-git", "--repository", "${PLUGIN_ROOT}"] },
        container: { type: "stdio", command: "docker", args: ["run", "-i", "--rm", "example/mcp"] },
      }),
    );

    const servers = launcherDocument(plan).servers;
    expect(servers.map((server) => server.command)).toEqual(["uvx", "docker"]);
    // The argument keeps its placeholder: the launcher expands it at spawn, and
    // rewriting it here would bake in the build machine's path.
    expect(servers[0]?.args).toEqual(["mcp-server-git", "--repository", "${PLUGIN_ROOT}"]);
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("omits a working directory that climbs out of the directory it is anchored on", async () => {
    for (const cwd of ["${PLUGIN_ROOT}/../escape", "${PLUGIN_DATA}/../escape"]) {
      const plan = await project(source({ srv: { type: "stdio", command: "node", cwd } }));
      // No server survives, so neither the native document nor the launcher is
      // written at all.
      expect(plan.files.some((candidate) => candidate.path === ".mcp.json")).toBe(false);
      expect(plan.files.some((candidate) => candidate.path === "runtime/mcp-launcher.mjs")).toBe(false);
      expect(plan.summary.omissions).toContainEqual(
        expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "srv" }),
      );
      expect(diagnosticsFromAgentPluginIssues(plan.issues, "codex")).toContainEqual(
        expect.objectContaining({ code: "HN205", component: "agent-plugin.mcp.stdio" }),
      );
    }
  });

  it("emits a server whose paths need ${PLUGIN_DATA}", async () => {
    const plan = await project(
      source({
        stateful: { type: "stdio", command: "node", args: ["${PLUGIN_DATA}/state.json"] },
        plain: { type: "stdio", command: "node" },
      }),
    );
    // The launcher creates and binds the directory, so this is no longer a
    // portable shape with no representation here.
    expect(Object.keys(nativeMcp(plan))).toEqual(["stateful", "plain"]);
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
    expect(plan.summary.omissions).toEqual([]);
    expect(plan.issues).toEqual([]);
  });

  it("forwards only the environment names declared for each server", async () => {
    const plan = await codexAgentPluginProjector.project(
      source({
        credentialed: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/src/server.mjs"] },
        plain: { type: "stdio", command: "node" },
      }),
      {
        target,
        hookArtifacts: [],
        support,
        onUnsupported: "error",
        mcpEnvironment: { credentialed: ["SERVICE_USER", "SERVICE_API_KEY", "SERVICE_USER"] },
      },
    );
    // Sorted and deduplicated, so a reordered declaration is not a diff.
    expect(nativeMcp(plan)["credentialed"]).toEqual({
      command: "node",
      args: ["./runtime/mcp-launcher.mjs", "0"],
      cwd: ".",
      env_vars: ["SERVICE_API_KEY", "SERVICE_USER"],
    });
    // A server nobody declared for forwards nothing rather than everything.
    expect(nativeMcp(plan)["plain"]).not.toHaveProperty("env_vars");
    // The declaration never reaches the package: it is build input, not payload.
    expect(launcherDocument(plan).servers[0]).not.toHaveProperty("env_vars");
    expect(plan.issues).toEqual([]);
  });

  it("emits no env_vars when nothing is declared", async () => {
    const plan = await project(source({ srv: { type: "stdio", command: "node" } }));
    expect(nativeMcp(plan)["srv"]).not.toHaveProperty("env_vars");
  });

  it("rejects package content at either generated launcher path", async () => {
    for (const path of ["runtime/mcp-launcher.mjs", "runtime/mcp-servers.json"]) {
      const pkg = source({ srv: { type: "stdio", command: "node" } });
      pkg.files = [...pkg.files, file(path)];
      const plan = await project(pkg);
      expect(plan.issues).toContainEqual(
        expect.objectContaining({ severity: "error", message: expect.stringContaining("collides") }),
      );
    }
  });

  // The failure this pins is silent and cross-wired: the loader drops invalid
  // servers before a projector sees them, so a package that built with a
  // warning has positions its own mcp.json does not share. Indexing through any
  // second enumeration launches one server under another's declaration, and
  // `codex mcp get` shows the two as identical.
  it("indexes past a server the loader rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-codex-load-"));
    try {
      await writeFile(
        join(dir, "plugin.json"),
        JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "loaded", version: "1.0.0" }),
      );
      await writeFile(
        join(dir, "mcp.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: {
            alpha: { type: "stdio", command: "node", args: ["alpha"] },
            // Rejected by the loader: a plugin-relative command written without
            // its "./" prefix. An ordinary mistake, and only a warning -- so
            // the build ships with a gap in the servers the projector sees.
            broken: { type: "stdio", command: "bin/serve" },
            gamma: { type: "stdio", command: "node", args: ["gamma"] },
          },
        }),
      );
      const loaded = await loadAgentPlugin({ root: dir });
      expect(loaded.issues.some((issue) => issue.severity === "warn")).toBe(true);
      expect(Object.keys(loaded.package!.mcp!.mcpServers)).toEqual(["alpha", "gamma"]);

      const plan = await project(loaded.package!);
      const document = launcherDocument(plan);
      expect(document.servers.map((entry) => entry.name)).toEqual(["alpha", "gamma"]);
      // 1, not 2: the rejected server occupies a position in mcp.json and none
      // in the generated document.
      expect(nativeMcp(plan)["gamma"]!["args"]).toEqual(["./runtime/mcp-launcher.mjs", "1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("indexes the generated document, not the source document", async () => {
    const plan = await project(
      source({
        first: { type: "stdio", command: "node", args: ["one"] },
        streamed: { type: "streamable-http", url: "https://example.invalid/mcp" },
        dropped: { type: "sse", url: "https://example.invalid/sse" },
        escaping: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/../out" },
        "2": { type: "stdio", command: "node", args: ["integer-like"] },
        ["__proto__"]: { type: "stdio", command: "node", args: ["proto"] },
      } as Record<string, AgentPluginMcpServer>),
    );
    const document = launcherDocument(plan);
    // Survivors only, contiguous, in emission order. An integer-like key sorts
    // first in JavaScript object order, which is exactly why a position in the
    // source document is not a position here.
    expect(document.servers.map((entry) => entry.name)).toEqual(["2", "first", "__proto__"]);
    for (const [index, entry] of document.servers.entries()) {
      expect(nativeMcp(plan)[entry.name]!["args"]).toEqual(["./runtime/mcp-launcher.mjs", String(index)]);
    }
  });

  it("keeps a server whose name would collide with Object.prototype", async () => {
    const plan = await project(
      source({ ["__proto__"]: { type: "stdio", command: "node" } } as Record<string, AgentPluginMcpServer>),
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

  // The same refusal generation makes, repeated here because a package with no
  // `entry` never reaches generation: without it a native plugin lands on disk
  // for versions where plugin hook delivery is unestablished.
  it("refuses a target admitting versions outside the plugin-hooks range", async () => {
    const outOfRange = { ...target, version: ">=0.148 <1" };
    const plan = await codexAgentPluginProjector.project(source(), {
      target: outOfRange,
      hookArtifacts: [],
      support: resolveAgentPluginProjection(outOfRange, codexAgentPluginProjector).matrix!,
      // The declining profile marks every component unsupported, which this
      // policy reduces to a warning -- so the refusal cannot ride on it.
      onUnsupported: "warn",
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: "projection",
        message: expect.stringContaining(">=0.153 <1"),
      }),
    );
    // A fatal projection diagnostic is what fails the target in core, so the
    // plan's files never reach staging however complete they look.
    expect(diagnosticsFromAgentPluginIssues(plan.issues, "codex")).toContainEqual(
      expect.objectContaining({ code: "HN503", severity: "error" }),
    );
  });

  // Under onInvalid: "warn" the loader reports an invalid skill and continues,
  // leaving it out of `skills` while its files stay in `files` -- and the
  // native manifest points Codex at the whole `skills/` tree.
  it("drops a skill the loader rejected instead of shipping it for discovery", async () => {
    const base = source();
    const plan = await project({
      ...base,
      // `review` and `audit-draft` were rejected, and each shares a prefix with
      // an accepted directory -- in both directions, since prefix matching gets
      // one of them wrong whichever way it is written.
      skills: [
        {
          name: "review-notes",
          description: "kept",
          directory: "skills/review-notes",
          manifestPath: "skills/review-notes/SKILL.md",
        },
        {
          name: "audit",
          description: "kept",
          directory: "skills/audit",
          manifestPath: "skills/audit/SKILL.md",
        },
      ],
      files: [
        ...base.files,
        file("skills/README.md"),
        file("skills/review/SKILL.md"),
        file("skills/review/reference.md"),
        file("skills/review-notes/SKILL.md"),
        file("skills/audit/SKILL.md"),
        file("skills/audit-draft/SKILL.md"),
      ],
      directories: ["skills", "skills/review", "skills/review-notes", "skills/audit", "skills/audit-draft"],
    });
    const paths = plan.files.map((artifact) => artifact.path);
    expect(paths).not.toContain("skills/review/SKILL.md");
    expect(paths).not.toContain("skills/review/reference.md");
    expect(paths).not.toContain("skills/audit-draft/SKILL.md");
    expect(plan.summary.copiedPaths).not.toContain("skills/review/SKILL.md");
    expect(paths).toContain("skills/review-notes/SKILL.md");
    expect(paths).toContain("skills/audit/SKILL.md");
    // Neither file is inside a skill directory, so neither is affected.
    expect(paths).toContain("skills/README.md");
    expect(paths).toContain("src/server.mjs");
    // Otherwise a rejected skill survives as an empty directory of its name.
    expect(plan.directories).toEqual(["skills", "skills/review-notes", "skills/audit"]);
    // Already counted from `source.skills`, so the summary was never wrong.
    expect(plan.summary.components["agent-plugin.skills"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
    expect(manifestOf(plan)["skills"]).toBe("./skills/");
  });
});

describe("Codex client extension", () => {
  const withFiles = (pkg: AgentPluginPackage, extra: AgentPluginFile[]): AgentPluginPackage => ({
    ...pkg,
    files: [...pkg.files, ...extra],
  });
  const overlay = (path: string, contents: string): AgentPluginFile => ({
    path,
    contents: encoder.encode(contents),
    mode: 0o644,
  });
  // The merge uses the constant, but component DISCOVERY uses the declared
  // namespace: blank it and the projection still works while the capability
  // matrix silently stops mentioning the component.
  it("declares the namespace authors write in their manifest", () => {
    expect(codexAgentPluginProjector.namespace).toBe(CODEX_AGENT_PLUGIN_NAMESPACE);
    // Vendor-defined and load-bearing: it is the key in extensions{}.
    expect(CODEX_AGENT_PLUGIN_NAMESPACE).toBe("com.openai");
  });

  // This projector removes the portable root manifest because it would outrank
  // the native manifest that carries Hooknostic hooks. Carrying the documented
  // OpenAI object into that native replacement preserves the same settings.
  it("folds extensions[com.openai] into the native manifest", async () => {
    const plan = await project(
      source(
        {},
        {
          extensions: {
            "com.openai": {
              interface: { displayName: "Portable Tools", brandColor: "#1ABCFE" },
            },
          },
        },
      ),
    );

    expect(manifestOf(plan).interface).toEqual({ displayName: "Portable Tools", brandColor: "#1ABCFE" });
  });

  it("never lets a client extension rewrite the package's identity", async () => {
    const plan = await project(
      source({}, { extensions: { "com.openai": { name: "impostor", version: "9.9.9", skills: "./elsewhere/" } } }),
    );

    // A renamed manifest would disagree with the marketplace entry that
    // installed it, and the version is the install cache key.
    const manifest = manifestOf(plan);
    expect(manifest.name).toBe("portable-tools");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.skills).toBeUndefined();
  });

  it("hoists a namespace file to the package root", async () => {
    const plan = await project(withFiles(source(), [file("com.openai/.app.json"), file("com.openai/assets/logo.png")]));

    const paths = plan.files.map((candidate) => candidate.path);
    expect(paths).toContain(".app.json");
    expect(paths).toContain("assets/logo.png");
    // Shipped one level down, nothing would read it.
    expect(paths.filter((path) => path.startsWith("com.openai/"))).toEqual([]);
    expect(plan.summary.copiedPaths).toContain(".app.json");
    expect(plan.summary.components["agent-plugin.client-extension.files"]).toEqual({
      discovered: 2,
      emitted: 2,
      skipped: 0,
    });
  });

  // The npm manifest names are refused for the reason the copy loop strips
  // them: hoisted to the root they stand in for a coordinate this projection
  // never publishes, and npm reads the names case-insensitively.
  it.each([
    "plugin.json",
    "mcp.json",
    ".mcp.json",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "Package.json",
    "Plugin.json",
    ".MCP.json",
  ])("refuses to hoist reserved root path %s", async (reserved) => {
    const sourcePath = `com.openai/${reserved}`;
    const plan = await project(withFiles(source(), [file(sourcePath)]));

    expect(plan.files.some((candidate) => candidate.path === reserved)).toBe(false);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.client-extension.files",
        path: sourcePath,
      }),
    );
  });

  // `.mcp.json` is only written when a server survives translation, so without
  // a reservation the empty-server case hoists an unvalidated native MCP
  // document to the root instead of colliding with a generated one.
  it("refuses to hoist onto .mcp.json even when no server is emitted", async () => {
    const plan = await project(withFiles(source(), [file("com.openai/.mcp.json")]));

    expect(plan.files.some((candidate) => candidate.path === ".mcp.json")).toBe(false);
  });

  it.each([
    ["skills/extra/SKILL.md", "skills"],
    ["runtime/mcp-launcher.mjs", "runtime"],
    // Inventoried on one filesystem, installed on others: `Skills/` is the
    // generated `skills/` tree on most of the ones Codex installs onto, and
    // core's duplicate check folds file paths, not directory prefixes.
    ["Skills/extra/SKILL.md", "skills"],
    ["Runtime/mcp-launcher.mjs", "runtime"],
  ])("refuses to hoist %s into the generated %s tree", async (reserved) => {
    const sourcePath = `com.openai/${reserved}`;
    const plan = await project(withFiles(source(), [file(sourcePath)]));

    // The manifest points Codex at `skills/`, and `runtime/` carries the
    // generated launcher; a namespace file reaching either arrives without
    // passing the portable loader that validates what goes there.
    expect(plan.files.some((candidate) => candidate.path === reserved)).toBe(false);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.client-extension.files",
        path: sourcePath,
      }),
    );
  });

  it.each(["Skills", "Runtime/vendor"])("refuses to hoist directory %s into a generated tree", async (reserved) => {
    const sourcePath = `com.openai/${reserved}`;
    const pkg = source();
    const plan = await project({ ...pkg, directories: ["com.openai", sourcePath] });

    expect(plan.directories ?? []).not.toContain(reserved);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.client-extension.files",
        path: sourcePath,
      }),
    );
  });

  it("refuses to resurrect a rejected portable skill through the namespace", async () => {
    // The portable loader saw `skills/broken` and rejected it, so the copy loop
    // skips it and the path is free. Hoisting a namespace file onto it puts a
    // skill Codex will discover back into the tree the loader refused.
    const pkg = withFiles(source(), [file("skills/broken/SKILL.md"), file("com.openai/skills/broken/SKILL.md")]);

    const plan = await project(pkg);

    expect(plan.files.some((candidate) => candidate.path === "skills/broken/SKILL.md")).toBe(false);
  });

  it("refuses to hoist a client-extension directory into the generated skills tree", async () => {
    const pkg = source();
    pkg.directories = ["com.openai", "com.openai/skills", "com.openai/skills/extra"];

    const plan = await project(pkg);

    expect(plan.directories ?? []).not.toContain("skills");
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.client-extension.files",
        path: "com.openai/skills",
      }),
    );
  });

  it("uses the inline map instead of the compatibility overlay", async () => {
    const plan = await project(
      withFiles(source({}, { extensions: { "com.openai": { interface: { displayName: "from the map" } } } }), [
        overlay(
          "com.openai/.codex-plugin/plugin.json",
          JSON.stringify({ interface: { displayName: "from the overlay" }, apps: "./.app.json" }),
        ),
      ]),
    );

    const manifest = manifestOf(plan);
    // The inline map is the documented form, so it wins where they overlap...
    expect(manifest.interface).toEqual({ displayName: "from the map" });
    // ...and replaces the overlay wholesale rather than merging with it.
    expect(manifest.apps).toBeUndefined();
    // The overlay is an input, never an emitted file at its hoisted path.
    expect(plan.files.filter((candidate) => candidate.path.includes("com.openai"))).toEqual([]);
  });

  it("counts a compatibility overlay superseded by an inline extension as skipped", async () => {
    const plan = await project(
      withFiles(source({}, { extensions: { "com.openai": { interface: { displayName: "inline" } } } }), [
        overlay("com.openai/.codex-plugin/plugin.json", JSON.stringify({ interface: { displayName: "overlay" } })),
      ]),
    );

    // The documented inline object replaces this overlay, so it is discovered
    // from the source package but must not be reported as delivered.
    expect(plan.summary.components["agent-plugin.client-extension.files"]).toEqual({
      discovered: 2,
      emitted: 1,
      skipped: 1,
    });
    // The count alone told an author who edited the overlay nothing about why
    // the edit never arrived. Every other ignored client-extension input --
    // claimed canonical keys, reserved hoists -- is reported; so is this one.
    const warning = plan.issues.find((candidate) => candidate.path === "com.openai/.codex-plugin/plugin.json");
    expect(warning?.severity).toBe("warn");
    expect(warning?.scope).toBe("projection");
    expect(warning?.component).toBe("agent-plugin.client-extension.files");
    expect(warning?.message).toContain("plugin.json#/extensions/com.openai");
    expect(warning?.message).toContain("ignored");
  });

  it("hoists empty client-extension directories with their namespace", async () => {
    const pkg = source();
    pkg.directories = ["com.openai", "com.openai/assets", "empty"];

    const plan = await project(pkg);

    // `com.openai` is the portable namespace, not part of the generated
    // package layout; an extension setting referring to ./assets needs the
    // empty directory at that root-relative location.
    expect(plan.directories).toEqual(["assets", "empty"]);
  });

  it("refuses an empty client-extension directory that hoists onto a file", async () => {
    const pkg = source();
    pkg.files = [...pkg.files, file("assets")];
    pkg.directories = ["com.openai", "com.openai/assets"];

    const plan = await project(pkg);

    // Staging creates directories before files, so emitting both would fail
    // with EISDIR instead of reporting the conflicting source paths.
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.client-extension.files",
        path: "com.openai/assets",
      }),
    );
  });

  it("refuses a client-extension directory that hoists onto a case-only file match", async () => {
    const pkg = source();
    pkg.files = [...pkg.files, file("assets")];
    // These paths can coexist in the portable package, but become the same
    // output path on a case-insensitive filesystem once the namespace lifts.
    pkg.directories = ["com.openai", "com.openai/Assets"];

    const plan = await project(pkg);

    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.client-extension.files",
        path: "com.openai/Assets",
      }),
    );
  });

  it("merges a client-extension directory with a case-only root directory", async () => {
    const pkg = source();
    pkg.files = [...pkg.files, file("assets/root.png"), file("com.openai/Assets/extension.png")];
    pkg.directories = ["assets", "com.openai", "com.openai/Assets"];

    const plan = await project(pkg);

    expect(plan.directories).toEqual(["assets"]);
    expect(plan.files.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining(["assets/root.png", "Assets/extension.png"]),
    );
    expect(plan.issues).toEqual([]);
  });

  it("merges a client-extension directory with an exact root directory", async () => {
    const pkg = source();
    pkg.files = [...pkg.files, file("assets/root.png"), file("com.openai/assets/extension.png")];
    pkg.directories = ["assets", "com.openai", "com.openai/assets"];

    const plan = await project(pkg);

    expect(plan.directories).toEqual(["assets"]);
    expect(plan.files.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining(["assets/root.png", "assets/extension.png"]),
    );
    expect(plan.issues).toEqual([]);
  });

  it("prefers the package's own directory spelling whichever is listed first", async () => {
    const pkg = source();
    pkg.files = [...pkg.files, file("assets/root.png"), file("com.openai/Assets/extension.png")];
    // The inventory lists the namespace spelling first. On a case-sensitive
    // filesystem the retained spelling is the directory that gets created, and
    // `assets/root.png` needs `assets`, not `Assets`.
    pkg.directories = ["com.openai", "com.openai/Assets", "assets"];

    const plan = await project(pkg);

    expect(plan.directories).toEqual(["assets"]);
    expect(plan.issues).toEqual([]);
  });

  it("refuses a client-extension directory that hoists inside a file", async () => {
    const pkg = source();
    pkg.files = [...pkg.files, file("assets")];
    pkg.directories = ["com.openai", "com.openai/assets/cache"];

    const plan = await project(pkg);

    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.client-extension.files",
        path: "com.openai/assets/cache",
      }),
    );
  });

  it("names the occupying file in its own spelling", async () => {
    const pkg = source();
    pkg.files = [...pkg.files, file("Assets")];
    pkg.directories = ["com.openai", "com.openai/assets/cache"];

    const plan = await project(pkg);

    // The comparison folds case; the message should still point at the file
    // the author can find in their package.
    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/assets/cache");
    expect(issue?.message).toContain('"Assets"');
  });

  it("uses the compatibility overlay when the inline map is absent", async () => {
    const plan = await project(
      withFiles(source(), [
        overlay(
          "com.openai/.codex-plugin/plugin.json",
          JSON.stringify({ interface: { displayName: "from the overlay" }, apps: "./.app.json" }),
        ),
      ]),
    );

    expect(manifestOf(plan)).toMatchObject({
      interface: { displayName: "from the overlay" },
      apps: "./.app.json",
    });
  });

  it("recognises the compatibility overlay whatever case the package spelled it in", async () => {
    const plan = await project(
      withFiles(source(), [
        overlay("com.openai/.Codex-Plugin/Plugin.json", JSON.stringify({ interface: { displayName: "folded" } })),
      ]),
    );

    // Every other collision check here folds case, because the package is
    // inventoried on one filesystem and installed on others. An exact match
    // hoisted this as a plain file instead, and the build then failed in core
    // on a case-insensitive duplicate that named the generated manifest -- a
    // path the author never wrote.
    expect(plan.issues).toEqual([]);
    expect(manifestOf(plan).interface).toEqual({ displayName: "folded" });
    expect(plan.files.filter((candidate) => candidate.path.toLowerCase() === ".codex-plugin/plugin.json")).toHaveLength(
      1,
    );
  });

  it("refuses a case-only spelling of the manifest path this projection generates", async () => {
    const plan = await project(withFiles(source(), [file(".Codex-Plugin/plugin.json")]));

    const issue = plan.issues.find((candidate) => candidate.path === ".Codex-Plugin/plugin.json");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("com.openai/.Codex-Plugin/plugin.json");
    expect(plan.files.some((candidate) => candidate.path === ".Codex-Plugin/plugin.json")).toBe(false);
  });

  it("refuses a package that ships the manifest path this projection generates", async () => {
    const plan = await project(withFiles(source(), [file(".codex-plugin/plugin.json")]));

    // Always generated, so a copied one is guaranteed to be lost. Silently,
    // until this check.
    const issue = plan.issues.find((candidate) => candidate.path === ".codex-plugin/plugin.json");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("com.openai/.codex-plugin/plugin.json");
    expect(diagnosticsFromAgentPluginIssues([issue!])[0]?.code).toBe("HN503");
  });

  // The output half of the package boundary, on the door the hoist checks do
  // not cover. `RESERVED_HOISTED_ROOT_PATHS` refuses a hoisted
  // `com.openai/.mcp.json` because a document arriving at a path Codex reads
  // without passing the portable loader is dangerous whether or not this build
  // generates one there -- and the package root is the same document arriving
  // by the shorter route.
  it.each([".mcp.json", ".MCP.json", ".codex-plugin/other.json", ".Codex-Plugin/other.json"])(
    "refuses a package that ships the native read path %s",
    async (reserved) => {
      const plan = await project(withFiles(source(), [file(reserved)]));

      expect(plan.files.some((candidate) => candidate.path === reserved)).toBe(false);
      expect(plan.summary.copiedPaths).not.toContain(reserved);
      const issue = plan.issues.find((candidate) => candidate.path === reserved);
      expect(issue?.severity).toBe("error");
      expect(diagnosticsFromAgentPluginIssues([issue!])[0]?.code).toBe("HN503");
    },
  );

  it("emits one .mcp.json when the package ships its own beside a server that generates it", async () => {
    const plan = await project(
      withFiles(source({ streamed: { type: "streamable-http", url: "https://example.invalid/mcp" } }), [
        file(".mcp.json"),
      ]),
    );

    // Copied and then generated, the path was emitted twice and the build
    // failed in core on a duplicate artifact path blamed on this adapter --
    // which is the diagnostic the launcher and hook collision checks exist to
    // avoid. Refused here, the surviving document is the generated one.
    expect(plan.files.filter((candidate) => candidate.path === ".mcp.json")).toHaveLength(1);
    expect(nativeMcp(plan)["streamed"]).toEqual({ url: "https://example.invalid/mcp" });
    expect(plan.issues.find((candidate) => candidate.path === ".mcp.json")?.severity).toBe("error");
  });

  it("refuses a hoisted file that lands on package content", async () => {
    const plan = await project(withFiles(source(), [file("com.openai/src/server.mjs")]));

    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/src/server.mjs");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("already ships");
  });

  it("refuses a hoisted file that lands on a case-only match of package content", async () => {
    const plan = await project(withFiles(source(), [file("com.openai/src/Server.mjs")]));

    // Both paths exist in the portable package; on the filesystems Codex
    // installs onto they are one file, and the directory check already folds
    // case. Without this the collision surfaced later as core's generic
    // duplicate, with no mention of the namespace source.
    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/src/Server.mjs");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain('"src/server.mjs"');
    expect(plan.files.some((candidate) => candidate.path === "src/Server.mjs")).toBe(false);
  });

  it("refuses a malformed overlay manifest rather than guessing at it", async () => {
    const plan = await project(withFiles(source(), [overlay("com.openai/.codex-plugin/plugin.json", "{ not json")]));

    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/.codex-plugin/plugin.json");
    expect(issue?.severity).toBe("error");
  });

  it("ignores a malformed compatibility overlay when the inline map replaces it", async () => {
    const plan = await project(
      withFiles(source({}, { extensions: { "com.openai": { interface: { displayName: "inline" } } } }), [
        overlay("com.openai/.codex-plugin/plugin.json", "{ not json"),
      ]),
    );

    // Not parsed, so not reported as malformed; but not silent either.
    expect(plan.issues).toEqual([
      expect.objectContaining({ severity: "warn", path: "com.openai/.codex-plugin/plugin.json" }),
    ]);
    expect(manifestOf(plan).interface).toEqual({ displayName: "inline" });
  });

  it("preserves documented inline hooks when no Hooknostic hook artifact exists", async () => {
    const plan = await project(source({}, { extensions: { "com.openai": { hooks: "./hooks/author.json" } } }));

    expect(manifestOf(plan).hooks).toBe("./hooks/author.json");
  });

  it("combines documented inline hooks with the generated Hooknostic hook document", async () => {
    const plan = await project(
      source({}, { extensions: { "com.openai": { hooks: ["./hooks/first.json", "./hooks/second.json"] } } }),
      [{ path: "hooks.json", contents: '{"hooks":{}}\n' }],
    );

    expect(manifestOf(plan).hooks).toEqual(["./hooks/first.json", "./hooks/second.json", "./hooks.json"]);
  });

  it("does not list the generated hook document twice when the author already names it", async () => {
    // The vendor documentation's own example is `hooks: "./hooks.json"`, which
    // is exactly the document this projection generates. Appended blindly the
    // manifest read ["./hooks.json", "./hooks.json"], and a path array runs
    // every entry (`.capture/codex-client-extension`), so every generated hook
    // fired twice.
    const single = await project(source({}, { extensions: { "com.openai": { hooks: "./hooks.json" } } }), [
      { path: "hooks.json", contents: '{"hooks":{}}\n' },
    ]);
    expect(manifestOf(single).hooks).toBe("./hooks.json");

    const array = await project(
      source({}, { extensions: { "com.openai": { hooks: ["./hooks/first.json", "hooks.json", "./Hooks.json"] } } }),
      [{ path: "hooks.json", contents: '{"hooks":{}}\n' }],
    );
    // The author's spelling is replaced by the one the projection emits: the
    // two resolve to the same file on the filesystems Codex installs onto,
    // and only the emitted spelling is a captured form.
    expect(manifestOf(array).hooks).toEqual(["./hooks/first.json", "./hooks.json"]);
  });

  it("keeps an inline hook object array homogeneous when adding generated hooks", async () => {
    const authored = { hooks: { SessionStart: [] } };
    const generated = { hooks: { PreToolUse: [] } };
    const plan = await project(source({}, { extensions: { "com.openai": { hooks: authored } } }), [
      { path: "hooks.json", contents: `${JSON.stringify(generated)}\n` },
    ]);

    expect(manifestOf(plan).hooks).toEqual([authored, generated]);
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["a mixed path/object array", ["./hooks/author.json", { hooks: {} }]],
    ["an array holding null", [null]],
  ])("refuses a client extension hooks declaration that is %s", async (_label, authored) => {
    // Codex ran a path, a path array, an object and an object array
    // (`.capture/codex-client-extension`); nothing else is captured, and
    // composing with it would ship a manifest whose `hooks` field is invalid
    // -- dropping the generated document along with it, silently.
    const plan = await project(source({}, { extensions: { "com.openai": { hooks: authored } } }), [
      { path: "hooks.json", contents: '{"hooks":{}}\n' },
    ]);

    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: "manifest",
        path: "plugin.json#/extensions/com.openai/hooks",
      }),
    );
    expect(manifestOf(plan).hooks).toBe("./hooks.json");
  });

  it("refuses an invalid client extension hooks declaration even with no generated hooks", async () => {
    const plan = await project(source({}, { extensions: { "com.openai": { hooks: null } } }));

    expect(plan.issues).toContainEqual(
      expect.objectContaining({ severity: "error", path: "plugin.json#/extensions/com.openai/hooks" }),
    );
    expect(manifestOf(plan)).not.toHaveProperty("hooks");
  });

  it("reports rather than throws when the generated hook document is not JSON", async () => {
    // Inlining the document beside an authored hook object needs to parse it;
    // a compiler defect there should surface as a diagnostic against the
    // artifact, not as a rejected projection.
    const plan = await project(source({}, { extensions: { "com.openai": { hooks: { hooks: {} } } } }), [
      { path: "hooks.json", contents: "{ not json" },
    ]);

    const issue = plan.issues.find((candidate) => candidate.path === "hooks.json");
    expect(issue?.severity).toBe("error");
    expect(issue?.scope).toBe("projection");
  });

  it("points the native manifest at the generated hook document, after mcpServers", async () => {
    const plan = await project(source({ srv: { type: "stdio", command: "node" } }), [
      { path: "hooks.json", contents: '{"hooks":{}}\n' },
    ]);

    const manifest = manifestOf(plan);
    expect(manifest.hooks).toBe("./hooks.json");
    // The committed example's manifest is byte-compared in CI, so where the
    // component pointers land is part of the output, not an accident.
    const keys = Object.keys(manifest);
    expect(keys.indexOf("hooks")).toBe(keys.indexOf("mcpServers") + 1);
    expect(keys.indexOf("hooks")).toBe(keys.length - 1);
  });

  it.each(["package.json", "package-lock.json", "npm-shrinkwrap.json"])(
    "leaves the source project's %s out of the projection",
    async (path) => {
      // These describe how to build the source project, not anything Codex
      // installs. Copied verbatim they shipped `private: true` and workspace
      // protocol ranges into the plugin, and the name they carried stood in for
      // a published npm coordinate this projection never emits.
      const pkg = source({});
      const plan = await codexAgentPluginProjector.project(
        { ...pkg, files: [...pkg.files, file(path)] },
        { target, hookArtifacts: [], support, onUnsupported: "error" },
      );

      expect(plan.files.some((candidate) => candidate.path === path)).toBe(false);
      expect(plan.issues).toEqual([]);
    },
  );

  it("says out loud that a projection-owned key was ignored", async () => {
    const plan = await project(
      source({}, { extensions: { "com.openai": { skills: "./elsewhere/", interface: { displayName: "kept" } } } }),
    );

    // Dropped silently, an author would see their declaration vanish with no
    // account of why.
    const warning = plan.issues.find((candidate) => candidate.message.includes("this projection decides"));
    expect(warning?.severity).toBe("warn");
    expect(warning?.message).toContain('"skills"');
    expect(warning?.message).not.toContain('"interface"');
    expect(manifestOf(plan).interface).toEqual({ displayName: "kept" });
    // Named the generated manifest before, which is a file the author does not
    // have -- and shipping one is a hard error here.
    expect(warning?.path).toBe("plugin.json#/extensions/com.openai");
    // The package is valid; this projection made the choice. Scoping it to the
    // manifest filed it as invalid Agent Plugin input.
    expect(warning?.scope).toBe("projection");
  });

  it("names the compatibility overlay when that is where the ignored key was declared", async () => {
    const plan = await project(
      withFiles(source(), [
        overlay("com.openai/.codex-plugin/plugin.json", JSON.stringify({ skills: "./elsewhere/" })),
      ]),
    );

    const warning = plan.issues.find((candidate) => candidate.message.includes("this projection decides"));
    expect(warning?.severity).toBe("warn");
    expect(warning?.path).toBe("com.openai/.codex-plugin/plugin.json");
  });

  it("leaves a package with no extension untouched", async () => {
    const plan = await project(source());

    expect(plan.issues).toEqual([]);
    expect(manifestOf(plan)).toEqual({ name: "portable-tools", version: "1.2.3" });
  });

  it.each(["Plugin.json", "MCP.json"])(
    "strips a case-only spelling of the portable %s like the exact one",
    async (path) => {
      // Inventoried on a case-sensitive filesystem, `Plugin.json` is a stray
      // file beside the manifest; installed on the filesystems Codex runs on it
      // IS the root manifest, which outranks the native one and suppresses every
      // hook. The exact spelling was already stripped; this one was copied.
      const plan = await project(withFiles(source(), [file(path)]));

      expect(plan.files.some((candidate) => candidate.path === path)).toBe(false);
      expect(plan.issues).toEqual([]);
    },
  );

  it("refuses to hoist a sibling into Codex's metadata directory", async () => {
    // The overlay is the one file consumed from `.codex-plugin/`; anything else
    // there is a shape no capture records.
    const plan = await project(withFiles(source(), [file("com.openai/.codex-plugin/other.json")]));

    expect(plan.files.some((candidate) => candidate.path === ".codex-plugin/other.json")).toBe(false);
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.client-extension.files",
        path: "com.openai/.codex-plugin/other.json",
      }),
    );
  });

  it.each([
    ["com.openai/Hooks.json", "hooks.json"],
    ["com.openai/hooknostic/hooknostic.mjs", "hooknostic/hooknostic.mjs"],
  ])(
    "refuses %s against the generated %s, blaming the hoist rather than package content",
    async (sourcePath, generated) => {
      const hookArtifacts = [
        { path: "hooks.json", contents: '{"hooks":{}}\n' },
        { path: "hooknostic/hooknostic.mjs", contents: "// runtime\n" },
      ];
      const plan = await project(withFiles(source(), [file(sourcePath)]), hookArtifacts);

      // Neither path is in the reserved list; the collision is with what this
      // build actually emits. Before, it surfaced from the hook-artifact loop as
      // "collides with package content" -- content the author never wrote.
      const issue = plan.issues.find((candidate) => candidate.path === sourcePath);
      expect(issue?.severity).toBe("error");
      expect(issue?.component).toBe("agent-plugin.client-extension.files");
      expect(issue?.message).toContain(JSON.stringify(generated));
      expect(issue?.message).toContain("this projection generates");
      expect(plan.issues.filter((candidate) => candidate.message.includes("collides with package content"))).toEqual(
        [],
      );
      expect(plan.files.filter((candidate) => candidate.path.toLowerCase() === generated)).toEqual([
        expect.objectContaining({ path: generated }),
      ]);
      expect(manifestOf(plan).hooks).toBe("./hooks.json");
    },
  );

  it("refuses a hoisted file that lands on a directory the package ships", async () => {
    // `shippedByFoldedPath` holds files only, so this passed the projector and
    // failed in core as an artifact that "is also a directory of another
    // artifact" -- without the client-extension source path.
    const plan = await project(withFiles(source(), [file("assets/logo.png"), file("com.openai/assets")]));

    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/assets");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain('"assets"');
    expect(issue?.message).toContain("directory");
    expect(plan.files.some((candidate) => candidate.path === "assets")).toBe(false);
  });

  it("refuses a hoisted file that lands beneath a file the package ships", async () => {
    const plan = await project(withFiles(source(), [file("assets"), file("com.openai/assets/extension.png")]));

    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/assets/extension.png");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain('"assets"');
    expect(issue?.message).toContain("emitted as a file");
    expect(plan.files.some((candidate) => candidate.path === "assets/extension.png")).toBe(false);
  });

  it("refuses a second spelling of the compatibility overlay instead of taking the last one", async () => {
    const plan = await project(
      withFiles(source(), [
        overlay("com.openai/.codex-plugin/plugin.json", JSON.stringify({ interface: { displayName: "first" } })),
        overlay("com.openai/.Codex-Plugin/plugin.json", JSON.stringify({ interface: { displayName: "second" } })),
      ]),
    );

    // Both fold to the manifest path this projection generates; every other
    // hoist gets the case-collision error, and last-wins would have
    // `overlaySourcePath` blame a file whose contents were not the ones used.
    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/.Codex-Plugin/plugin.json");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain('"com.openai/.codex-plugin/plugin.json"');
    expect(manifestOf(plan).interface).toEqual({ displayName: "first" });
  });

  it("keeps two ordinary case-variant directories apart after a hoisted one took the slot", async () => {
    const pkg = source();
    pkg.directories = ["com.openai", "com.openai/Assets", "assets", "Assets"];

    const plan = await project(pkg);

    // The hoisted `Assets` is coalesced into the package's own `assets`; the
    // package's own `Assets` is a second ordinary directory and stays for
    // core's duplicate check, which the comment above the merge promises.
    expect(plan.directories).toEqual(["assets", "Assets"]);
    const diagnostics = validateGeneratedArtifacts(
      plan.files.map(({ path, contents }) => ({ path, contents })),
      { adapterId: "codex", target: "codex" },
      plan.directories ?? [],
    );
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes("duplicate directory path"))).toBe(true);
  });

  it("places a materialized package tree at the package root without calling it copied", async () => {
    const pkg = source({ srv: { type: "stdio", command: "node" } });
    const plan = await codexAgentPluginProjector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      materializedTrees: [
        {
          provider: "fixture",
          into: "generated/dependencies",
          files: [{ path: "library/data.bin", contents: encoder.encode("materialized"), mode: 0o644 }],
        },
      ],
    });

    // Codex reads from the output root, so `into` needs no prefix.
    expect(plan.files.some((candidate) => candidate.path === "generated/dependencies/library/data.bin")).toBe(true);
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    // The bytes came from an installer, not the package: the summary's
    // "copied byte-for-byte" list must not claim them.
    expect(plan.summary.copiedPaths).not.toContain("generated/dependencies/library/data.bin");
  });

  it("refuses a materialized tree that lands on a skill whose SKILL.md it rewrites", async () => {
    // Generated rather than copied (ADR-0028), but still the package's file.
    const pkg: AgentPluginPackage = {
      ...source(),
      skills: [
        { name: "status", description: "Status", directory: "skills/status", manifestPath: "skills/status/SKILL.md" },
      ],
      files: [
        ...source().files,
        {
          path: "skills/status/SKILL.md",
          contents: encoder.encode("---\nname: status\ndescription: Status\n---\nRun ${SKILL_DIR}/x.\n"),
          mode: 0o644,
        },
      ],
    };
    const plan = await codexAgentPluginProjector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      materializedTrees: [
        {
          provider: "fixture",
          into: "skills/status",
          files: [{ path: "SKILL.md", contents: encoder.encode("x"), mode: 0o644 }],
        },
      ],
    });
    expect(plan.issues).toContainEqual(expect.objectContaining({ severity: "error", path: "skills/status/SKILL.md" }));
  });

  it("refuses a materialized package tree that lands on generated output", async () => {
    // `into: "runtime"` is where the generated launcher goes, so the tree
    // would silently replace a file this projection emits.
    const pkg = source({ srv: { type: "stdio", command: "node" } });
    const plan = await codexAgentPluginProjector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      materializedTrees: [
        {
          provider: "fixture",
          into: "runtime",
          files: [{ path: "mcp-launcher.mjs", contents: encoder.encode("not the launcher"), mode: 0o644 }],
        },
      ],
    });

    const issue = plan.issues.find((candidate) => candidate.path === "runtime/mcp-launcher.mjs");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("already carries");
    // The generated launcher still wins: the plan the build writes keeps the
    // bytes this projection emitted, not the ones the materializer brought.
    const launcher = plan.files.find((candidate) => candidate.path === "runtime/mcp-launcher.mjs")!;
    expect(launcher.contents.toString()).not.toBe("not the launcher");
  });

  it("refuses a namespace hoist that lands on materialized package output", async () => {
    // `vendor/` is not one of the reserved trees, so this is not caught by that
    // policy: without the materialized tree joining `generatedByFoldedPath`
    // before the hoist loop, the namespace file would win and the materialized bytes
    // would be silently replaced.
    const pkg = withFiles(source(), [overlay("com.openai/generated/shared/data.bin", "replacement")]);
    const plan = await codexAgentPluginProjector.project(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      materializedTrees: [
        {
          provider: "fixture",
          into: "generated/shared",
          files: [{ path: "data.bin", contents: encoder.encode("materialized"), mode: 0o644 }],
        },
      ],
    });

    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/generated/shared/data.bin");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("which this projection generates");
    expect(plan.files.some((candidate) => candidate.path === "generated/shared/data.bin")).toBe(true);
  });
});
