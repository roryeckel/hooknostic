import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginFile,
  type AgentPluginPackage,
} from "@hooknostic/agent-plugin";
import { diagnosticsFromAgentPluginIssues } from "@hooknostic/core";
import { projectAgentPluginToClaude } from "./project-agent-plugin.js";

const encoder = new TextEncoder();
const file = (path: string, contents: string | Uint8Array, mode = 0o644): AgentPluginFile => ({
  path,
  contents: typeof contents === "string" ? encoder.encode(contents) : contents,
  mode,
});

function source(files: AgentPluginFile[] = []): AgentPluginPackage {
  return {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: {
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
      name: "portable-tools",
      version: "1.2.3",
      description: "portable description",
      license: "MIT",
    },
    skills: [{ name: "review", description: "Review code", directory: "skills/review", manifestPath: "skills/review/SKILL.md" }],
    mcp: {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: { type: "stdio", command: "./bin/server", args: ["${PLUGIN_ROOT}/x", "${PLUGIN_DATA}/y"] },
        remote: { type: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer literal" } },
      },
    },
    files: [file("plugin.json", "{}"), file("skills/review/SKILL.md", "skill"), ...files],
    contentDigest: "sha256:source",
  };
}

const target = { id: "claude", version: ">=2.1 <3", mode: "plugin" as const, output: "dist" };

function parsed(plan: Awaited<ReturnType<typeof projectAgentPluginToClaude>>, path: string) {
  const artifact = plan.files.find((candidate) => candidate.path === path)!;
  return JSON.parse(typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents));
}

