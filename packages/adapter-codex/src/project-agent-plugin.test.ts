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
    ...(Object.keys(servers).length === 0 ? {} : { mcp: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: servers } }),
    files: [file("plugin.json"), file("mcp.json"), file("src/server.mjs")],
    contentDigest: "sha256:source",
  };
}

const target = { id: "codex", version: ">=0.153 <1", delivery: "package" as const, output: "dist" };
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
