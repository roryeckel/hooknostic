#!/usr/bin/env node
// No-spend check that the native sandbox can execute a Code Mode shell call.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { playbackModelInfo, startModelPlayback } = await import("../../packages/cli/test/harness-playback.ts");
const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = mkdtempSync(join(repo, ".capture/skill-directory/captured-execution-control-"));
const project = join(root, "project");
const home = join(root, "home");
mkdirSync(project); mkdirSync(home);
const marker = "control-marker.txt";
const server = await startModelPlayback("openai-responses", "rewrite", [
  { kind: "code", disposition: "rewrite", marker, codeArgs: { workdir: project, yield_time_ms: 1000 } },
  { kind: "text", text: "done" },
]);
const catalog = join(home, "catalog.json");
writeFileSync(catalog, JSON.stringify({ models: [playbackModelInfo({ tool_mode: "code_mode_only" })] }));
const packageJson = join(process.env.APPDATA, "npm/node_modules/@openai/codex/package.json");
const require = createRequire(packageJson);
const binary = join(dirname(require.resolve("@openai/codex-win32-x64/package.json")), "vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|^OPENAI_|^CODEX_/i.test(key)));
Object.assign(env, { CODEX_HOME: home, HOME: root, USERPROFILE: root, CODEX_MANAGED_PACKAGE_ROOT: dirname(packageJson), CODEX_MANAGED_BY_NPM: "1" });
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const sandbox = process.argv.includes("--unsandboxed") ? "danger-full-access" : "workspace-write";
const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox, "-c", 'windows.sandbox="unelevated"', "-c", 'approval_policy="never"', "-c", `model_catalog_json=${q(catalog)}`, "-c", 'model_provider="comparison_control"', "-c", `model_providers.comparison_control={name="Control",base_url=${q(server.baseUrl + "/v1")},wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`, "-m", "hooknostic-playback", "Run the control command."];
console.log(JSON.stringify({ root, phase: "started", model: "loopback", sandbox }));
try {
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      resolvePromise({ code: null, timedOut: true, stdout, stderr });
    }, 45000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.stdin.end();
  });
  writeFileSync(join(root, "result.json"), JSON.stringify({ ...result, markerExists: existsSync(join(project, marker)), requests: server.requests, errors: server.errors }, null, 2));
  console.log(JSON.stringify({ code: result.code, timedOut: result.timedOut, markerExists: existsSync(join(project, marker)), stdout: result.stdout, stderr: result.stderr, root }));
  if (result.code !== 0 || !existsSync(join(project, marker))) process.exitCode = 1;
  else console.log(readFileSync(join(project, marker), "utf8"));
} finally {
  await server.close();
}
