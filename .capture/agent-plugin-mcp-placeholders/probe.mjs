import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const captureRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(captureRoot, "../..");
const crossSpawn = createRequire(join(repoRoot, "packages/core/package.json"))("cross-spawn");
const recordPath = join(tmpdir(), "hooknostic-mcp-placeholder-recorder.jsonl");

const ambient = {
  SYNTHETIC_COMMAND: "expanded-command",
  SYNTHETIC_CWD: "expanded-cwd",
  SYNTHETIC_MARKER: "expanded-marker",
  SYNTHETIC_REMOTE_PATH: "expanded-path",
  SYNTHETIC_REMOTE_HEADER: "expanded-header",
  PLUGIN_ROOT: "ambient-plugin-root",
  PLUGIN_DATA: "ambient-plugin-data",
};

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
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => captureEnvironmentNames.has(key.toUpperCase()))),
    ...ambient,
  };
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function checked(command, args, options = {}) {
  const result = crossSpawn.sync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 90_000,
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

function asyncRun(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = crossSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
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

function writeProbeSource(root, remoteBase) {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "${SYNTHETIC_CWD}"), { recursive: true });
  mkdirSync(join(root, ambient.SYNTHETIC_CWD), { recursive: true });
  writeFileSync(join(root, "${SYNTHETIC_CWD}", ".keep"), "literal cwd\n");
  writeFileSync(join(root, ambient.SYNTHETIC_CWD, ".keep"), "expanded cwd\n");
  writeFileSync(
    join(root, "plugin.json"),
    `${JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "placeholder-probe",
        version: "1.0.0",
        description: "Synthetic MCP placeholder capture",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "mcp.json"),
    `${JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          recorder: {
            type: "stdio",
            command: "./literal-command.cmd",
            args: ["${PLUGIN_ROOT}", "${PLUGIN_DATA}", "${SYNTHETIC_MARKER}", "${HOOKNOSTIC_UNSET}"],
            env: {
              RESERVED_ROOT: "${PLUGIN_ROOT}",
              RESERVED_DATA: "${PLUGIN_DATA}",
              KNOWN_REFERENCE: "${SYNTHETIC_MARKER}",
              UNKNOWN_REFERENCE: "${HOOKNOSTIC_UNSET}",
            },
            cwd: "./${SYNTHETIC_CWD}",
          },
          remoteKnown: {
            type: "streamable-http",
            url: `${remoteBase}/known/\${SYNTHETIC_REMOTE_PATH}`,
            headers: { Authorization: "Bearer ${SYNTHETIC_REMOTE_HEADER}" },
          },
          remoteReserved: {
            type: "streamable-http",
            url: `${remoteBase}/reserved/\${PLUGIN_ROOT}`,
            headers: { Authorization: "Bearer ${PLUGIN_DATA}" },
          },
          remoteUnknown: {
            type: "streamable-http",
            url: `${remoteBase}/unknown/\${HOOKNOSTIC_UNSET}`,
            headers: { Authorization: "Bearer ${HOOKNOSTIC_UNSET}" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const recorder = `import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
const OUT = join(tmpdir(), "hooknostic-mcp-placeholder-recorder.jsonl");
appendFileSync(OUT, JSON.stringify({
  at: new Date().toISOString(),
  commandLabel: process.argv[2],
  args: process.argv.slice(3),
  cwd: basename(process.cwd()),
  env: Object.fromEntries(["PLUGIN_ROOT", "PLUGIN_DATA", "RESERVED_ROOT", "RESERVED_DATA", "KNOWN_REFERENCE", "UNKNOWN_REFERENCE"].map((name) => [name, process.env[name] ?? null])),
}) + "\\n", "utf8");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    const result = message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "placeholder-recorder", version: "1.0.0" } }
      : message.method === "tools/list" ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`;
  writeFileSync(join(root, "record.mjs"), recorder);
  writeFileSync(
    join(root, "literal-command.cmd"),
    '@echo off\r\nnode "%~dp0record.mjs" literal-command %*\r\n',
  );
  writeFileSync(
    join(root, `${ambient.SYNTHETIC_COMMAND}.cmd`),
    '@echo off\r\nnode "%~dp0record.mjs" expanded-command %*\r\n',
  );
}

function buildProjectedPackage(scratch, remoteBase) {
  const source = join(scratch, "source");
  const output = join(scratch, "dist");
  writeProbeSource(source, remoteBase);
  const config = join(scratch, "hooknostic.config.mjs");
  writeFileSync(
    config,
    `export default ${JSON.stringify(
      {
        targets: {
          claude: { version: ">=2.1 <3", delivery: "package", output: join(output, "claude") },
          codex: { version: ">=0.153 <1", delivery: "package", output: join(output, "codex") },
          opencode: { version: ">=1.18 <2", delivery: "package", output: join(output, "opencode") },
        },
        components: {
          root: source,
          targets: ["claude", "codex", "opencode"],
          executableFiles: ["literal-command.cmd", `${ambient.SYNTHETIC_COMMAND}.cmd`],
          onUnsupported: "warn",
        },
      },
      null,
      2,
    )};\n`,
  );
  checked("node", ["packages/cli/bin/hooknostic.mjs", "build", "--config", config]);
  return output;
}

function nativeClaudeControl(projected, scratch, remoteBase) {
  const control = join(scratch, "claude-native-control");
  cpSync(projected, control, { recursive: true });
  writeFileSync(
    join(control, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          recorder: {
            type: "stdio",
            command: "${CLAUDE_PLUGIN_ROOT}/${SYNTHETIC_COMMAND}.cmd",
            args: [
              "${CLAUDE_PLUGIN_ROOT}",
              "${CLAUDE_PLUGIN_DATA}",
              "${SYNTHETIC_MARKER}",
              "${HOOKNOSTIC_UNSET}",
            ],
            env: {
              PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}",
              PLUGIN_DATA: "${CLAUDE_PLUGIN_DATA}",
              RESERVED_ROOT: "${CLAUDE_PLUGIN_ROOT}",
              RESERVED_DATA: "${CLAUDE_PLUGIN_DATA}",
              KNOWN_REFERENCE: "${SYNTHETIC_MARKER}",
              UNKNOWN_REFERENCE: "${HOOKNOSTIC_UNSET}",
            },
            cwd: "${CLAUDE_PLUGIN_ROOT}/${SYNTHETIC_CWD}",
          },
          remoteKnown: {
            type: "http",
            url: `${remoteBase}/known/\${SYNTHETIC_REMOTE_PATH}`,
            headers: { Authorization: "Bearer ${SYNTHETIC_REMOTE_HEADER}" },
          },
          remoteReserved: {
            type: "http",
            url: `${remoteBase}/reserved/\${PLUGIN_ROOT}`,
            headers: { Authorization: "Bearer ${PLUGIN_DATA}" },
          },
          remoteUnknown: {
            type: "http",
            url: `${remoteBase}/unknown/\${HOOKNOSTIC_UNSET}`,
            headers: { Authorization: "Bearer ${HOOKNOSTIC_UNSET}" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return control;
}

function readChildRecord() {
  assert.ok(existsSync(recordPath), `MCP child wrote no record to ${recordPath}`);
  const lines = readFileSync(recordPath, "utf8").trim().split(/\r?\n/);
  const record = JSON.parse(lines.at(-1));
  delete record.at;
  const pluginRoot = record.env.PLUGIN_ROOT;
  const pluginData = record.env.PLUGIN_DATA;
  record.args = record.args.map((value) => {
    if (value === pluginRoot) return "<PLUGIN_ROOT>";
    if (value === pluginData) return "<PLUGIN_DATA>";
    return isAbsolute(value) ? "<ABSOLUTE_PATH>" : value;
  });
  for (const name of ["PLUGIN_ROOT", "RESERVED_ROOT"]) {
    if (isAbsolute(record.env[name] ?? "")) record.env[name] = "<PLUGIN_ROOT>";
  }
  for (const name of ["PLUGIN_DATA", "RESERVED_DATA"]) {
    if (isAbsolute(record.env[name] ?? "")) record.env[name] = "<PLUGIN_DATA>";
  }
  return record;
}

function summarizeRequests(requests) {
  const first = new Map();
  for (const request of requests) {
    const key = request.url?.split("/")[1];
    if (key && !first.has(key)) first.set(key, request);
  }
  return Object.fromEntries(
    ["known", "reserved", "unknown"].map((key) => {
      const request = first.get(key);
      return [key, request === undefined ? null : { url: request.url, authorization: request.authorization ?? null }];
    }),
  );
}

function resetCase(requests) {
  rmSync(recordPath, { force: true });
  requests.length = 0;
}

function captureClaude(results, requests, scratch, plugin, label) {
  resetCase(requests);
  const configDir = join(scratch, `claude-${label}`);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: ["hooknostic-playback"], rejected: [] } }),
  );
  checked("claude", ["--plugin-dir", plugin, "mcp", "list"], {
    env: {
      ...captureEnvironment(),
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    },
    timeout: 90_000,
  });
  results.push({ harness: label, version: version("claude"), child: readChildRecord(), remote: summarizeRequests(requests) });
}

function captureOpenCode(results, requests, scratch, plugin, modelBase) {
  resetCase(requests);
  const project = join(scratch, "opencode-project");
  const xdgConfig = join(project, "xdg-config");
  const xdgCache = join(project, "xdg-cache");
  mkdirSync(xdgConfig, { recursive: true });
  mkdirSync(xdgCache, { recursive: true });
  const home = join(project, "home");
  mkdirSync(home, { recursive: true });
  checked("git", ["init"], { cwd: project });
  writeFileSync(
    join(project, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "playback/hooknostic-playback",
        enabled_providers: ["playback"],
        plugin: [plugin],
        provider: {
          playback: {
            npm: "@ai-sdk/openai-compatible",
            name: "Hooknostic Playback",
            options: { baseURL: `${modelBase}/v1`, apiKey: "hooknostic-playback" },
            models: {
              "hooknostic-playback": {
                name: "Hooknostic Playback",
                limit: { context: 32768, output: 4096 },
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  checked("opencode", ["mcp", "list"], {
    cwd: project,
    env: {
      ...captureEnvironment(),
      HOME: home,
      PWD: project,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
    },
    timeout: 90_000,
  });
  results.push({
    harness: "opencode-projected",
    version: version("opencode"),
    child: readChildRecord(),
    remote: summarizeRequests(requests),
  });
}

async function captureCodex(results, requests, scratch, plugin, modelBase) {
  resetCase(requests);
  const project = join(scratch, "codex-project");
  const home = join(scratch, "codex-home");
  const market = join(scratch, "codex-market");
  const installed = join(market, "plugins", "placeholder-probe");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
  cpSync(plugin, installed, { recursive: true });
  writeFileSync(
    join(market, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "placeholder-probe-market",
        plugins: [{ name: "placeholder-probe", source: { source: "local", path: "./plugins/placeholder-probe" } }],
      },
      null,
      2,
    )}\n`,
  );
  checked("git", ["init"], { cwd: project });
  writeFileSync(
    join(home, "config.toml"),
    `model = "synthetic"\nmodel_provider = "synthetic"\n[model_providers.synthetic]\nname = "Synthetic loopback"\nbase_url = "${modelBase}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n[windows]\nsandbox = "unelevated"\n`,
  );
  const env = { ...captureEnvironment(), CODEX_HOME: home };
  checked("codex", ["plugin", "marketplace", "add", market], { cwd: project, env });
  checked("codex", ["plugin", "add", "placeholder-probe@placeholder-probe-market"], { cwd: project, env });
  const execution = await asyncRun(
    "codex",
    ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-"],
    { cwd: project, env, input: "Synthetic MCP placeholder probe.\n", timeout: 40_000 },
  );
  assert.ok(execution.stderr.includes("503"), `Codex did not reach the loopback model: ${execution.stderr}`);
  results.push({
    harness: "codex-projected",
    version: version("codex"),
    child: readChildRecord(),
    remote: summarizeRequests(requests),
  });
}

const scratch = mkdtempSync(join(tmpdir(), "hooknostic-mcp-placeholders-"));
const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.url?.startsWith("/v1/messages")) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const message = {
      id: "msg_placeholder_probe",
      type: "message",
      role: "assistant",
      model: "hooknostic-playback",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    for (const event of [
      { type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
    return;
  }
  if (request.url?.startsWith("/v1/chat/completions")) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const base = { id: "chatcmpl-placeholder-probe", object: "chat.completion.chunk", created: 0, model: "hooknostic-playback" };
    for (const event of [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
    return;
  }
  if (request.url?.startsWith("/v1/models") || request.url === "/models") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ object: "list", data: [{ id: "hooknostic-playback", object: "model", owned_by: "hooknostic" }] }));
    return;
  }
  if (request.url?.startsWith("/v1/")) {
    response.writeHead(503).end();
    return;
  }
  requests.push({ url: request.url, authorization: request.headers.authorization });
  const rpc = body === "" ? {} : JSON.parse(body);
  if (rpc.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const result =
    rpc.method === "initialize"
      ? {
          protocolVersion: rpc.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "placeholder-remote", version: "1.0.0" },
        }
      : rpc.method === "tools/list"
        ? { tools: [] }
        : {};
  response
    .writeHead(200, { "content-type": "application/json", "mcp-session-id": "placeholder-probe" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
});

try {
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const remoteBase = `http://127.0.0.1:${server.address().port}`;
  const output = buildProjectedPackage(scratch, remoteBase);
  const results = [];
  const claudeProjected = join(output, "claude");
  captureClaude(
    results,
    requests,
    scratch,
    nativeClaudeControl(claudeProjected, scratch, remoteBase),
    "claude-native-control",
  );
  captureClaude(results, requests, scratch, claudeProjected, "claude-projected");
  captureOpenCode(results, requests, scratch, join(output, "opencode"), remoteBase);
  await captureCodex(results, requests, scratch, join(output, "codex"), remoteBase);

  const byHarness = Object.fromEntries(results.map((result) => [result.harness, result]));
  assert.equal(byHarness["claude-native-control"].child.commandLabel, "expanded-command");
  assert.equal(byHarness["claude-native-control"].child.args[2], ambient.SYNTHETIC_MARKER);
  assert.equal(byHarness["claude-native-control"].child.env.KNOWN_REFERENCE, ambient.SYNTHETIC_MARKER);
  // The projection keeps Claude's native declaration, so the package's own
  // text reaches Claude's expansion; only the command is not package text.
  assert.equal(byHarness["claude-projected"].child.commandLabel, "literal-command");
  assert.equal(byHarness["claude-projected"].child.args[2], ambient.SYNTHETIC_MARKER);
  assert.equal(byHarness["claude-projected"].child.args[3], "${HOOKNOSTIC_UNSET}");
  assert.equal(byHarness["claude-projected"].child.cwd, ambient.SYNTHETIC_CWD);
  assert.equal(byHarness["claude-projected"].child.env.KNOWN_REFERENCE, ambient.SYNTHETIC_MARKER);
  for (const harness of ["opencode-projected", "codex-projected"]) {
    assert.equal(byHarness[harness].child.commandLabel, "literal-command");
    assert.equal(byHarness[harness].child.args[2], "${SYNTHETIC_MARKER}");
    assert.equal(byHarness[harness].child.cwd, "${SYNTHETIC_CWD}");
    assert.equal(byHarness[harness].child.env.KNOWN_REFERENCE, "${SYNTHETIC_MARKER}");
  }
  assert.deepEqual(byHarness["codex-projected"].remote, {
    known: {
      url: "/known/$%7BSYNTHETIC_REMOTE_PATH%7D",
      authorization: "Bearer ${SYNTHETIC_REMOTE_HEADER}",
    },
    reserved: { url: "/reserved/$%7BPLUGIN_ROOT%7D", authorization: "Bearer ${PLUGIN_DATA}" },
    unknown: { url: "/unknown/$%7BHOOKNOSTIC_UNSET%7D", authorization: "Bearer ${HOOKNOSTIC_UNSET}" },
  });

  const observation = { capturedOn: localDate(), platform: process.platform, cases: results };
  writeFileSync(join(captureRoot, "observations.json"), `${JSON.stringify(observation, null, 2)}\n`);
  console.log(JSON.stringify(observation, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  rmSync(recordPath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
