// Model-free shape probes for a host layer's disabled MCP server (issue #150).
//
// `shape [content|file]` runs a v2 `serve`, lets the probe plugin record its MCP
// editor, and reads `/api/mcp`. `v1` runs `debug config` on the 1.18 reference
// build with a probe plugin in the project's `.opencode/plugins`. Neither path
// sends a model request: no `run` and no TUI is ever started.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const what = process.argv[2] ?? "shape";
const layer = process.argv[3] ?? "content";
const binary = process.env.HKN_OPENCODE_BINARY ?? "opencode";
const artifactDir = process.env.HKN_CAPTURE_ARTIFACT_DIR ?? tmpdir();
const root = await mkdtemp(join(await realpath(artifactDir), "hooknostic-disabled-mcp-"));
await mkdir(root, { recursive: true });
console.log(JSON.stringify({ root, what, layer, binary, version: version() }));

function version() {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 60000 });
  return result.stdout?.trim() || result.stderr?.trim() || String(result.status);
}

/** Drops every inherited name that could reach a model, a hosted service or the host's own OpenCode state. */
function isolatedEnv(extra) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^OPENCODE/.test(name) || /API_KEY|AUTH_TOKEN|SECRET|TOKEN/.test(name)) delete env[name];
  }
  for (const name of ["AI_PAT", "EXA_API_KEY", "STRIPE_DEV_SECRET_KEY"]) delete env[name];
  return { ...env, ...extra };
}

function state(root) {
  return {
    home: join(root, "home"),
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    state: join(root, "state"),
  };
}

async function isolated(root, project, extra) {
  const dirs = state(root);
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  return isolatedEnv({
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    // XDG_CONFIG_HOME alone did not redirect OpenCode's own config root in the
    // probe recorded in ../opencode-npm-publish/README.md.
    OPENCODE_CONFIG_DIR: join(dirs.config, "opencode"),
    PWD: project,
    ...extra,
  });
}

function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  child.kill();
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

const hostServers = {
  remoteEnabled: { type: "remote", url: "http://127.0.0.1:9/host-remote-enabled", enabled: true },
  remoteDisabled: { type: "remote", url: "http://127.0.0.1:9/host-remote-disabled", enabled: false },
  localEnabled: { type: "local", command: [process.execPath, "-e", "process.exit(0)"], enabled: true },
  localDisabled: { type: "local", command: [process.execPath, "-e", "process.exit(0)"], enabled: false },
};
const hostConfig = JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: hostServers });

async function shape() {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await writeFile(
    join(project, ".opencode/plugins/editor-probe.js"),
    await readFile(new URL("editor-probe.js", import.meta.url)),
  );
  const trace = join(root, "trace.jsonl");
  const env = await isolated(root, project, { HKN_EDITOR_TRACE: trace });
  if (layer === "content") {
    env.OPENCODE_CONFIG_CONTENT = hostConfig;
  } else {
    await mkdir(join(root, "config/opencode"), { recursive: true });
    await writeFile(join(root, "config/opencode/opencode.json"), hostConfig);
  }
  const port = 47800 + Math.floor(Math.random() * 180);
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const password = await waitFor(
    () => output.match(/server password (\S+)/)?.[1],
    60000,
    () => child.exitCode !== null,
  );
  let api = { error: "no server password" };
  try {
    if (password) {
      const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
      const query = `?location[directory]=${encodeURIComponent(project)}`;
      const get = async (path) => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}${path}${query}`, { headers: { authorization } });
          return { status: response.status, body: await response.text() };
        } catch (error) {
          return { error: String(error?.message ?? error) };
        }
      };
      // The plugin domain boots asynchronously: a request made before it settles
      // returns an empty list and the probe never runs, so a later request is
      // the one that observes anything.
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !(await lines(trace)).length) {
        await get("/api/mcp");
        if (!(await lines(trace)).length) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      api = {};
      for (const path of ["/api/mcp", "/api/plugin"]) api[path] = await get(path);
    }
  } finally {
    killTree(child);
  }
  console.log(JSON.stringify({ api, trace: await lines(trace), output: output.slice(-2000) }, null, 2));
  if (!password) throw new Error("serve printed no password");
}

async function v1() {
  const controls = [
    { name: "content-disabled", content: false },
    { name: "content-enabled", content: true },
    { name: "content-disabled-project-enabled", content: false, project: true },
    { name: "project-disabled", project: false },
    { name: "none" },
  ];
  const report = [];
  for (const control of controls) {
    const controlRoot = join(root, control.name);
    const project = join(controlRoot, "project");
    await mkdir(join(project, ".opencode/plugins"), { recursive: true });
    await writeFile(
      join(project, ".opencode/plugins/config-probe.js"),
      await readFile(new URL("v1-config-probe.js", import.meta.url)),
    );
    if (control.project !== undefined) {
      const enabled = control.project;
      await writeFile(
        join(project, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            probe: {
              type: "remote",
              url: `http://127.0.0.1:9/project-${enabled ? "enabled" : "disabled"}`,
              enabled,
            },
          },
        }),
      );
    }
    const trace = join(project, "trace.jsonl");
    const env = await isolated(controlRoot, project, { HKN_V1_TRACE: trace });
    if (control.content !== undefined) {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          probe: {
            type: "remote",
            url: `http://127.0.0.1:9/host-${control.content ? "enabled" : "disabled"}`,
            enabled: control.content,
          },
        },
      });
    }
    const result = spawnSync(binary, ["debug", "config"], {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 120000,
    });
    report.push({
      control: control.name,
      status: result.status,
      hook: await lines(trace),
      resolved: resolved(result.stdout ?? ""),
      stderr: (result.stderr ?? "").slice(-800),
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

/** The debug dump is JSON on 1.18; keep only the MCP section so the record stays readable. */
function resolved(stdout) {
  try {
    const config = JSON.parse(stdout);
    return { mcp: config.mcp ?? null, keys: Object.keys(config) };
  } catch {
    return { raw: stdout.slice(0, 2000) };
  }
}

async function lines(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(read, timeoutMs, failed) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    if (failed?.()) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

if (what === "v1") await v1();
else await shape();
