#!/usr/bin/env node
// Can an OpenCode plugin show the USER a notice at session start that the
// MODEL never sees? Drives one build, one launch mode and one probe variant
// against the loopback playback model, then reports, per route code (see
// v1-plugin.js / v2-plugin.js), whether the nonce reached the user surface of
// that mode and whether any model request carried it.
//
//   HKN_OPENCODE_BINARY=<opencode.exe> \
//     node --experimental-strip-types .capture/opencode-notice/drive.mjs <v1|v2> <tui|attach|run|serve> [variant]
//   v1 variants: toast (default) | append | noreply
//   v2 variants: toast (default) | synthetic
//
// The user surface per mode: tui = a headless xterm screen fed by node-pty,
// sampled every 150 ms (toasts are transient); run = stdout + stderr; serve =
// the server's event stream (what an attached client would receive). Writes
// .capture/opencode-notice/captured/<family>-<version>-<mode>-<variant>/ (git-ignored).
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { startModelPlayback, openCodePlaybackConfigHome, prepareOpenCodePluginDependency } = await import(
  pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href
);
const { withoutCredentials } = await import(pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href);
const requireCli = createRequire(join(REPO, "packages/cli/package.json"));

const [family, mode, variant = "toast"] = process.argv.slice(2);
if (!["v1", "v2"].includes(family) || !["tui", "attach", "run", "serve"].includes(mode)) {
  throw new Error("usage: drive.mjs <v1|v2> <tui|attach|run|serve> [variant]");
}
const ROUTES = {
  v1: { toast: ["IT", "DT", "CT", "CP"], append: ["CA"], noreply: ["CN"] },
  v2: { toast: ["IU", "IA", "IR", "CU", "CA", "CR"], synthetic: ["CS"] },
}[family][variant];
if (!ROUTES) throw new Error(`unknown ${family} variant ${variant}`);

const BINARY = process.env["HKN_OPENCODE_BINARY"] ?? "opencode";
const VERSION = execFileSync(BINARY, ["--version"], { encoding: "utf8" }).trim().replace(/^opencode v/, "");
if (!VERSION.startsWith(family === "v1" ? "1." : "2.")) throw new Error(`${BINARY} is ${VERSION}, not ${family}`);
const NOTICE = `HKN-NOTICE-${randomBytes(4).toString("hex")}`;
const MODEL_ID = "hooknostic-playback";
const PASSWORD = "hooknostic-notice";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const root = mkdtempSync(join(tmpdir(), "hkn-opencode-notice-"));
const project = join(root, "project");
mkdirSync(join(project, ".opencode", "plugins"), { recursive: true });
copyFileSync(new URL(`${family}-plugin.js`, import.meta.url), join(project, ".opencode", "plugins", "notice.js"));
const trace = join(root, "trace.jsonl");
writeFileSync(trace, "");

const model = await startModelPlayback("openai-chat", "rewrite", [{ kind: "text", text: "ready" }]);
const env = {};
for (const [name, value] of Object.entries(withoutCredentials())) {
  if (/^(CLAUDE|OPENCODE)/.test(name) || name === "AI_AGENT") continue;
  env[name] = value;
}
Object.assign(env, {
  PWD: project,
  HKN_NOTICE: NOTICE,
  HKN_NOTICE_VARIANT: variant,
  HKN_NOTICE_TRACE: trace,
  HKN_PLAYBACK_KEY: "hooknostic-playback",
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: PASSWORD,
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
});

