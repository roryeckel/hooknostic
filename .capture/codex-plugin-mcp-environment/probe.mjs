import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const scratch = mkdtempSync(join(tmpdir(), "hooknostic plugin mcp env "));
const project = join(scratch, "project");
const home = join(scratch, "home");
const market = join(scratch, "market");
const plugin = join(market, "plugins", "probe-plugin");
mkdirSync(project, { recursive: true });
mkdirSync(home);
mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
mkdirSync(join(plugin, ".codex-plugin"), { recursive: true });
// The marker is set in Codex's own environment. Nothing here reads a real
// credential: the probe asks only whether a named variable crosses the boundary.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|ANTHROPIC|OPENAI|CODEX_HOME/i.test(key)),
);
Object.assign(env, { CODEX_HOME: home, SYNTHETIC_MARKER: "synthetic-marker" });
const requests = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const message = body ? JSON.parse(body) : {};
  requests.push({ path: req.url, rpc: message.method });
  res.writeHead(503);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const marker = join(scratch, "marker.json");
const dump = join(plugin, "dump.mjs");
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: project,
      env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
      reject(new Error("Synthetic session exceeded 40 seconds"));
    }, 40000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, loopbackModelFailure: stderr.includes("503") });
    });
    child.stdin.end("Synthetic plugin MCP environment probe.\n");
  });

// A server that records the NAMES it was given, plus whether the marker arrived.
writeFileSync(
  dump,
  `import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  names: Object.keys(process.env).sort(),
  marker: process.env.SYNTHETIC_MARKER ?? null,
  literal: process.env.LITERAL_REF ?? null,
}));
setTimeout(() => {}, 1000);
`,
);
writeFileSync(
  join(plugin, ".codex-plugin", "plugin.json"),
  JSON.stringify({ name: "probe-plugin", version: "0.0.1", description: "Synthetic plugin MCP environment probe." }, null, 2),
);
writeFileSync(
  join(market, ".agents", "plugins", "marketplace.json"),
  JSON.stringify(
    {
      name: "probe-market",
      plugins: [{ name: "probe-plugin", source: { source: "local", path: "./plugins/probe-plugin" } }],
    },
    null,
    2,
  ),
);
const mcpDocument = (declare) => ({
  mcpServers: {
    probe: {
      command: process.execPath,
      args: ["./dump.mjs"],
      cwd: ".",
      env: { CAPTURE_PATH: marker, LITERAL_REF: "${SYNTHETIC_MARKER}" },
      ...(declare ? { env_vars: ["SYNTHETIC_MARKER"] } : {}),
    },
  },
});
const results = { version: null, cases: {} };
try {
  spawnSync("git", ["init"], { cwd: project, shell: process.platform === "win32" });
  const version = spawnSync("codex", ["--version"], { env, shell: process.platform === "win32", encoding: "utf8" });
  results.version = version.stdout.trim();
  writeFileSync(
    join(home, "config.toml"),
    `model = "synthetic"\nmodel_provider = "synthetic"\n[model_providers.synthetic]\nname = "Synthetic loopback"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
  );
  for (const declare of [false, true]) {
    writeFileSync(join(plugin, ".mcp.json"), JSON.stringify(mcpDocument(declare), null, 2));
    // Reinstall so the cache copy carries the case under test.
    spawnSync("codex", ["plugin", "remove", "probe-plugin"], { cwd: project, env, shell: process.platform === "win32" });
    // Quoted: the scratch path contains spaces and `shell` concatenates argv.
    spawnSync("codex", ["plugin", "marketplace", "add", JSON.stringify(market)], {
      cwd: project,
      env,
      shell: process.platform === "win32",
    });
    const install = spawnSync("codex", ["plugin", "add", "probe-plugin@probe-market"], {
      cwd: project,
      env,
      shell: process.platform === "win32",
      encoding: "utf8",
    });
    assert.equal(install.status, 0, `plugin install failed: ${install.stdout}${install.stderr}`);
    if (existsSync(marker)) rmSync(marker);
    const execution = await run(["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-"]);
    assert.ok(existsSync(marker), `plugin stdio server must start: ${JSON.stringify(execution)}`);
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    results.cases[declare ? "declaredEnvVar" : "undeclaredEnvVar"] = { execution, observed };
    rmSync(marker);
  }
  // The whole point: the same variable, same environment, one declaration apart.
  assert.equal(results.cases.undeclaredEnvVar.observed.marker, null);
  assert.equal(results.cases.declaredEnvVar.observed.marker, "synthetic-marker");
  // `env` is copied verbatim; Codex performs no reference expansion of its own.
  assert.equal(results.cases.declaredEnvVar.observed.literal, "${SYNTHETIC_MARKER}");
  const sanitize = (value) =>
    JSON.stringify(value, null, 2).split(JSON.stringify(scratch).slice(1, -1)).join("<scratch>");
  writeFileSync(new URL("observations.json", import.meta.url), sanitize(results) + "\n");
  console.log(sanitize(results));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
