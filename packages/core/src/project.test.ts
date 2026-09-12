import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readProjectToml } from "./project-toml.js";
import { runProject } from "./project.js";
import { buildProject } from "./build.js";
import { defaultAdapterRegistry } from "../../cli/src/registry.js";
import { AGENT_PLUGIN_MCP_SCHEMA } from "@hooknostic/agent-plugin";
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
    const codex = JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8"));
    expect(codex.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
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
    const { root, options } = await fixture({ components: { skills: ["./skills"] } });
    await mkdir(join(root, "skills/sample/references"), { recursive: true });
    await writeFile(join(root, "skills/sample/SKILL.md"), "---\nname: sample\ndescription: Synthetic skill\n---\nRead references/note.md.\n");
    await writeFile(join(root, "skills/sample/references/note.md"), "resource\n");
    const synced = await runProject({ ...options, command: "sync" }); expect(synced.errors).toEqual([]);
    expect(await readFile(join(root, ".claude/skills/sample/references/note.md"), "utf8")).toBe("resource\n");
    expect(await readFile(join(root, ".agents/skills/sample/SKILL.md"), "utf8")).toContain("Synthetic skill");
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
