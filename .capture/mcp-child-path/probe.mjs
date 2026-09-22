import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const captureRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(captureRoot, "../..");
const probeRoot = join(captureRoot, "probe");
const recordPath = join(tmpdir(), "hooknostic-path-recorder.jsonl");
const marker = "synthetic-marker";
const variants = ["undeclared", "declared"];
const shellFor = (command) => process.platform === "win32" && !command.toLowerCase().endsWith(".exe");

// The capture's assertion only needs platform process state and the synthetic
// marker below.  Start from a small allowlist rather than trying to recognize
// every spelling a credential-bearing variable might have.
const captureEnvironmentNames = new Set([
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

function captureEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => captureEnvironmentNames.has(key.toUpperCase())),
  );
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    shell: shellFor(command),
    input: options.input,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  return result;
}

function version(command) {
  return checked(command, ["--version"], { env: captureEnvironment() }).stdout.trim();
}

function buildVariants() {
  for (const variant of variants) {
    checked("node", ["packages/cli/bin/hooknostic.mjs", "build", "--config", join(probeRoot, "hooknostic.config.ts")], {
      env: {
        ...process.env,
        HOOKNOSTIC_CAPTURE_DECLARE_ENVIRONMENT: variant === "declared" ? "1" : "0",
      },
    });
  }
}

function readObservation() {
  assert.ok(existsSync(recordPath), `MCP child wrote no record to ${recordPath}`);
  const lines = readFileSync(recordPath, "utf8").trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1));
}

function runRecorded(action) {
  rmSync(recordPath, { force: true });
  action();
  return readObservation();
}

function summarize(harness, harnessVersion, variant, observed) {
  return {
    harness,
    version: harnessVersion,
    variant,
    syntheticMarker: observed.syntheticMarker,
    envKeyCount: observed.envKeyCount,
  };
}

function captureClaude(results, scratch) {
  const harnessVersion = version("claude");
  for (const variant of variants) {
    const plugin = join(probeRoot, "dist", variant, "claude");
    const configDir = join(scratch, `claude-${variant}`);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        customApiKeyResponses: { approved: ["hooknostic-playback"], rejected: [] },
      }),
    );
    const observed = runRecorded(() => {
      checked("claude", ["--plugin-dir", plugin, "mcp", "list"], {
        env: {
          ...captureEnvironment(),
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          SYNTHETIC_MARKER: marker,
        },
      });
    });
    results.push(summarize("claude", harnessVersion, variant, observed));
  }
}

function captureOpenCode(results, scratch) {
  const harnessVersion = version("opencode");
  for (const variant of variants) {
    const project = join(scratch, `opencode-${variant}`);
    const xdgConfig = join(project, "xdg-config");
    const xdgCache = join(project, "xdg-cache");
    mkdirSync(project, { recursive: true });
    mkdirSync(xdgConfig, { recursive: true });
    mkdirSync(xdgCache, { recursive: true });
    writeFileSync(
      join(project, "opencode.json"),
      `${JSON.stringify({ plugin: [join(probeRoot, "dist", variant, "opencode")] }, null, 2)}\n`,
    );
    const observed = runRecorded(() => {
      checked("opencode", ["mcp", "list"], {
        cwd: project,
        env: {
          ...captureEnvironment(),
          SYNTHETIC_MARKER: marker,
          XDG_CONFIG_HOME: xdgConfig,
          XDG_CACHE_HOME: xdgCache,
        },
      });
    });
    results.push(summarize("opencode", harnessVersion, variant, observed));
  }
}

function asyncRun(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: shellFor(command),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timeout = setTimeout(() => {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
      reject(new Error(`${command} exceeded ${options.timeout}ms`));
    }, options.timeout);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

async function captureCodex(results, scratch, command, loopbackBase) {
  const harnessVersion = version(command);
  for (const variant of variants) {
    const caseRoot = join(scratch, `codex-${harnessVersion.replaceAll(/[^A-Za-z0-9.-]/g, "-")}-${variant}`);
    const project = join(caseRoot, "project");
    const home = join(caseRoot, "home");
    const market = join(caseRoot, "market");
    const plugin = join(market, "plugins", "path-recorder");
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
    cpSync(join(probeRoot, "dist", variant, "codex"), plugin, { recursive: true });
    writeFileSync(
      join(market, ".agents", "plugins", "marketplace.json"),
      `${JSON.stringify(
        {
          name: "path-probe-market",
          plugins: [{ name: "path-recorder", source: { source: "local", path: "./plugins/path-recorder" } }],
        },
        null,
        2,
      )}\n`,
    );
    checked("git", ["init"], { cwd: project });
    writeFileSync(
      join(home, "config.toml"),
      `model = "synthetic"\nmodel_provider = "synthetic"\n[model_providers.synthetic]\nname = "Synthetic loopback"\nbase_url = "${loopbackBase}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n[windows]\nsandbox = "unelevated"\n`,
    );
    const env = captureEnvironment();
    Object.assign(env, { CODEX_HOME: home, SYNTHETIC_MARKER: marker });
    checked(command, ["plugin", "marketplace", "add", market], { cwd: project, env });
    checked(command, ["plugin", "add", "path-recorder@path-probe-market"], { cwd: project, env });
    rmSync(recordPath, { force: true });
    const execution = await asyncRun(
      command,
      ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-"],
      { cwd: project, env, input: "Synthetic packaged MCP environment probe.\n", timeout: 40_000 },
    );
    assert.ok(execution.stderr.includes("503"), `Codex did not reach the loopback model: ${execution.stderr}`);
    const observed = readObservation();
    results.push({
      ...summarize("codex", harnessVersion, variant, observed),
      loopbackModelFailure: true,
    });
  }
}

function codexCommands() {
  const commands = ["codex"];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index - 1] !== "--codex") continue;
    const candidate = process.argv[index];
    if (!candidate || (!isAbsolute(candidate) && candidate !== "codex")) {
      throw new Error("--codex requires an absolute binary path or 'codex'");
    }
    if (!commands.includes(candidate)) commands.push(candidate);
  }
  return commands;
}

const scratch = mkdtempSync(join(tmpdir(), "hooknostic-mcp-environment-"));
const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ path: request.url, method: body ? JSON.parse(body).method : undefined });
  response.writeHead(503);
  response.end();
});

try {
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const base = `http://127.0.0.1:${server.address().port}`;
  buildVariants();
  const results = [];
  captureClaude(results, scratch);
  captureOpenCode(results, scratch);
  for (const command of codexCommands()) await captureCodex(results, scratch, command, base);

  for (const result of results) {
    const expectedMarker = result.harness !== "codex" || result.variant === "declared" ? marker : null;
    assert.equal(
      result.syntheticMarker,
      expectedMarker,
      `${result.harness} ${result.version} ${result.variant} marker mismatch`,
    );
  }
  const output = {
    capturedOn: localDate(),
    platform: process.platform,
    cases: results,
  };
  writeFileSync(join(captureRoot, "environment-observations.json"), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  rmSync(recordPath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
