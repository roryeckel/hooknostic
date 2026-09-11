import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const scratch = mkdtempSync(join(tmpdir(), "hooknostic project mcp "));
const project = join(scratch, "project");
const home = join(scratch, "home");
mkdirSync(join(project, ".codex"), { recursive: true });
mkdirSync(join(project, "nested"));
mkdirSync(home);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|ANTHROPIC|OPENAI|CODEX_HOME/i.test(key)));
env.CODEX_HOME = home;
const run = (command, args, cwd = project) => {
  const result = spawnSync(command, args, { cwd, env, shell: process.platform === "win32", encoding: "utf8", timeout: 20000 });
  if (result.error) throw result.error;
  return { code: result.status, output: (() => { try { return JSON.parse(result.stdout); } catch { return result.stdout.trim(); } })(), temporaryHomeWarning: result.stderr.includes("Refusing to create helper binaries") };
};
const results = { version: run("codex", ["--version"]), cases: {} };
const shared = '[mcp_servers.shared]\ncommand = "home-command"\nargs = ["home-argument"]\n[mcp_servers.shared.env]\nHOME_ONLY = "home-marker"\n';
const trust = level => `[projects.${JSON.stringify(project)}]\ntrust_level = ${JSON.stringify(level)}\n`;
try {
  run("git", ["init"]);
  writeFileSync(join(project, ".codex/config.toml"), '# synthetic project\n[mcp_servers.local_probe]\ncommand = "node"\nargs = ["./server.mjs", "${UNCHANGED}"]\ncwd = "."\n[mcp_servers.local_probe.env]\nREF = "${UNCHANGED}"\n[mcp_servers.shared]\ncommand = "project-command"\n[mcp_servers.http_probe]\nurl = "http://127.0.0.1:1/mcp"\n[mcp_servers.http_probe.env_http_headers]\nAuthorization = "SYNTHETIC_TOKEN"\n');
  for (const level of ["missing", "untrusted", "trusted"]) {
    writeFileSync(join(home, "config.toml"), shared + (level === "missing" ? "" : trust(level)));
    results.cases[level] = run("codex", ["mcp", "list", "--json"]);
  }
  results.cases.nested = run("codex", ["mcp", "list", "--json"], join(project, "nested"));
  mkdirSync(join(project, "nested/.codex"));
  writeFileSync(join(project, "nested/.codex/config.toml"), '[mcp_servers.shared]\ncommand = "nested-command"\n');
  results.cases.nestedOverride = run("codex", ["mcp", "list", "--json"], join(project, "nested"));
  writeFileSync(join(project, ".codex/config.toml"), '[mcp_servers.sse_probe]\ntype = "sse"\nurl = "http://127.0.0.1:1/sse"\n');
  results.cases.explicitSse = run("codex", ["mcp", "list", "--json"]);
  const sanitized = JSON.stringify(results, null, 2).split(JSON.stringify(scratch).slice(1, -1)).join("<scratch>");
  writeFileSync(new URL("observations.json", import.meta.url), sanitized + "\n");
  console.log(sanitized);
} finally { rmSync(scratch, { recursive: true, force: true }); }
