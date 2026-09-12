import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { readProjectToml } from "./project-toml.js";
import { runProject } from "./project.js";
import { buildProject } from "./build.js";
import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA } from "@hooknostic/agent-plugin";
const dirs: string[] = [];
const registry = defaultAdapterRegistry();
const evaluate = { alias: { "@hooknostic/sdk": fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)) } };
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-local-")); dirs.push(root);
  await writeFile(join(root, "hooks.ts"), `import { definePlugin, hook, block } from "@hooknostic/sdk";
export default definePlugin({ name: "sample-project", hooks: [hook("tool.before", { id: "guard", timeoutMs: 4000, match: { kind: "shell" }, capabilities: { "tool.before.block": "required" }, async run() { return block("project marker"); } })] });`);
  const targets = Object.fromEntries(Object.entries(registry).map(([name, adapter]) => [name, { adapter: name, version: adapter.harness.recommendedRange, delivery: "project", output: `.hooknostic/artifacts/${name}` }]));
  const config = { project: { root: "." }, entry: "./hooks.ts", targets, ...extra };
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(configPath, `export default ${JSON.stringify(config)};`);
  return { root, config, options: { configPath, registry, evaluate } };
}
describe("complete project integration", () => {
  it("wires all three harnesses, verifies cleanly, and detects stale source", async () => {
    const { root, options } = await fixture();
    const dry = await runProject({ ...options, command: "sync", dryRun: true });
    expect(dry.errors).toEqual([]); expect(dry.changes).toContain(".codex/hooks.json");
    await expect(readFile(join(root, ".codex/hooks.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
    expect(await readFile(join(root, ".hooknostic/.gitattributes"), "utf8")).toBe("** -text\n");
    const codex = JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8"));
    expect(codex.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
    await mkdir(join(root, "backend/nested"), { recursive: true });
    const hookRun = spawnSync(codex.hooks.PreToolUse[0].hooks[0].command, {
      cwd: join(root, "backend/nested"),
      encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, session_id: "sample", tool_name: "Bash", tool_input: { command: "echo test" } }),
      shell: true,
      timeout: 10_000,
    });
    expect(hookRun.status, hookRun.stderr).toBe(0);
    expect(hookRun.stdout).toContain("project marker");
    expect(await readFile(join(root, ".opencode/plugins/hooknostic.js"), "utf8")).toContain(".hooknostic/artifacts/opencode");
    const source = await readFile(join(root, "hooks.ts"), "utf8");
    await writeFile(join(root, "hooks.ts"), source.replace("4000", "9000"));
    expect((await runProject({ ...options, command: "verify" })).drift).toBe(true);
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].timeout).toBe(10);
  });
  it("honors a named target at runtime", async () => {
    const adapter = registry.claude!;
    const { root, options } = await fixture({ targets: { primary: { adapter: "claude", version: adapter.harness.recommendedRange, delivery: "project", output: "generated hooks/primary" } } });
    const path = join(root, "hooks.ts");
    await writeFile(path, (await readFile(path, "utf8")).replace('id: "guard",', 'id: "guard", targets: { include: ["primary"] },'));
    const synced = await runProject({ ...options, command: "sync" }); expect(synced.errors).toEqual([]);
    const run = spawnSync(process.execPath, [join(root, "generated hooks/primary/runtime/hooknostic.mjs")], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, session_id: "sample", tool_name: "Bash", tool_input: { command: "echo test" } }) });
    expect(run.stdout).toContain("project marker");
  });
  it("copies direct skills and resources without requiring package metadata", async () => {
    const { root, options } = await fixture({ components: { skills: ["./skills"], exclude: ["**/__pycache__/**", "**/*.pyc", "sample/assets/**", "sample/references/test-credentials.md"] } });
    await mkdir(join(root, "skills/sample/references"), { recursive: true });
    await mkdir(join(root, "skills/sample/assets"), { recursive: true });
    await mkdir(join(root, "skills/sample/__pycache__"), { recursive: true });
    await writeFile(join(root, "skills/sample/SKILL.md"), "---\nname: sample\ndescription: Synthetic skill\n---\nRead references/note.md.\n");
    await writeFile(join(root, "skills/sample/references/note.md"), "resource\n");
    await writeFile(join(root, "skills/sample/references/test-credentials.md"), "ignored\n");
    await writeFile(join(root, "skills/sample/assets/session.json"), "ignored\n");
    await writeFile(join(root, "skills/sample/__pycache__/probe.pyc"), "ignored\n");
    const synced = await runProject({ ...options, command: "sync" }); expect(synced.errors).toEqual([]);
    expect(await readFile(join(root, ".claude/skills/sample/references/note.md"), "utf8")).toBe("resource\n");
    await expect(readFile(join(root, ".claude/skills/sample/references/test-credentials.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".claude/skills/sample/assets/session.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".claude/skills/sample/__pycache__/probe.pyc"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".claude/skills/.gitattributes"), "utf8")).toBe("** -text\n");
    expect(await readFile(join(root, ".agents/skills/sample/SKILL.md"), "utf8")).toContain("Synthetic skill");
  });
  it("relinquishes copied skills when their native destination becomes the source", async () => {
    const codex = registry.codex!;
    const { root, config, options } = await fixture({
      components: { skills: ["./skills"] },
      targets: {
        codex: { adapter: "codex", version: codex.harness.recommendedRange, delivery: "project", output: ".hooknostic/artifacts/codex" },
      },
    });
    await mkdir(join(root, "skills/sample"), { recursive: true });
    await writeFile(join(root, "skills/sample/SKILL.md"), "---\nname: sample\ndescription: Synthetic skill\n---\nOriginal\n");
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    const native = join(root, ".agents/skills/sample/SKILL.md");
    const attributes = join(root, ".agents/skills/.gitattributes");
    await writeFile(native, "---\nname: sample\ndescription: Native source\n---\nAuthored\n");
    await writeFile(attributes, "# Native policy\n** -text\n");
    await writeFile(options.configPath, `export default ${JSON.stringify({
      ...config,
      components: { skills: ["./.agents/skills"] },
    })};`);

    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    expect(await readFile(native, "utf8")).toContain("Authored");
    expect(await readFile(attributes, "utf8")).toBe("# Native policy\n** -text\n");
    const manifest = await readFile(join(root, ".hooknostic/integration.json"), "utf8");
    expect(manifest).not.toContain(".agents/skills/sample/SKILL.md");
    expect(manifest).not.toContain(".agents/skills/.gitattributes");
    await writeFile(native, "---\nname: sample\ndescription: Native source\n---\nEdited\n");
    await writeFile(attributes, "# Edited native policy\n** -text\n");
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
  });
  it("ignores unselected package targets when loading direct components", async () => {
    const claude = registry.claude!;
    const codex = registry.codex!;
    const { root, options } = await fixture({
      components: { skills: ["./skills"], targets: ["local"] },
      targets: {
        local: { adapter: "claude", version: claude.harness.recommendedRange, delivery: "project", output: ".hooknostic/artifacts/local" },
        unrelated: { adapter: "codex", version: codex.agentPluginProjector!.profiles.at(-1)!.range, delivery: "package", output: "dist/unrelated" },
      },
    });
    await mkdir(join(root, "skills/sample"), { recursive: true });
    await writeFile(join(root, "skills/sample/SKILL.md"), "---\nname: sample\ndescription: Synthetic skill\n---\n");

    const result = await runProject({ ...options, command: "sync" });
    expect(result.errors).toEqual([]);
    expect(await readFile(join(root, ".claude/skills/sample/SKILL.md"), "utf8")).toContain("Synthetic skill");
  });
  it("rejects duplicate project adapters and partial synchronization", async () => {
    const adapter = registry.claude!;
    const target = { adapter: "claude", version: adapter.harness.recommendedRange, delivery: "project", output: "dist/a" };
    const { options } = await fixture({ targets: { a: target, b: { ...target, output: "dist/b" } } });
    expect((await runProject({ ...options, command: "sync" })).errors.join()).toContain("duplicate project");
    expect((await runProject({ ...options, command: "sync", targets: ["a"] })).errors.join()).toContain("partial");
  });
  it("projects MCP declarations without expanding environment values", async () => {
    const { root, options } = await fixture({ components: { mcp: "./mcp.json" } });
    await writeFile(join(root, "mcp.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { sample: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"], env: { TOKEN: "${UNRESOLVED_TOKEN}" } } } }));
    const synced = await runProject({ ...options, command: "sync" }); expect(synced.errors).toEqual([]);
    expect(await readFile(join(root, ".hooknostic/artifacts/claude/mcp-servers.json"), "utf8")).toContain("${UNRESOLVED_TOKEN}");
    expect(await readFile(join(root, ".hooknostic/integration.json"), "utf8")).not.toContain("TOKEN");
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
  });
  it("synchronizes prototype-key MCP server names for Claude and Codex", async () => {
    const claude = registry.claude!;
    const codex = registry.codex!;
    const { root, options } = await fixture({
      components: { mcp: "./mcp.json" },
      targets: {
        claude: { adapter: "claude", version: claude.harness.recommendedRange, delivery: "project", output: ".hooknostic/artifacts/claude" },
        codex: { adapter: "codex", version: codex.harness.recommendedRange, delivery: "project", output: ".hooknostic/artifacts/codex" },
      },
    });
    await writeFile(join(root, "mcp.json"), `{"$schema":"${AGENT_PLUGIN_MCP_SCHEMA}","mcpServers":{"__proto__":{"type":"streamable-http","url":"https://proto.invalid/mcp"},"constructor":{"type":"streamable-http","url":"https://constructor.invalid/mcp"},"prototype":{"type":"streamable-http","url":"https://prototype.invalid/mcp"}}}`);

    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    const claudeServers = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers as Record<string, unknown>;
    const codexServers = readProjectToml(await readFile(join(root, ".codex/config.toml"), "utf8")).mcp_servers as Record<string, unknown>;
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(claudeServers, name)).toBe(true);
      expect(Object.hasOwn(codexServers, name)).toBe(true);
    }
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
  });
  it("reports and omits Claude package remotes whose references cannot remain literal", async () => {
    const claude = registry.claude!;
    const { root, options } = await fixture({
      components: { root: "./portable", targets: ["claude"], onUnsupported: "warn" },
      targets: { claude: { adapter: "claude", version: claude.harness.recommendedRange, delivery: "project", output: ".hooknostic/artifacts/claude" } },
    });
    await mkdir(join(root, "portable"));
    await writeFile(join(root, "portable/plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "portable" }));
    await writeFile(join(root, "portable/mcp.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        referenced: { type: "streamable-http", url: "https://example.invalid/${RUNTIME_TOKEN}/mcp", headers: { Authorization: "Bearer ${RUNTIME_TOKEN}" } },
        literal: { type: "streamable-http", url: "https://example.invalid/mcp" },
      },
    }));

    const built = await buildProject({ ...options, dryRun: true });
    expect(built.report.targets.claude?.project?.components["agent-plugin.mcp.streamable-http"]).toEqual({
      support: "exact", discovered: 2, emitted: 1, skipped: 1,
    });
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect(synced.diagnostics).toContainEqual(expect.objectContaining({
      code: "HN205", severity: "warn", component: "agent-plugin.mcp.streamable-http",
      message: expect.stringContaining("literal environment references"),
    }));
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["literal"]);
  });
  it("applies independent target MCP arguments, cwd, and timeout translations", async () => {
    const { root, options } = await fixture({ components: {
      mcp: "./config/mcp.json",
      targets: ["codex", "opencode"],
      mcpOverrides: {
        codex: { startupTimeoutMs: 60_000, servers: { serena: { args: ["start-mcp-server", "--context", "codex"] } } },
        opencode: { servers: { serena: { args: ["start-mcp-server", "--context", "ide"], cwd: "${PLUGIN_ROOT}/..", startupTimeoutMs: 60_000 } } },
      },
    } });
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config/mcp.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: {
      serena: { type: "stdio", command: "uvx", args: ["start-mcp-server", "--context", "claude-code"], cwd: "${PLUGIN_ROOT}" },
    } }));
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    expect(JSON.parse(await readFile(join(root, ".hooknostic/artifacts/codex/mcp-servers.json"), "utf8")).servers[0]).toMatchObject({ args: ["start-mcp-server", "--context", "codex"] });
    expect(JSON.parse(await readFile(join(root, ".hooknostic/artifacts/opencode/mcp-servers.json"), "utf8")).servers[0]).toMatchObject({ args: ["start-mcp-server", "--context", "ide"], cwd: "${PLUGIN_ROOT}/.." });
    const codexServers = readProjectToml(await readFile(join(root, ".codex/config.toml"), "utf8")).mcp_servers as Record<string, { startup_timeout_sec: number }>;
    expect(codexServers.serena!.startup_timeout_sec).toBe(60);
    const componentPath = join(root, ".opencode/plugins/hooknostic-components.js");
    const plugin = await (await import(pathToFileURL(componentPath).href)).default();
    const opencodeConfig: { mcp?: Record<string, { timeout?: number }> } = {};
    plugin.config(opencodeConfig);
    expect(opencodeConfig.mcp?.serena?.timeout).toBe(60_000);
    expect(await readFile(join(root, "config/mcp.json"), "utf8")).toContain("claude-code");
  });
  it.each([
    ["unknown server", { codex: { servers: { missing: { args: [] } } } }, "unknown server"],
    ["remote argv", { codex: { servers: { remote: { args: [] } } } }, "only on a stdio server"],
    ["cwd outside project", { codex: { servers: { local: { cwd: "${PLUGIN_ROOT}/.." } } } }, "unsupported portable command or working-directory semantics"],
    ["unsupported timeout", { claude: { startupTimeoutMs: 1000 } }, "cannot represent project MCP startup timeouts"],
  ])("rejects invalid target MCP overrides: %s", async (_name, mcpOverrides, message) => {
    const { root, options } = await fixture({ components: { mcp: "./mcp.json", mcpOverrides } });
    await writeFile(join(root, "mcp.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: {
      local: { type: "stdio", command: "node" },
      remote: { type: "streamable-http", url: "https://example.invalid/mcp" },
    } }));
    expect((await runProject({ ...options, command: "sync" })).errors.join()).toContain(message);
  });
  it("launches Codex project MCP from nested directories and detects registration drift", async () => {
    const { root, config, options } = await fixture({ components: { mcp: "./sources/mcp.json", targets: ["codex"] } });
    await mkdir(join(root, "sources/worker"), { recursive: true });
    await mkdir(join(root, "nested/deeper"), { recursive: true });
    const program = "console.log(JSON.stringify({cwd:process.cwd(),root:process.env.PLUGIN_ROOT,data:process.env.PLUGIN_DATA,ref:process.env.REF,args:process.argv.slice(1)}))";
    await writeFile(join(root, "sources/mcp.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: {
      remote: { type: "streamable-http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "${UNCHANGED}" } },
      probe: { type: "stdio", command: "node", args: ["-e", program, "${PLUGIN_ROOT}/support.txt"], env: { REF: "${UNCHANGED}" }, cwd: "./worker" },
    } }));
    const synced = await runProject({ ...options, command: "sync" });
    expect(synced.errors).toEqual([]);
    const path = join(root, ".codex/config.toml");
    const before = await readFile(path, "utf8");
    const servers = readProjectToml(before).mcp_servers as Record<string, { args: string[]; env_http_headers: Record<string, string> }>;
    expect(servers.remote!.env_http_headers.Authorization).toBe("UNCHANGED");
    const execution = spawnSync(process.execPath, servers.probe!.args, { cwd: join(root, "nested/deeper"), env: { ...process.env, UNCHANGED: "runtime-reference" }, encoding: "utf8", timeout: 10000 });
    expect(execution.status, execution.stderr).toBe(0);
    expect(JSON.parse(execution.stdout)).toEqual({ cwd: join(root, "sources/worker"), root: join(root, "sources"), data: join(root, ".hooknostic/data"), ref: "runtime-reference", args: [join(root, "sources") + "/support.txt"] });
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
    };
    git(["init"]);
    git(["config", "core.autocrlf", "true"]);
    git(["add", "."]);
    git(["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Synthetic project MCP fixture"]);
    const linked = join(root, "linked-worktree");
    git(["worktree", "add", "--detach", linked, "HEAD"]);
    await mkdir(join(linked, "nested/deeper"), { recursive: true });
    await mkdir(join(linked, "sources/worker"), { recursive: true });
    const linkedRun = spawnSync(process.execPath, servers.probe!.args, { cwd: join(linked, "nested/deeper"), env: { ...process.env, UNCHANGED: "runtime-reference" }, encoding: "utf8", timeout: 10000 });
    expect(linkedRun.status, linkedRun.stderr).toBe(0);
    expect(JSON.parse(linkedRun.stdout).root).toBe(join(linked, "sources"));
    git(["worktree", "remove", "--force", linked]);
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
    await writeFile(path, before.replace("127.0.0.1:1", "127.0.0.1:2"));
    expect((await runProject({ ...options, command: "verify" })).errors.join()).toContain("modified");
    await writeFile(path, before);
    delete config.targets.codex;
    await writeFile(options.configPath, `export default ${JSON.stringify({ ...config, components: undefined })};`);
    expect((await runProject({ ...options, command: "sync" })).errors).toEqual([]);
    expect(readProjectToml(await readFile(path, "utf8")).mcp_servers).toBeUndefined();
  });
  it("removes a configured project target without disturbing the others", async () => {
    const { root, config, options } = await fixture();
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    delete config.targets.opencode;
    await writeFile(options.configPath, `export default ${JSON.stringify(config)};`);
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    await expect(readFile(join(root, ".opencode/plugins/hooknostic.js"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await runProject({ ...options, command: "verify" })).ok).toBe(true);
    expect(await readFile(join(root, ".codex/hooks.json"), "utf8")).toContain("PreToolUse");
  });
  it("rejects mutated native timeout values and runtimes during verification", async () => {
    const { root, options } = await fixture();
    expect((await runProject({ ...options, command: "sync" })).ok).toBe(true);
    const path = join(root, ".codex/hooks.json");
    const before = await readFile(path, "utf8");
    await writeFile(path, before.replace('"timeout": 5', '"timeout": 1'));
    expect((await runProject({ ...options, command: "verify" })).errors.join()).toContain("modified");
    await writeFile(path, before);
    await writeFile(join(root, ".hooknostic/artifacts/codex/.codex/hooknostic/hooknostic.mjs"), "tampered");
    expect((await runProject({ ...options, command: "verify" })).errors.join()).toContain("modified");
  });
  it("reports every explicitly degraded project MCP omission", async () => {
    const { root, config, options } = await fixture({ components: { mcp: "./mcp.json" } });
    await writeFile(join(root, "mcp.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { sample: { type: "sse", url: "http://127.0.0.1:1/sse" } } }));
    expect((await runProject({ ...options, command: "sync" })).errors.join()).toContain("SSE");
    await writeFile(options.configPath, `export default ${JSON.stringify({ ...config, components: { mcp: "./mcp.json", onUnsupported: "warn" } })};`);
    const result = await runProject({ ...options, command: "sync" });
    expect(result.errors).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ target: "codex", component: "agent-plugin.mcp.sse", severity: "warn" }));
    expect(await readFile(join(root, ".opencode/plugins/hooknostic-components.js"), "utf8")).toContain("127.0.0.1:1/sse");
  });
  it("keeps later project target verdicts independent after an earlier target fails", async () => {
    const codex = registry.codex!;
    const opencode = registry.opencode!;
    const { root, options } = await fixture({
      components: { mcp: "./mcp.json" },
      targets: {
        codex: { adapter: "codex", version: codex.harness.recommendedRange, delivery: "project", output: ".hooknostic/artifacts/codex" },
        opencode: { adapter: "opencode", version: opencode.harness.recommendedRange, delivery: "project", output: ".hooknostic/artifacts/opencode" },
      },
    });
    await writeFile(join(root, "mcp.json"), JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: { sample: { type: "sse", url: "http://127.0.0.1:1/sse" } },
    }));

    const result = await buildProject({ ...options, dryRun: true });

    expect(result.ok).toBe(false);
    expect(result.report.targets.codex?.status).toBe("failed");
    expect(result.report.targets.opencode?.status).toBe("success");
    expect(result.report.targets.opencode?.project?.components["agent-plugin.mcp.sse"]).toEqual({
      support: "exact", discovered: 1, emitted: 1, skipped: 0,
    });
    await expect(readFile(join(root, ".hooknostic/artifacts/opencode/.opencode/plugins/hooknostic-components.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("resolves a nested configuration relative to its declared project root", async () => {
    const { root, config, options } = await fixture();
    await mkdir(join(root, "configuration"));
    const configPath = join(root, "configuration/config.ts");
    await writeFile(configPath, `export default ${JSON.stringify({ ...config, project: { root: ".." }, entry: "../hooks.ts", targets: Object.fromEntries(Object.entries(config.targets).map(([id, target]) => [id, { ...target, output: "../" + target.output }])) })};`);
    const result = await runProject({ ...options, configPath, command: "sync" });
    expect(result.errors).toEqual([]);
    expect(await readFile(join(root, ".hooknostic/integration.json"), "utf8")).toContain("configuration/config.ts");
  });
  it("build generates artifacts without changing project discovery files", async () => {
    const { root, options } = await fixture();
    expect((await buildProject(options)).ok).toBe(true);
    await expect(readFile(join(root, ".codex/hooks.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
