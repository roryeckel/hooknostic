import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginFile,
  type AgentPluginPackage,
} from "@hooknostic/agent-plugin";
import { diagnosticsFromAgentPluginIssues, resolveAgentPluginProjection } from "@hooknostic/core";

import { claudeAdapter } from "./index.js";
import { claudeAgentPluginProjector, projectAgentPluginToClaude } from "./project-agent-plugin.js";

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
    skills: [
      {
        name: "review",
        description: "Review code",
        directory: "skills/review",
        manifestPath: "skills/review/SKILL.md",
      },
    ],
    mcp: {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: { type: "stdio", command: "./bin/server", args: ["${PLUGIN_ROOT}/x", "${PLUGIN_DATA}/y"] },
        remote: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer literal" },
        },
      },
    },
    files: [file("plugin.json", "{}"), file("skills/review/SKILL.md", "skill"), ...files],
    contentDigest: "sha256:source",
  };
}

const target = { id: "claude", version: ">=2.1 <3", delivery: "package" as const, output: "dist" };
// Resolved from the projector's own profiles rather than restated, so a
// component these tests treat as projectable cannot drift from the matrix.
const support = resolveAgentPluginProjection(target, claudeAgentPluginProjector).matrix!;

function parsed(plan: Awaited<ReturnType<typeof projectAgentPluginToClaude>>, path: string) {
  const artifact = plan.files.find((candidate) => candidate.path === path)!;
  return JSON.parse(
    typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents),
  );
}

