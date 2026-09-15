import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const scratch = mkdtempSync(join(tmpdir(), "hooknostic project startup "));
const project = join(scratch, "project");
const home = join(scratch, "home");
mkdirSync(join(project, ".codex"), { recursive: true });
mkdirSync(join(project, "nested"));
mkdirSync(home);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|ANTHROPIC|OPENAI|CODEX_HOME/i.test(key)));
Object.assign(env, { CODEX_HOME: home, SYNTHETIC_VALUE: "synthetic-value", SYNTHETIC_HEADER: "synthetic-header" });
const requests = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const message = body ? JSON.parse(body) : {};
  requests.push({ path: req.url, method: req.method, rpc: message.method, header: req.headers["x-synthetic"] });
  if (req.url !== "/mcp") { res.writeHead(503); res.end(); return; }
  if (message.id === undefined) { res.writeHead(202); res.end(); return; }
  const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1.0.0" } } : { tools: [] };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const run = args => new Promise((resolve, reject) => {
  const child = spawn("codex", args, { cwd: join(project, "nested"), env, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timeout = setTimeout(() => {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
    reject(new Error("Synthetic session exceeded 30 seconds"));
  }, 30000);
  child.on("error", error => { clearTimeout(timeout); reject(error); });
  child.on("close", code => { clearTimeout(timeout); resolve({ code, loopbackModelFailure: stderr.includes("503 Service Unavailable") }); });
  child.stdin.end("Synthetic MCP startup probe.\n");
});
const marker = join(scratch, "marker.json");
const fixture = join(scratch, "server.mjs");
const original = readFileSync(new URL("../../packages/cli/test/plugin-mcp-env-fixture.mjs", import.meta.url), "utf8");
writeFileSync(fixture, original.replace("cwd: process.cwd(),", "cwd: process.cwd(), ref: process.env.REF, forwarded: process.env.SYNTHETIC_VALUE,"));
spawnSync("git", ["init"], { cwd: project, shell: process.platform === "win32" });
const results = { cases: {} };
try {
  writeFileSync(join(home, "config.toml"), `model = "synthetic"\nmodel_provider = "synthetic"\n[model_providers.synthetic]\nname = "Synthetic loopback"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  for (const cwd of [null, "."]) {
    writeFileSync(join(project, ".codex/config.toml"), `[mcp_servers.stdio_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}, "\${SYNTHETIC_VALUE}"]\n${cwd === null ? "" : `cwd = ${JSON.stringify(cwd)}\n`}env_vars = ["SYNTHETIC_VALUE"]\n[mcp_servers.stdio_probe.env]\nCAPTURE_PATH = ${JSON.stringify(marker)}\nREF = "\${SYNTHETIC_VALUE}"\n[mcp_servers.http_probe]\nurl = "${base}/mcp"\n[mcp_servers.http_probe.env_http_headers]\nx-synthetic = "SYNTHETIC_HEADER"\n`);
    const before = requests.length;
    await run(["mcp", "list", "--json"]);
    const listRequests = requests.slice(before);
    assert.equal(existsSync(marker), false, "mcp list must not start stdio server");
    const execution = await run(["exec", "--skip-git-repo-check", "-"]);
    assert.ok(existsSync(marker), "stdio server must start: " + JSON.stringify(execution));
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.cwd, join(project, "nested"));
    assert.equal(observed.ref, "${SYNTHETIC_VALUE}");
    assert.equal(observed.forwarded, "synthetic-value");
    assert.deepEqual(observed.argv, ["${SYNTHETIC_VALUE}"]);
    assert.ok(requests.slice(before + listRequests.length).some(request => request.rpc === "tools/list" && request.header === "synthetic-header"));
    assert.equal(execution.loopbackModelFailure, true);
    results.cases[cwd === null ? "omittedCwd" : "dotCwd"] = { execution, observed, listRequests, requests: requests.slice(before + listRequests.length) };
    rmSync(marker);
  }
  // Same variable in the harness environment, but not listed in env_vars.
  writeFileSync(join(project, ".codex/config.toml"), `[mcp_servers.stdio_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\n[mcp_servers.stdio_probe.env]\nCAPTURE_PATH = ${JSON.stringify(marker)}\n`);
  const undeclared = await run(["exec", "--skip-git-repo-check", "-"]);
  assert.ok(existsSync(marker), "stdio server must start: " + JSON.stringify(undeclared));
  const undeclaredObserved = JSON.parse(readFileSync(marker, "utf8"));
  results.cases.undeclaredEnvVar = { execution: undeclared, observed: { forwarded: undeclaredObserved.forwarded ?? null } };
  rmSync(marker);
  const sanitize = value => JSON.stringify(value, null, 2).split(JSON.stringify(scratch).slice(1, -1)).join("<scratch>");
  writeFileSync(new URL("startup-observations.json", import.meta.url), sanitize(results) + "\n");
  console.log(sanitize(results));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
