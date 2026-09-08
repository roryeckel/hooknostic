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

const target = { id: "codex", version: ">=0.153 <1", mode: "plugin" as const, output: "dist" };
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
      args: ["./src/server.mjs", "--flag"],
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
      // `command` is left alone: the specification excludes it from expansion,
      // so `./bin/serve` means "relative to cwd" both portably and here.
      command: "./bin/serve",
      args: ["../src/server.mjs"],
      cwd: "worker",
    });
  });

  it("expands every occurrence, in arguments and environment values alike", async () => {
    const plan = await project(
      source({
        srv: {
          type: "stdio",
          command: "node",
          args: ["--config=${PLUGIN_ROOT}/c.json", "${PLUGIN_ROOT}/s.mjs"],
          env: { CONFIG: "${PLUGIN_ROOT}/c.json", PLAIN: "literal" },
        },
      }),
    );
    // An embedded placeholder is as valid as a leading one, and `env` values
    // are expanded while `env` keys and unrecognized text are not.
    expect(nativeMcp(plan)["srv"]).toEqual({
      command: "node",
      args: ["--config=./c.json", "./s.mjs"],
      env: { CONFIG: "./c.json", PLAIN: "literal" },
      cwd: ".",
    });
  });

  it("normalizes a working directory before deriving its depth", async () => {
    const plan = await project(
      source({
        srv: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/src/s.mjs"],
          // Trailing slash and a dot segment: valid, and both mean `worker`.
          cwd: "./worker/./",
        },
      }),
    );
    expect(nativeMcp(plan)["srv"]).toMatchObject({
      args: ["../src/s.mjs"],
      cwd: "worker",
    });
  });

  it("omits a working directory that climbs out of the plugin", async () => {
    const plan = await project(
      source({ srv: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/../escape" } }),
    );
    // No servers survive, so no native MCP document is written at all.
    expect(plan.files.some((candidate) => candidate.path === ".mcp.json")).toBe(false);
    expect(plan.summary.omissions).toContainEqual(
      expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "srv" }),
    );
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
      directories: [
        "skills",
        "skills/review",
        "skills/review-notes",
        "skills/audit",
        "skills/audit-draft",
      ],
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
