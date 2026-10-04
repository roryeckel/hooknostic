#!/usr/bin/env node
// Evidence-only shell interpreter probe; model replies and argument values are scripted.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { describeTools, prepareOpenCodePluginDependency, runProcess, startModelPlayback } =
  await import("../../packages/cli/test/harness-playback.ts");
const { driveClaude, driveCodex, driveOpencode, prepareScratch, withoutCredentials, writeOpencodeConfig } =
  await import("../../scripts/drive-capture-session.mjs");

const harness = process.argv[2];
const protocols = { claude: "anthropic-messages", codex: "openai-responses", "opencode-v1": "openai-chat", "opencode-v2": "openai-chat" };
if (!Object.hasOwn(protocols, harness)) throw new Error("Specify claude, codex, opencode-v1, or opencode-v2");
if (process.platform !== "win32") throw new Error("This procedure is established only on Windows");
const captureRoot = resolve(repo, ".capture/shell-dialects/captured");
const out = resolve(captureRoot, harness);
if (dirname(out) !== captureRoot) throw new Error("Capture path must be a direct child of the output root");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const versionCommand = harness === "opencode-v2" ? process.env.HKN_OPENCODE_BINARY : harness.startsWith("opencode") ? "opencode" : harness;
const versionResult = await runProcess(versionCommand, ["--version"], { cwd: repo, env: withoutCredentials(), timeoutMs: 30000 });
if (versionResult.code !== 0) throw new Error("Version detection failed");
const version = versionResult.stdout.match(/\d+\.\d+\.\d+/)?.[0];
if (!version) throw new Error("No version in binary output");
writeFileSync(join(out, "metadata.json"), JSON.stringify({ harness, version, platform: process.platform, capturedAt: new Date().toISOString() }, null, 2) + "\n");
const prompt = "Execute the requested shell probe once, then stop.";
const command = "node interpreter.cjs; echo hooknostic-shell-finished";

async function session(label, script) {
  const root = mkdtempSync(join(tmpdir(), "hkn-shell-dialect-"));
  const scratch = join(root, "project");
  if (harness === "opencode-v2") {
    mkdirSync(join(scratch, ".opencode/plugins"), { recursive: true });
    cpSync(join(repo, ".capture/opencode-v2/capture.js"), join(scratch, ".opencode/plugins/capture.js"));
  } else {
    prepareScratch(repo, harness === "opencode-v1" ? "opencode" : harness, scratch);
  }
  cpSync(join(repo, ".capture/shell-dialects/interpreter.cjs"), join(scratch, "interpreter.cjs"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-home");
  process.env.CODEX_HOME = join(root, "codex-home");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.XDG_STATE_HOME = join(root, "state");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME, "config.toml"), '[windows]\nsandbox = "unelevated"\n');
  if (harness === "opencode-v1") {
    const version = process.env.HOOKNOSTIC_PLAYBACK_VERSION;
    if (!version) throw new Error("HOOKNOSTIC_PLAYBACK_VERSION is required for v1");
    await prepareOpenCodePluginDependency(scratch, version);
  }
  const server = await startModelPlayback(protocols[harness], "rewrite", script);
  let result;
  try {
    if (harness === "claude") result = await driveClaude(scratch, { url: server.baseUrl }, prompt);
    else if (harness === "codex") result = await driveCodex(scratch, { baseUrl: server.baseUrl + "/v1", name: "hooknostic-playback" }, prompt);
    else if (harness === "opencode-v1") {
      writeOpencodeConfig(scratch, server.baseUrl, "local-playback", "hooknostic-playback");
      result = await driveOpencode(scratch, "hooknostic-playback", prompt);
    } else {
      writeFileSync(join(scratch, "opencode.json"), JSON.stringify({
        model: "playback/hooknostic-playback",
        providers: { playback: {
          name: "Playback", env: ["HKN_PLAYBACK_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: server.baseUrl + "/v1" },
          models: { "hooknostic-playback": { name: "Playback", limit: { context: 128000, output: 4096 } } },
        } },
      }));
      const env = { ...withoutCredentials(), PWD: scratch,
        HKN_CAPTURE_DIR: join(root, "captured"), HKN_PROBE_EFFECT: "observe", HKN_PLAYBACK_KEY: "local-playback",
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      };
      const executable = process.env.HKN_OPENCODE_BINARY;
      if (!executable) throw new Error("HKN_OPENCODE_BINARY is required for v2");
      result = await runProcess(executable, ["run", "--standalone", "--auto", "--format", "json", prompt],
        { cwd: scratch, env, timeoutMs: 120000 });
    }
  } finally {
    await server.close();
  }
  const tools = server.requests.map(describeTools).find((entry) => entry.length) ?? [];
  const captureDir = harness === "opencode-v2" ? join(root, "captured")
    : harness === "opencode-v1" ? join(scratch, ".opencode/plugins/captured") : join(scratch, "captured");
  const destination = join(out, label);
  mkdirSync(destination, { recursive: true });
  if (existsSync(captureDir)) cpSync(captureDir, destination, { recursive: true });
  const observation = existsSync(join(scratch, "interpreter.json"))
    ? JSON.parse(readFileSync(join(scratch, "interpreter.json"), "utf8")) : null;
  const summary = { label, exit: result.code, errors: server.errors, tools, observation,
    tail: (result.stdout + result.stderr).slice(-2500) };
  writeFileSync(join(destination, "drive.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ label, exit: summary.exit, errors: summary.errors,
    tools: tools.map((tool) => tool.name), ancestry: observation?.ancestry ?? null }));
  return summary;
}

const discovery = await session("discovery", [{ kind: "text", text: "discovery complete" }]);
if (discovery.exit !== 0 || discovery.errors.length) throw new Error("Discovery failed");
writeFileSync(join(out, "discovery.json"), JSON.stringify(discovery.tools, null, 2) + "\n");
const names = harness === "claude" ? ["Bash", "PowerShell"] : harness === "codex" ? ["exec_command"] : harness === "opencode-v2" ? ["shell"] : ["bash"];
let completed = 0;
for (const name of names) {
  const tool = discovery.tools.find((entry) => entry.name === name);
  if (!tool) { console.log("not advertised: " + name); continue; }
  const key = ["command", "cmd"].find((candidate) => tool.properties.includes(candidate));
  if (!key) throw new Error(name + " has no discovered command key");
  const args = { [key]: harness === "codex" ? "node interpreter.cjs" : command };
  if (tool.properties.includes("description")) args.description = "Record the real shell process ancestry";
  const cases = [[name.toLowerCase() + "-default", args]];
  if (harness === "codex" && tool.properties.includes("shell")) {
    cases.push(["exec-command-powershell", { ...args, shell: "powershell.exe" }],
      ["exec-command-cmd", { ...args, [key]: "node interpreter.cjs", shell: "cmd.exe" }]);
  }
  for (const [label, arguments_] of cases) {
    const result = await session(label, [{ kind: "tool", toolName: name, arguments: arguments_ }, { kind: "text", text: "probe complete" }]);
    if (result.exit !== 0 || result.errors.length || !result.observation) throw new Error("Probe did not establish execution: " + label);
    completed++;
  }
}

if (completed === 0) throw new Error("No discovered shell tool was exercised");