describe("Agent Plugin to Claude projection", () => {
  it("preserves opaque Notification hooks alongside generated hooks through final validation", async () => {
    const notification = [{ hooks: [{ type: "command", command: "echo native" }] }];
    const generated = [{ hooks: [{ type: "command", command: "node runtime/hooknostic.mjs" }] }];
    const plan = await projectAgentPluginToClaude(
      source([
        file("com.anthropic.claude-code/hooks/hooks.json", JSON.stringify({ hooks: { Notification: notification } })),
      ]),
      {
        target,
        support,
        onUnsupported: "error",
        hookArtifacts: [file("hooks/hooks.json", JSON.stringify({ hooks: { PreToolUse: generated } }))],
      },
    );
    expect(plan.issues).toEqual([]);
    expect(parsed(plan, "hooks/hooks.json")).toEqual({ hooks: { Notification: notification, PreToolUse: generated } });
    expect(await claudeAdapter().validateArtifacts!(plan.files, target)).toEqual([]);
  });

  it("carries a runner command through untouched, whatever language it launches", async () => {
    // The dominant real-world shape: of 24 stdio servers configured on one
    // developer machine, every third-party one was a runner (`npx`, `bun`,
    // `uvx`, `docker`, `php`) rather than an interpreter plus a bundled entry.
    const portable = source();
    portable.mcp = {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        python: { type: "stdio", command: "uvx", args: ["mcp-server-git", "--repository", "${PLUGIN_ROOT}"] },
      },
    };

    const plan = await projectAgentPluginToClaude(portable, {
      target,
      support,
      onUnsupported: "error",
      hookArtifacts: [],
    });

    // Claude spells the real command inline in the launcher's own argv, and
    // ${PLUGIN_ROOT} becomes Claude's variable rather than a build-time path.
    expect(parsed(plan, ".mcp.json").mcpServers.python).toEqual({
      type: "stdio",
      command: "node",
      args: [
        "${CLAUDE_PLUGIN_ROOT}/runtime/mcp-launcher.mjs",
        "${CLAUDE_PLUGIN_ROOT}",
        "uvx",
        "mcp-server-git",
        "--repository",
        "${CLAUDE_PLUGIN_ROOT}",
      ],
      // Claude does not honour a declared cwd itself (.capture/claude-mcp-cwd),
      // so the launcher is handed the plugin root and both bindings.
      cwd: "${CLAUDE_PLUGIN_ROOT}",
      env: { PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}", PLUGIN_DATA: "${CLAUDE_PLUGIN_DATA}" },
    });
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it.each([null, [], {}, { hooks: null }, { hooks: [] }, { hooks: { Notification: {} } }])(
    "rejects malformed final hook documents: %j",
    async (document) => {
      const diagnostics = await claudeAdapter().validateArtifacts!(
        [{ path: "hooks/hooks.json", contents: JSON.stringify(document) }],
        target,
      );
      expect(diagnostics).toEqual([expect.objectContaining({ code: "HN301", severity: "error" })]);
    },
  );

  it.each([
    ["./", "${CLAUDE_PLUGIN_ROOT}"],
    ["./worker", "${CLAUDE_PLUGIN_ROOT}/worker"],
    ["${PLUGIN_ROOT}/worker", "${CLAUDE_PLUGIN_ROOT}/worker"],
    ["${PLUGIN_DATA}/state", "${CLAUDE_PLUGIN_DATA}/state"],
    [undefined, "${CLAUDE_PLUGIN_ROOT}"],
    // Normalization is intended, not incidental: a trailing slash and a dot
    // segment are both valid and both mean `worker`. The prefix replacement
    // this replaced emitted them verbatim.
    ["./worker/./", "${CLAUDE_PLUGIN_ROOT}/worker"],
    ["${PLUGIN_DATA}/state/../state", "${CLAUDE_PLUGIN_DATA}/state"],
  ])("anchors portable MCP cwd %s", async (cwd, expected) => {
    const portable = source();
    portable.mcp!.mcpServers = { worker: { type: "stdio", command: "node", ...(cwd === undefined ? {} : { cwd }) } };
    const plan = await projectAgentPluginToClaude(portable, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
    });
    expect(plan.issues).toEqual([]);
    expect(parsed(plan, ".mcp.json").mcpServers.worker).toMatchObject({
      command: "node",
      cwd: expected,
      args: ["${CLAUDE_PLUGIN_ROOT}/runtime/mcp-launcher.mjs", expected, "node"],
    });
  });

  // Claude expands any set ${NAME} in these fields
  // (.capture/agent-plugin-mcp-placeholders). The declaration stays native and
  // emitted; the departure from the literal rule is reported per server.
  it("reports a deviation for each server containing text Claude would expand, and still emits it", async () => {
    const portable = source();
    portable.mcp!.mcpServers = {
      clean: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/a"], env: { STATE: "${PLUGIN_DATA}/s" } },
      worker: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}", "--token=${API_TOKEN}"],
        env: { REGION: "${REGION:-us}" },
        cwd: "./${SUBDIR}",
      },
      // The specification expands nothing in a command, so even the plugin
      // placeholder is literal text there.
      tool: { type: "stdio", command: "${PLUGIN_ROOT}" },
      http: {
        type: "streamable-http",
        url: "https://example.invalid/${TENANT}/mcp",
        // Header names are not scanned: Claude keeps them literal.
        headers: { Authorization: "Bearer ${API_TOKEN}", "X-${NAME}": "literal" },
      },
      // Remote fields expand nothing under the standard, the plugin
      // placeholders included, and Claude substitutes an ambient PLUGIN_ROOT.
      events: { type: "sse", url: "https://example.invalid/${PLUGIN_ROOT}/sse" },
    };
    const plan = await projectAgentPluginToClaude(portable, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
    });

    expect(plan.issues).toEqual([]);
    const reported = (name: string, component: string, references: string) => ({
      id: "mcp-environment-expansion",
      component,
      name,
      path: `mcp.json#${name}`,
      reason: expect.stringContaining(`contains ${references}, which`),
    });
    expect(plan.summary.deviations).toEqual([
      reported("worker", "agent-plugin.mcp.stdio", "${API_TOKEN}, ${REGION:-us}, ${SUBDIR}"),
      reported("tool", "agent-plugin.mcp.stdio", "${PLUGIN_ROOT}"),
      reported("http", "agent-plugin.mcp.streamable-http", "${TENANT}, ${API_TOKEN}"),
      reported("events", "agent-plugin.mcp.sse", "${PLUGIN_ROOT}"),
    ]);
    const servers = parsed(plan, ".mcp.json").mcpServers;
    expect(servers.worker.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/runtime/mcp-launcher.mjs",
      "${CLAUDE_PLUGIN_ROOT}/${SUBDIR}",
      "node",
      "${CLAUDE_PLUGIN_ROOT}",
      "--token=${API_TOKEN}",
    ]);
    // Carried literally, not translated to Claude's variable.
    expect(servers.tool.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/runtime/mcp-launcher.mjs",
      "${CLAUDE_PLUGIN_ROOT}",
      "${PLUGIN_ROOT}",
    ]);
    expect(servers.http).toEqual({
      type: "http",
      url: "https://example.invalid/${TENANT}/mcp",
      headers: { Authorization: "Bearer ${API_TOKEN}", "X-${NAME}": "literal" },
    });
    expect(servers.events).toEqual({ type: "sse", url: "https://example.invalid/${PLUGIN_ROOT}/sse" });
    expect(plan.summary.omissions).toEqual([]);
    for (const [component, count] of [
      ["agent-plugin.mcp.stdio", 3],
      ["agent-plugin.mcp.streamable-http", 1],
      ["agent-plugin.mcp.sse", 1],
    ] as const) {
      expect(plan.summary.components[component]).toMatchObject({ discovered: count, emitted: count, skipped: 0 });
    }
  });

  it("reports no deviation for a range whose profile does not declare it", async () => {
    const portable = source();
    portable.mcp!.mcpServers = { worker: { type: "stdio", command: "node", args: ["${API_TOKEN}"] } };
    const undeclared = Object.fromEntries(
      Object.entries(support).map(([component, cell]) => [component, { level: cell.level }]),
    );
    const plan = await projectAgentPluginToClaude(portable, {
      target,
      hookArtifacts: [],
      support: undeclared,
      onUnsupported: "error",
    });
    expect(plan.summary.deviations).toEqual([]);
    expect(parsed(plan, ".mcp.json").mcpServers.worker.args.at(-1)).toBe("${API_TOKEN}");
  });

  // Everything an omission has to stay consistent with: the count the report
  // publishes, the file that would otherwise be generated for nobody, and the
  // field the diagnostic names.
  it("keeps an omitted server out of the counts, the launcher, and the wrong diagnostic", async () => {
    const portable = source([file("runtime/mcp-launcher.mjs", "package content")]);
    portable.mcp!.mcpServers = {
      // Refused for its command, with no cwd at all -- so a diagnostic that
      // always blames cwd prints "working directory undefined".
      unportable: { type: "stdio", command: "./..\\..\\tool.exe" },
    };
    const plan = await projectAgentPluginToClaude(portable, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
    });
    // No stdio server survives, so the launcher is never generated -- and the
    // package's own file at that path is therefore not a collision.
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(plan.files.some((item) => item.path === "runtime/mcp-launcher.mjs")).toBe(true);
    expect(plan.summary.copiedPaths).toContain("runtime/mcp-launcher.mjs");
    // The report must not call a server emitted that .mcp.json does not contain.
    expect(plan.summary.components["agent-plugin.mcp.stdio"]).toEqual({
      discovered: 1,
      emitted: 0,
      skipped: 1,
    });
    expect(plan.summary.omissions).toContainEqual(
      expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "unportable" }),
    );
    const reason = plan.summary.omissions.find((item) => item.name === "unportable")!.reason;
    expect(reason).toContain("command");
    expect(reason).not.toContain("working directory");
  });

  // The prefix replacement this replaced emitted ${CLAUDE_PLUGIN_DATA}/../x
  // unchecked, pointing the server at a sibling of the directory Claude manages.
  it.each(["${PLUGIN_ROOT}/../escape", "${PLUGIN_DATA}/../escape"])(
    "omits a server whose cwd %s escapes its base",
    async (cwd) => {
      const portable = source();
      portable.mcp!.mcpServers = { worker: { type: "stdio", command: "node", cwd } };
      const plan = await projectAgentPluginToClaude(portable, {
        target,
        hookArtifacts: [],
        support,
        onUnsupported: "warn",
      });
      expect(plan.files.some((item) => item.path === ".mcp.json")).toBe(false);
      expect(plan.summary.omissions).toContainEqual(
        expect.objectContaining({ component: "agent-plugin.mcp.stdio", name: "worker" }),
      );
    },
  );

  it("launches MCP in the plugin directory and preserves arguments, environment, and exit status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-mcp-launcher-"));
    try {
      const pluginDir = join(dir, "plugin");
      const projectDir = join(dir, "project");
      await mkdir(projectDir);
      await mkdir(join(pluginDir, "worker"), { recursive: true });
      const portable = source();
      portable.mcp!.mcpServers = {
        worker: {
          type: "stdio",
          command: process.execPath,
          cwd: "./worker",
          args: [
            "-e",
            "console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],env:process.env.PROBE}));process.exit(7)",
            "literal $value with spaces",
          ],
          env: { PROBE: "preserved" },
        },
      };
      const plan = await projectAgentPluginToClaude(portable, {
        target,
        hookArtifacts: [],
        support,
        onUnsupported: "error",
      });
      expect(plan.issues).toEqual([]);
      for (const artifact of plan.files) {
        await mkdir(join(pluginDir, artifact.path, ".."), { recursive: true });
        await writeFile(join(pluginDir, artifact.path), artifact.contents);
      }
      const server = parsed(plan, ".mcp.json").mcpServers.worker;
      const result = spawnSync(
        server.command,
        server.args.map((arg: string) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDir)),
        {
          cwd: projectDir,
          env: { ...process.env, ...server.env },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(7);
      expect(JSON.parse(result.stdout)).toEqual({
        cwd: join(pluginDir, "worker"),
        arg: "literal $value with spaces",
        env: "preserved",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects package content at the generated MCP launcher path", async () => {
    const plan = await projectAgentPluginToClaude(source([file("runtime/mcp-launcher.mjs", "untrusted")]), {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
    });
    expect(plan.issues).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("collides") }),
    ]);
  });

  it.skipIf(process.platform !== "win32").each(["probe", "probe.cmd"])(
    "launches Windows command shim %s with literal arguments",
    async (command) => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic cmd launcher "));
      try {
        const bin = join(dir, "bin with spaces");
        const worker = join(dir, "worker");
        await mkdir(bin);
        await mkdir(worker);
        await writeFile(join(bin, "probe.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0probe.cjs" %*\r\n`);
        await writeFile(
          join(bin, "probe.cjs"),
          "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));process.exit(7);",
        );
        const args = ["", "with spaces", 'a"quote', "trailing\\", "%PATH%", "!literal!", "a&b|c<d>e^f(g)"];
        const portable = source();
        portable.mcp!.mcpServers = { worker: { type: "stdio", command, args } };
        const plan = await projectAgentPluginToClaude(portable, {
          target,
          hookArtifacts: [],
          support,
          onUnsupported: "error",
        });
        expect(plan.issues).toEqual([]);
        const launcher = plan.files.find((item) => item.path === "runtime/mcp-launcher.mjs")!;
        const launcherPath = join(dir, "launcher.mjs");
        await writeFile(launcherPath, launcher.contents);
        const env = { ...process.env };
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
        env[pathKey] = `${bin};${env[pathKey] ?? ""}`;
        const result = spawnSync(process.execPath, [launcherPath, worker, command, ...args], {
          cwd: dir,
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(7);
        expect(JSON.parse(result.stdout)).toEqual({ cwd: worker, args });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("copies skills and converts identity metadata and every supported MCP transport", async () => {
    const plan = await projectAgentPluginToClaude(source([file("bin/server", Uint8Array.from([0, 255]), 0o755)]), {
      target,
      hookArtifacts: [],
      support,
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
      command: "node",
      args: [
        "${CLAUDE_PLUGIN_ROOT}/runtime/mcp-launcher.mjs",
        "${CLAUDE_PLUGIN_ROOT}",
        "${CLAUDE_PLUGIN_ROOT}/bin/server",
        "${CLAUDE_PLUGIN_ROOT}/x",
        "${CLAUDE_PLUGIN_DATA}/y",
      ],
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
    const plan = await projectAgentPluginToClaude(portable, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
    });
    expect(new TextDecoder().decode(plan.files.find((item) => item.path === "README.md")!.contents as Uint8Array)).toBe(
      "overlay",
    );
    expect(parsed(plan, ".claude-plugin/plugin.json")).toMatchObject({
      name: "portable-tools",
      custom: true,
      manifestOnly: true,
    });
    // The overlay's `.claude-plugin/plugin.json` was read, not copied: the
    // manifest at that path is generated, and core reads exactly this list to
    // tell copied files from generated ones.
    expect(plan.summary.copiedPaths).toEqual(["README.md", "skills/review/SKILL.md"]);
  });

  it("counts a manifest-only Claude extension as one emitted client extension", async () => {
    const namespace = "com.anthropic.claude-code";
    const portable = source();
    portable.manifest.extensions = { [namespace]: { manifestOnly: true } };
    const plan = await projectAgentPluginToClaude(portable, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
    });
    expect(parsed(plan, ".claude-plugin/plugin.json")).toMatchObject({ manifestOnly: true });
    expect(plan.summary.components["agent-plugin.client-extension.files"]).toEqual({
      discovered: 1,
      emitted: 1,
      skipped: 0,
    });
  });

  it.each([{}, { email: "maintainer@example.com" }, { url: "https://example.com" }, { name: "" }])(
    "reports an unrepresentable author under both projection policies: %j",
    async (author) => {
      const portable = source();
      delete portable.mcp;
      portable.manifest.author = author;
      // Portable identity wins even when the native overlay supplies a name.
      portable.manifest.extensions = { "com.anthropic.claude-code": { author: { name: "Overlay" } } };
      for (const onUnsupported of ["error", "warn"] as const) {
        const plan = await projectAgentPluginToClaude(portable, { target, hookArtifacts: [], support, onUnsupported });
        expect(plan.issues).toEqual([
          expect.objectContaining({
            severity: onUnsupported,
            component: "agent-plugin.manifest",
            message: expect.stringContaining("author.name"),
            // Where the author wrote it. Naming the generated manifest sent
            // them to a file they do not have.
            path: "plugin.json#/author",
          }),
        ]);
        expect(parsed(plan, ".claude-plugin/plugin.json")).not.toHaveProperty("author");
        expect(plan.summary.omissions).toEqual([
          expect.objectContaining({
            component: "agent-plugin.manifest",
            name: "author",
          }),
        ]);
        expect(portable.manifest.author).toEqual(author);
      }
    },
  );

  it("names the client extension when the unrepresentable author came from there", async () => {
    // Portable identity wins when it exists, so with no root author the
    // declaration the projection rejected is the extension's own.
    const portable = source();
    delete portable.mcp;
    delete portable.manifest.author;
    portable.manifest.extensions = { "com.anthropic.claude-code": { author: { name: "" } } };

    const plan = await projectAgentPluginToClaude(portable, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "warn",
    });

    expect(plan.issues).toEqual([
      expect.objectContaining({
        path: "plugin.json#/extensions/com.anthropic.claude-code/author",
        message: expect.stringContaining("author.name"),
      }),
    ]);
  });

  it("preserves a representable author without tightening Claude's name rule", async () => {
    const portable = source();
    delete portable.mcp;
    // The native validator accepts whitespace; the requirement is length, not trimming.
    portable.manifest.author = { name: " ", email: "maintainer@example.com" };
    const plan = await projectAgentPluginToClaude(portable, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
    });
    expect(plan.issues).toEqual([]);
    expect(parsed(plan, ".claude-plugin/plugin.json").author).toEqual(portable.manifest.author);
    expect(plan.summary.omissions).toEqual([]);
  });

  it("does not project the source development manifest without an explicit runtime package", async () => {
    const plan = await projectAgentPluginToClaude(
      source([
        file("package.json", JSON.stringify({ dependencies: { "@hooknostic/sdk": "workspace:*" } })),
        file("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {} })),
      ]),
      { target, hookArtifacts: [], support, onUnsupported: "error" },
    );
    const paths = plan.files.map((item) => item.path);
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain("package-lock.json");
  });

  it.each(["npm-shrinkwrap.json", "NPM-SHRINKWRAP.JSON"])(
    "prevents %s from overriding the validated runtime lockfile through either copy route",
    async (name) => {
      for (const prefix of ["", "com.anthropic.claude-code/"]) {
        for (const onUnsupported of ["error", "warn"] as const) {
          const plan = await projectAgentPluginToClaude(
            source([
              file(`${prefix}${name}`, JSON.stringify({ lockfileVersion: 3, packages: {} })),
              file("runtime.package.json", JSON.stringify({ dependencies: {} })),
              file(
                "runtime.package-lock.json",
                JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: {} } } }),
              ),
            ]),
            {
              target,
              hookArtifacts: [],
              support,
              onUnsupported,
              runtimePackage: { manifest: "runtime.package.json", lockfile: "runtime.package-lock.json" },
            },
          );
          expect(plan.files.map((item) => item.path)).not.toContain(name);
          expect(parsed(plan, "package-lock.json").packages).toHaveProperty("");
          if (prefix) {
            expect(plan.issues).toContainEqual(
              expect.objectContaining({ severity: onUnsupported, path: `${prefix}${name}` }),
            );
            expect(plan.summary.components["agent-plugin.client-extension.files"]).toEqual({
              discovered: 1,
              emitted: 0,
              skipped: 1,
            });
          } else {
            expect(plan.issues).toEqual([]);
          }
        }
      }
    },
  );

  it("omits client-extension npm manifests instead of installing them unvalidated", async () => {
    const namespace = "com.anthropic.claude-code";
    const plan = await projectAgentPluginToClaude(
      source([
        file(`${namespace}/package.json`, JSON.stringify({ dependencies: { "@hooknostic/sdk": "workspace:*" } })),
        file(`${namespace}/package-lock.json`, "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"),
        file(`${namespace}/README.md`, "overlay"),
      ]),
      { target, hookArtifacts: [], support, onUnsupported: "warn" },
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
      { target, hookArtifacts: [], support, onUnsupported: "error" },
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
        "node_modules/is-number": {
          version: "7.0.0",
          resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
        },
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
        support,
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
    const generated = {
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "hooknostic" }] }] },
    };
    const plan = await projectAgentPluginToClaude(
      source([file(`${namespace}/hooks/hooks.json`, JSON.stringify(native))]),
      {
        target,
        hookArtifacts: [
          { path: "hooks/hooks.json", contents: JSON.stringify(generated) },
          { path: "runtime/hooknostic.mjs", contents: "runtime" },
        ],
        support,
        onUnsupported: "error",
      },
    );
    expect(
      parsed(plan, "hooks/hooks.json").hooks.PreToolUse.map(
        (entry: { hooks: { command: string }[] }) => entry.hooks[0]!.command,
      ),
    ).toEqual(["native", "hooknostic"]);
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
        "node_modules/is-number": {
          version: "7.0.0",
          resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
        },
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
        support,
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
      message: 'does not lock dependency "is-number"',
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
        support,
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
      support,
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
      { target, hookArtifacts: [], support, onUnsupported: "error" },
    );
    expect(duplicate.issues).toContainEqual(
      expect.objectContaining({ severity: "error", message: expect.stringContaining("both") }),
    );

    const collision = await projectAgentPluginToClaude(
      source([file(`${namespace}/runtime/hooknostic.mjs`, "native")]),
      {
        target,
        hookArtifacts: [{ path: "runtime/hooknostic.mjs", contents: "generated" }],
        support,
        onUnsupported: "error",
      },
    );
    expect(collision.issues).toContainEqual(
      expect.objectContaining({ severity: "error", message: expect.stringContaining("collides") }),
    );
  });

  // A Claude-native file at the package root is not a client extension. The
  // projector copies the base tree onto the same keys it later reads its native
  // overlay from, so an unfiltered base file at one of those paths becomes the
  // overlay without passing any portable validation.
  it.each([
    [".mcp.json", "{}"],
    // Case-folded, for the same reason the npm manifest check folds: a name
    // Linux distinguishes is Claude's config file on macOS or Windows.
    [".MCP.json", "{}"],
    ["hooks/hooks.json", "{}"],
    [".claude-plugin/plugin.json", "{}"],
    [".claude-plugin/marketplace.json", "{}"],
  ])("rejects the portable base file %s for occupying a Claude-reserved path", async (path, contents) => {
    const plan = await projectAgentPluginToClaude(source([file(path, contents)]), {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
    });
    expect(plan.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: "file",
        path,
        message: expect.stringContaining("com.anthropic.claude-code/"),
      }),
    );
    expect(diagnosticsFromAgentPluginIssues(plan.issues, "claude").map((item) => item.code)).toContain("HN503");
  });

  it("never merges a portable base file into the Claude-native output it shadows", async () => {
    const plan = await projectAgentPluginToClaude(
      source([
        file(".mcp.json", JSON.stringify({ mcpServers: { rogue: { command: "rogue" } }, extra: "leaked" })),
        file(".claude-plugin/plugin.json", JSON.stringify({ name: "impostor", rogue: "leaked" })),
        file(
          "hooks/hooks.json",
          JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "rogue" }] }] } }),
        ),
      ]),
      {
        target,
        hookArtifacts: [
          {
            path: "hooks/hooks.json",
            contents: JSON.stringify({
              hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "hooknostic" }] }] },
            }),
          },
        ],
        support,
        onUnsupported: "error",
      },
    );
    const mcp = parsed(plan, ".mcp.json");
    expect(Object.keys(mcp.mcpServers)).toEqual(["local", "remote"]);
    expect(mcp.extra).toBeUndefined();
    expect(parsed(plan, ".claude-plugin/plugin.json")).not.toHaveProperty("rogue");
    expect(
      parsed(plan, "hooks/hooks.json").hooks.PreToolUse.map(
        (entry: { hooks: { command: string }[] }) => entry.hooks[0]!.command,
      ),
    ).toEqual(["hooknostic"]);
    expect(plan.issues).toHaveLength(3);
  });

  const projectWithMaterializedTree = (pkg: AgentPluginPackage, into: string, path: string) =>
    projectAgentPluginToClaude(pkg, {
      target,
      hookArtifacts: [],
      support,
      onUnsupported: "error",
      materializedTrees: [
        { provider: "fixture", into, files: [{ path, contents: encoder.encode(path), mode: 0o644 }] },
      ],
    });

  it("places a materialized package tree at the plugin root without calling it copied", async () => {
    const plan = await projectWithMaterializedTree(source(), "generated/dependencies", "library/data.bin");

    expect(plan.files.some((candidate) => candidate.path === "generated/dependencies/library/data.bin")).toBe(true);
    expect(plan.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    // The bytes came from an installer, not the package: the summary's
    // "copied byte-for-byte" list must not claim them.
    expect(plan.summary.copiedPaths).not.toContain("generated/dependencies/library/data.bin");
  });

  it("refuses a materialized package tree that lands on a generated or native path", async () => {
    // Without this the later `files.set` at each generated path silently drops
    // the runtime, and `runtime/mcp-launcher.mjs` would blame package content.
    // The launcher is reported through the projector's throw path, so the
    // message rather than a `path` field carries the destination.
    const hooks = await projectWithMaterializedTree(source(), "hooks", "hooks.json");
    expect(hooks.issues).toContainEqual(expect.objectContaining({ severity: "error", path: "hooks/hooks.json" }));

    const launcher = await projectWithMaterializedTree(source(), "runtime", "mcp-launcher.mjs");
    expect(launcher.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("collides with a materialized package tree"),
      }),
    );
  });
});
