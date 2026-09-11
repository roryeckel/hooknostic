import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { projectMcpBootstrap } from "./project-mcp-bootstrap.js";
import { fileHash } from "./project-files.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const output = "generated tools/codex";
const config = "sources/hooknostic.config.ts";
const launcher = 'console.log(JSON.stringify({here:import.meta.url,index:process.argv[2]}));';
async function tree() {
  const root = await mkdtemp(join(tmpdir(), "hooknostic bootstrap "));
  roots.push(root);
  await mkdir(join(root, output), { recursive: true });
  await mkdir(join(root, ".hooknostic"));
  await mkdir(join(root, "nested/deeper"), { recursive: true });
  await writeFile(join(root, output, "mcp-launcher.mjs"), launcher);
  await writeFile(join(root, output, "mcp-servers.json"), "{}");
  await writeFile(join(root, ".hooknostic/integration.json"), JSON.stringify({ schemaVersion: 1, config, owned: [
    { path: `${output}/mcp-launcher.mjs`, hash: fileHash(launcher) },
    { path: `${output}/mcp-servers.json`, hash: fileHash("{}") },
  ] }));
  return root;
}
function run(root: string, owner = config) {
  return spawnSync(process.execPath, projectMcpBootstrap(output, owner, 3), { cwd: join(root, "nested/deeper"), encoding: "utf8", timeout: 10000 });
}
it("locates an owned launcher from nested invocation with path spaces and a worktree git file", async () => {
  const root = await tree();
  await writeFile(join(root, ".git"), "gitdir: ../synthetic-worktree-metadata");
  const result = run(root);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).index).toBe("3");
  expect(decodeURI(JSON.parse(result.stdout).here)).toContain("generated tools/codex/mcp-launcher.mjs");
  expect(projectMcpBootstrap(output, config, 3).join(" ")).not.toContain(root);
});
it("does not climb through another integration owner", async () => {
  const root = await tree();
  await mkdir(join(root, "nested/.hooknostic"));
  await writeFile(join(root, "nested/.hooknostic/integration.json"), JSON.stringify({ schemaVersion: 1, config: "another.ts", owned: [] }));
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("another configuration");
});
it.each(["mcp-launcher.mjs", "mcp-servers.json"])("refuses modified owned %s", async file => {
  const root = await tree();
  await writeFile(join(root, output, file), "modified");
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("modified owned file");
});
it("refuses a symlinked generated directory", async () => {
  const root = await tree();
  const other = await tree();
  await rm(join(root, output), { recursive: true });
  await symlink(join(other, output), join(root, output), process.platform === "win32" ? "junction" : "dir");
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("symlinked generated path");
});
it("rejects escaping compiler inputs", () => {
  expect(() => projectMcpBootstrap("../outside", config, 0)).toThrow("bootstrap path");
  expect(() => projectMcpBootstrap(output, "/absolute", 0)).toThrow("bootstrap path");
  expect(() => projectMcpBootstrap(output, config, -1)).toThrow("server index");
});
