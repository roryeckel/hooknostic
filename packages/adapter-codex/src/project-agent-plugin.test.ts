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
import { diagnosticsFromAgentPluginIssues, resolveAgentPluginProjection } from "@hooknostic/core";

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

  it.each(["plugin.json", "mcp.json"])("refuses to hoist reserved root path %s", async (reserved) => {
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

  it("refuses a package that ships the manifest path this projection generates", async () => {
    const plan = await project(withFiles(source(), [file(".codex-plugin/plugin.json")]));

    // Always generated, so a copied one is guaranteed to be lost. Silently,
    // until this check.
    const issue = plan.issues.find((candidate) => candidate.path === ".codex-plugin/plugin.json");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("com.openai/.codex-plugin/plugin.json");
    expect(diagnosticsFromAgentPluginIssues([issue!])[0]?.code).toBe("HN503");
  });

  it("refuses a hoisted file that lands on package content", async () => {
    const plan = await project(withFiles(source(), [file("com.openai/src/server.mjs")]));

    const issue = plan.issues.find((candidate) => candidate.path === "com.openai/src/server.mjs");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("already ships");
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

    expect(plan.issues).toEqual([]);
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

  it("keeps an inline hook object array homogeneous when adding generated hooks", async () => {
    const authored = { hooks: { SessionStart: [] } };
    const generated = { hooks: { PreToolUse: [] } };
    const plan = await project(source({}, { extensions: { "com.openai": { hooks: authored } } }), [
      { path: "hooks.json", contents: `${JSON.stringify(generated)}\n` },
    ]);

    expect(manifestOf(plan).hooks).toEqual([authored, generated]);
  });

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
  });

  it("leaves a package with no extension untouched", async () => {
    const plan = await project(source());

    expect(plan.issues).toEqual([]);
    expect(manifestOf(plan)).toEqual({ name: "portable-tools", version: "1.2.3" });
  });
});