describe("Agent Plugin to Claude projection", () => {
  it("copies skills and converts identity metadata and every supported MCP transport", async () => {
    const plan = await projectAgentPluginToClaude(source([file("bin/server", Uint8Array.from([0, 255]), 0o755)]), {
      target,
      hookArtifacts: [],
      onUnsupported: "error",
    });
    expect(plan.issues).toEqual([]);
    expect(parsed(plan, ".claude-plugin/plugin.json")).toMatchObject({
      name: "portable-tools",
      version: "1.2.3",
      description: "portable description",
      license: "MIT",
    });
    expect(plan.files.find((item) => item.path === "skills/review/SKILL.md")).toBeDefined();
    const binary = plan.files.find((item) => item.path === "bin/server")!;
    expect([...(binary.contents as Uint8Array)]).toEqual([0, 255]);
    expect(binary.mode).toBe(0o755);
    const mcp = parsed(plan, ".mcp.json");
    expect(mcp.mcpServers.local).toMatchObject({
      command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
      args: ["${CLAUDE_PLUGIN_ROOT}/x", "${CLAUDE_PLUGIN_DATA}/y"],
      cwd: "${CLAUDE_PLUGIN_ROOT}",
      env: {
        PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}",
        PLUGIN_DATA: "${CLAUDE_PLUGIN_DATA}",
      },
    });
    expect(mcp.mcpServers.remote).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer literal" },
    });
  });

  it("applies the Claude overlay, preserves extension-only fields, and gives portable identity precedence", async () => {
    const namespace = "com.anthropic.claude-code";
    const portable = source([
      file("README.md", "base"),
      file(`${namespace}/README.md`, "overlay"),
      file(`${namespace}/.claude-plugin/plugin.json`, JSON.stringify({ name: "wrong", custom: true })),
    ]);
    portable.manifest.extensions = { [namespace]: { name: "also-wrong", manifestOnly: true } };
    const plan = await projectAgentPluginToClaude(
      portable,
      { target, hookArtifacts: [], onUnsupported: "error" },
    );
    expect(new TextDecoder().decode(plan.files.find((item) => item.path === "README.md")!.contents as Uint8Array)).toBe("overlay");
    expect(parsed(plan, ".claude-plugin/plugin.json")).toMatchObject({
      name: "portable-tools",
      custom: true,
      manifestOnly: true,
    });
    expect(plan.summary.copiedFileCount).toBe(2);
  });

  it("does not project the source development manifest without an explicit runtime package", async () => {
    const plan = await projectAgentPluginToClaude(
      source([
        file("package.json", JSON.stringify({ dependencies: { "@hooknostic/sdk": "workspace:*" } })),
        file("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {} })),
      ]),
      { target, hookArtifacts: [], onUnsupported: "error" },
    );
    const paths = plan.files.map((item) => item.path);
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain("package-lock.json");
  });

  it("omits client-extension npm manifests instead of installing them unvalidated", async () => {
    const namespace = "com.anthropic.claude-code";
    const plan = await projectAgentPluginToClaude(
      source([
        file(`${namespace}/package.json`, JSON.stringify({ dependencies: { "@hooknostic/sdk": "workspace:*" } })),
        file(`${namespace}/package-lock.json`, "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"),
        file(`${namespace}/README.md`, "overlay"),
      ]),
      { target, hookArtifacts: [], onUnsupported: "warn" },
    );
    const paths = plan.files.map((item) => item.path);
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain("package-lock.json");
    expect(paths).toContain("README.md");
    expect(plan.summary.components["agent-plugin.client-extension.files"]).toEqual({
      discovered: 3,
      emitted: 1,
      skipped: 2,
    });
    expect(plan.summary.omissions).toEqual([
      {
        component: "agent-plugin.client-extension.files",
        name: `${namespace}/package.json`,
        reason: expect.stringContaining("runtimePackage") as unknown as string,
      },
      {
        component: "agent-plugin.client-extension.files",
        name: `${namespace}/package-lock.json`,
        reason: expect.stringContaining("runtimePackage") as unknown as string,
      },
    ]);
  });

  it.each([
    { label: "an exact-case", manifest: "package.json", lockfile: "package-lock.json" },
    { label: "a case-folded", manifest: "Package.json", lockfile: "PACKAGE-LOCK.JSON" },
  ])("fails the default error policy on $label client-extension npm manifest", async ({ manifest, lockfile }) => {
    const namespace = "com.anthropic.claude-code";
    const plan = await projectAgentPluginToClaude(
      source([
        file(`${namespace}/${manifest}`, JSON.stringify({ dependencies: { "@hooknostic/sdk": "workspace:*" } })),
        file(`${namespace}/${lockfile}`, "lockfileVersion: '9.0'\n"),
      ]),
      { target, hookArtifacts: [], onUnsupported: "error" },
    );
    expect(plan.files.map((item) => item.path)).not.toContain(manifest);
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        scope: "projection",
        component: "agent-plugin.client-extension.files",
        path: `${namespace}/${manifest}`,
      }),
      expect.objectContaining({ severity: "error", path: `${namespace}/${lockfile}` }),
    ]);
    expect(diagnosticsFromAgentPluginIssues(plan.issues, "claude")).toContainEqual(
      expect.objectContaining({ code: "HN205", severity: "error", component: "agent-plugin.client-extension.files" }),
    );
  });

  it("materializes the validated runtime pair over client-extension npm manifests", async () => {
    const namespace = "com.anthropic.claude-code";
    const runtimeManifest = JSON.stringify({ name: "portable-runtime", dependencies: { "is-number": "7.0.0" } });
    const runtimeLockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "is-number": "7.0.0" } },
        "node_modules/is-number": { version: "7.0.0", resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz" },
      },
    });
    const plan = await projectAgentPluginToClaude(
      source([
        file(`${namespace}/package.json`, JSON.stringify({ dependencies: { "@hooknostic/sdk": "workspace:*" } })),
        file("runtime.package.json", runtimeManifest),
        file("runtime.package-lock.json", runtimeLockfile),
      ]),
      {
        target,
        hookArtifacts: [],
        runtimePackage: { manifest: "./runtime.package.json", lockfile: "./runtime.package-lock.json" },
        onUnsupported: "warn",
      },
    );
    expect(plan.issues).toEqual([expect.objectContaining({ severity: "warn", path: `${namespace}/package.json` })]);
    expect(parsed(plan, "package.json")).toEqual(JSON.parse(runtimeManifest));
    expect(parsed(plan, "package-lock.json")).toEqual(JSON.parse(runtimeLockfile));
  });

  it("runs native hooks first and appends one generated dispatcher per event", async () => {
    const namespace = "com.anthropic.claude-code";
    const native = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "native" }] }] } };
    const generated = { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "hooknostic" }] }] } };
    const plan = await projectAgentPluginToClaude(
      source([file(`${namespace}/hooks/hooks.json`, JSON.stringify(native))]),
      {
        target,
        hookArtifacts: [
          { path: "hooks/hooks.json", contents: JSON.stringify(generated) },
          { path: "runtime/hooknostic.mjs", contents: "runtime" },
        ],
        onUnsupported: "error",
      },
    );
    expect(parsed(plan, "hooks/hooks.json").hooks.PreToolUse.map((entry: { hooks: { command: string }[] }) => entry.hooks[0]!.command)).toEqual(["native", "hooknostic"]);
  });

  it("materializes a separate locked runtime package at the Claude plugin root", async () => {
    const runtimeManifest = JSON.stringify({
      name: "portable-runtime",
      dependencies: { "is-number": "7.0.0" },
    });
    const runtimeLockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "is-number": "7.0.0" } },
        "node_modules/is-number": { version: "7.0.0", resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz" },
      },
    });
    const plan = await projectAgentPluginToClaude(
      source([
        file("package.json", JSON.stringify({ dependencies: { "@hooknostic/sdk": "workspace:*" } })),
        file("runtime.package.json", runtimeManifest),
        file("runtime.package-lock.json", runtimeLockfile),
      ]),
      {
        target,
        hookArtifacts: [],
        runtimePackage: { manifest: "./runtime.package.json", lockfile: "./runtime.package-lock.json" },
        onUnsupported: "error",
      },
    );
    expect(plan.issues).toEqual([]);
    expect(parsed(plan, "package.json")).toEqual(JSON.parse(runtimeManifest));
    expect(parsed(plan, "package-lock.json")).toEqual(JSON.parse(runtimeLockfile));
    expect(plan.files.some((item) => item.path === "runtime.package.json")).toBe(false);
    expect(plan.summary.components["agent-plugin.runtime-package"]).toEqual({
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
  });

  it.each([
    {
      label: "a lockfile that does not lock a manifest dependency",
      lockfile: JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { "is-number": "7.0.0" } } } }),
      message: "does not lock dependency \"is-number\"",
    },
    {
      label: "a lockfile whose root dependencies differ from the manifest",
      lockfile: JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/is-number": { version: "7.0.0" } },
      }),
      message: "root dependencies do not match",
    },
    {
      label: "a lockfileVersion 1 lockfile",
      lockfile: JSON.stringify({ lockfileVersion: 1, dependencies: { "is-number": { version: "7.0.0" } } }),
      message: "lockfileVersion 2 or 3",
    },
    {
      label: "a pnpm YAML lockfile",
      lockfile: "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      is-number: 7.0.0\n",
      message: "pnpm and yarn lockfiles are not supported",
    },
  ])("rejects $label", async ({ lockfile, message }) => {
    const plan = await projectAgentPluginToClaude(
      source([
        file("runtime.package.json", JSON.stringify({ dependencies: { "is-number": "7.0.0" } })),
        file("runtime.package-lock.json", lockfile),
      ]),
      {
        target,
        hookArtifacts: [],
        runtimePackage: { manifest: "./runtime.package.json", lockfile: "./runtime.package-lock.json" },
        onUnsupported: "error",
      },
    );
    expect(plan.files.some((item) => item.path === "package-lock.json")).toBe(false);
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        component: "agent-plugin.runtime-package",
        message: expect.stringContaining(message),
      }),
    ]);
  });

  it("rejects a missing or unsafe runtime package input", async () => {
    const plan = await projectAgentPluginToClaude(source(), {
      target,
      hookArtifacts: [],
      runtimePackage: { manifest: "../package.json", lockfile: "runtime.package-lock.json" },
      onUnsupported: "error",
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: "file",
        component: "agent-plugin.runtime-package",
        message: expect.stringContaining("package-root-relative"),
      }),
    );
    expect(diagnosticsFromAgentPluginIssues(plan.issues, "claude")).toContainEqual(
      expect.objectContaining({
        code: "HN503",
        target: "claude",
        component: "agent-plugin.runtime-package",
      }),
    );
    expect(plan.summary.components["agent-plugin.runtime-package"]).toEqual({
      discovered: 1,
      emitted: 0,
      skipped: 1,
    });
  });

  it("rejects duplicate MCP names and reserved runtime collisions", async () => {
    const namespace = "com.anthropic.claude-code";
    const duplicate = await projectAgentPluginToClaude(
      source([file(`${namespace}/.mcp.json`, JSON.stringify({ mcpServers: { local: { command: "other" } } }))]),
      { target, hookArtifacts: [], onUnsupported: "error" },
    );
    expect(duplicate.issues).toContainEqual(expect.objectContaining({ severity: "error", message: expect.stringContaining("both") }));

    const collision = await projectAgentPluginToClaude(
      source([file(`${namespace}/runtime/hooknostic.mjs`, "native")]),
      { target, hookArtifacts: [{ path: "runtime/hooknostic.mjs", contents: "generated" }], onUnsupported: "error" },
    );
    expect(collision.issues).toContainEqual(expect.objectContaining({ severity: "error", message: expect.stringContaining("collides") }));
  });
});