// Every config pins a top-level model at the loopback: a v2 config without one
// silently falls back to OpenCode's hosted provider.
if (family === "v1") {
  execFileSync("git", ["init", "-q"], { cwd: project });
  env.XDG_CONFIG_HOME = openCodePlaybackConfigHome(project);
  await prepareOpenCodePluginDependency(project, VERSION);
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      // An update prompt would otherwise take the first typed Enter.
      autoupdate: false,
      model: `playback/${MODEL_ID}`,
      enabled_providers: ["playback"],
      provider: {
        playback: {
          npm: "@ai-sdk/openai-compatible",
          name: "Hooknostic Playback",
          options: { baseURL: `${model.baseUrl}/v1`, apiKey: "hooknostic-playback" },
          models: { [MODEL_ID]: { name: "Hooknostic Playback", limit: { context: 32_768, output: 4_096 } } },
        },
      },
    }),
  );
} else {
  Object.assign(env, { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config") });
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({
      model: `playback/${MODEL_ID}`,
      providers: {
        playback: {
          name: "Playback",
          env: ["HKN_PLAYBACK_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${model.baseUrl}/v1` },
          models: { [MODEL_ID]: { name: "Playback", limit: { context: 128000, output: 4096 } } },
        },
      },
    }),
  );
}

const seen = Object.fromEntries(ROUTES.map((code) => [code, null]));
let surface = "";
const compact = (text) => text.replace(/\s+/g, "");
function observe(text, where) {
  const flat = compact(text);
  for (const code of ROUTES) {
    const needle = `${NOTICE}-${code}`;
    if (seen[code] === null && flat.includes(needle)) {
      const line = text.split("\n").find((row) => compact(row).includes(needle)) ?? "";
      seen[code] = { where, at: Date.now(), line: line.trim().slice(0, 200) };
    }
  }
}

async function freePort() {
  return new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise((done) => spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("close", done));
  } else child.kill();
}

async function driveTui() {
  const pty = requireCli("node-pty");
  const { Terminal } = requireCli("@xterm/headless");
  const cols = 140;
  const rows = 45;
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  // attach: the TUI is a client of a separate `opencode serve`, as a remote
  // or second client would be. The server (and so plugin init) starts first.
  const server = mode === "attach" ? await startServer() : undefined;
  const args = server
    ? family === "v1"
      ? ["attach", server.url]
      : ["--server", server.url, "--auto"]
    : family === "v1"
      ? []
      : ["--standalone", "--auto"];
  const child = pty.spawn(BINARY, args, { name: "xterm-256color", cols, rows, cwd: project, env });
  let raw = "";
  let exited = false;
  child.onData((chunk) => {
    raw += chunk;
    term.write(chunk);
  });
  child.onExit(() => (exited = true));
  const screen = () => {
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n");
  };
  const frames = [];
  const sampler = setInterval(() => {
    const now = screen();
    if (frames.at(-1) !== now) frames.push(now);
    observe(now, "screen");
  }, 150);
  const type = async (text) => {
    for (const char of text) {
      child.write(char);
      await sleep(15);
    }
    await sleep(300);
    child.write("\r");
  };
  try {
    const until = async (predicate, ms) => {
      for (let waited = 0; waited < ms && !predicate(); waited += 100) await sleep(100);
      return predicate();
    };
    const ready = await until(() => /Ask anything|ctrl\+p|ctrl\+x/.test(screen()), 30_000);
    await sleep(4000);
    for (const text of ["Say ready.", "Again."]) {
      const before = model.requests.length;
      await type(text);
      await until(() => model.requests.length > before, 20_000);
      await sleep(12_000);
    }
    if (!ready) throw new Error("TUI input line never appeared");
  } finally {
    clearInterval(sampler);
    observe(screen(), "screen");
    surface = frames.join("\n\f\n");
    if (!exited) child.write("\x03");
    await sleep(1500);
    if (!exited) child.kill();
    if (server) await killTree(server.child);
  }
  observe(raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""), "raw-pty");
  return { exited, frames: frames.length };
}

async function driveRun() {
  const args = family === "v1" ? ["run", "Say ready."] : ["run", "--standalone", "--auto", "Say ready."];
  const child = spawn(BINARY, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const code = await Promise.race([new Promise((done) => child.on("close", done)), sleep(90_000).then(() => "timeout")]);
  await killTree(child);
  surface = `--- stdout\n${stdout}\n--- stderr\n${stderr}`;
  observe(stdout, "stdout");
  observe(stderr, "stderr");
  return { code };
}

async function startServer() {
  const port = await freePort();
  const child = spawn(BINARY, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const server = { child, url: `http://127.0.0.1:${port}`, logs: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => (server.logs += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (server.logs += chunk));
  const base = server.url + (family === "v2" ? "/api" : "");
  server.base = base;
  server.headers = {
    "content-type": "application/json",
    authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
    ...(family === "v2" ? { "x-opencode-directory": encodeURIComponent(project) } : {}),
  };
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(base + (family === "v1" ? "/app" : "/session"), { headers: server.headers })).ok) return server;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  await killTree(child);
  throw new Error(`serve never answered\n${server.logs}`);
}

async function driveServe() {
  const server = await startServer();
  const { child, base, headers } = server;
  const api = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${path} ${response.status} ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  };
  const stream = new AbortController();
  let events = "";
  try {
    void (async () => {
      try {
        const response = await fetch(`${base}/event`, { headers, signal: stream.signal });
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          events += decoder.decode(chunk, { stream: true });
          observe(events, "event-stream");
        }
      } catch (error) {
        if (!stream.signal.aborted) events += `\n[stream error] ${error}`;
      }
    })();
    await sleep(1000);
    let sessionID;
    if (family === "v1") {
      sessionID = (await api("/session", {})).id;
      for (const text of ["Say ready.", "Again."]) {
        await api(`/session/${sessionID}/message`, {
          model: { providerID: "playback", modelID: MODEL_ID },
          parts: [{ type: "text", text }],
        });
        await sleep(3000);
      }
    } else {
      const create = async () =>
        (
          await api("/session", {
            location: { directory: project },
            model: { id: MODEL_ID, providerID: "playback" },
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
          })
        ).data.id;
      // Plugin setup is lazy per location: on serve it ran only after the
      // first prompt, so every session created before then is missed (v2
      // profile). A prompted warm-up session absorbs that.
      const warmup = await create();
      const warm = model.requests.length;
      await api(`/session/${warmup}/prompt`, { text: "Warm up." });
      for (let i = 0; i < 150 && model.requests.length === warm; i += 1) await sleep(100);
      await sleep(4000);
      sessionID = await create();
      for (const text of ["Say ready.", "Again."]) {
        const before = model.requests.length;
        await api(`/session/${sessionID}/prompt`, { text });
        for (let i = 0; i < 150 && model.requests.length === before; i += 1) await sleep(100);
        await sleep(4000);
      }
    }
    return { sessionID };
  } finally {
    stream.abort();
    surface = `--- events\n${events}\n--- server logs\n${server.logs}`;
    observe(server.logs, "server-log");
    await killTree(child);
  }
}

const OUT = join(REPO, ".capture/opencode-notice/captured", `${family}-${VERSION}-${mode}-${variant}`);
let outcome;
let error;
try {
  outcome = await { tui: driveTui, attach: driveTui, run: driveRun, serve: driveServe }[mode]();
} catch (caught) {
  error = String(caught?.stack ?? caught);
} finally {
  await sleep(500);
  await model.close();
}
const calls = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const requestText = model.requests.map((body) => JSON.stringify(body));
const summary = {
  family,
  version: VERSION,
  mode,
  variant,
  nonce: NOTICE,
  date: new Date().toISOString().slice(0, 10),
  outcome,
  error,
  requests: model.requests.length,
  modelErrors: model.errors,
  noticeInAnyRequest: requestText.some((text) => text.includes(NOTICE)),
  routes: Object.fromEntries(
    ROUTES.map((code) => [
      code,
      {
        call: calls.find((row) => row.route === code) ?? null,
        shown: seen[code],
        inRequests: requestText.filter((text) => text.includes(`${NOTICE}-${code}`)).length,
      },
    ]),
  ),
  plugin: calls.filter((row) => row.phase !== undefined),
};
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "surface.txt"), surface, "utf8");
writeFileSync(join(OUT, "requests.json"), JSON.stringify(model.requests, null, 2), "utf8");
writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
if (summary.requests === 0) console.error("WARNING: no loopback request was recorded; the run proves nothing about the model");
rmSync(root, { recursive: true, force: true, maxRetries: 3 });
// A node-pty handle can keep the event loop alive after the child exits.
process.exit(0);
