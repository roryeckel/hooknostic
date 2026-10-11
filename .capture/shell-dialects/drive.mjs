#!/usr/bin/env node
// Evidence-only shell interpreter probe; model replies and argument values are scripted.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { describeTools, prepareOpenCodePluginDependency, runProcess, startModelPlayback } =
  await import("../../packages/cli/test/harness-playback.ts");
const { driveClaude, driveCodex, driveOpencode, prepareScratch, withoutCredentials, writeOpencodeConfig } =
  await import("../../scripts/drive-capture-session.mjs");

const harness = process.argv[2];
// `configured` holds the model's arguments fixed and varies the host configuration instead.
// `builds` runs the default cases into a directory per version, so builds other than a
// comparison's own can be recorded beside each other.
const mode = process.argv[3];
if (mode !== undefined && mode !== "configured" && mode !== "builds") throw new Error("The modes are configured and builds");
if (mode === "builds" && process.platform !== "win32") throw new Error("The builds comparison is established on Windows only");
const configured = mode === "configured";
const protocols = { claude: "anthropic-messages", codex: "openai-responses", "opencode-v1": "openai-chat", "opencode-v2": "openai-chat" };
if (!Object.hasOwn(protocols, harness)) throw new Error("Specify claude, codex, opencode-v1, or opencode-v2");
if (!["win32", "darwin", "linux"].includes(process.platform)) throw new Error("This procedure supports Windows, macOS, and Linux only");
if (configured && process.platform === "darwin") throw new Error("The host-configuration comparison is established on Windows and Linux only");
if (configured && harness === "codex" && process.platform !== "linux") throw new Error("The Codex host-configuration comparison is established on Linux only");
const versionCommand = harness === "opencode-v2" ? process.env.HKN_OPENCODE_BINARY : harness.startsWith("opencode") ? "opencode" : harness;
const versionResult = await runProcess(versionCommand, ["--version"], { cwd: repo, env: withoutCredentials(), timeoutMs: 30000 });
if (versionResult.code !== 0) throw new Error("Version detection failed");
const version = versionResult.stdout.match(/\d+\.\d+\.\d+/)?.[0];
if (!version) throw new Error("No version in binary output");
const captureRoot = resolve(repo, ".capture/shell-dialects/captured", (mode ? [mode] : []).concat(process.platform === "win32" ? [] : process.platform).join("-"));
const out = resolve(captureRoot, mode === "builds" ? harness + "-" + version : harness);
if (dirname(out) !== captureRoot) throw new Error("Capture path must be a direct child of the output root");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "metadata.json"), JSON.stringify({ harness, version, platform: process.platform, capturedAt: new Date().toISOString() }, null, 2) + "\n");
const prompt = "Execute the requested shell probe once, then stop.";
const command = "node interpreter.cjs; echo hooknostic-shell-finished";

function pwshOnPath() {
  const binary = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  return (process.env.PATH ?? "").split(delimiter).some((directory) => directory && existsSync(join(directory, binary)));
}

async function session(label, script, configuration = {}) {
  const root = mkdtempSync(join(tmpdir(), "hkn-shell-dialect-"));
  const scratch = join(root, "project");
  if (harness === "opencode-v2") {
    mkdirSync(join(scratch, ".opencode/plugins"), { recursive: true });
    cpSync(join(repo, ".capture/opencode-v2/capture.js"), join(scratch, ".opencode/plugins/capture.js"));
  } else {
    prepareScratch(repo, harness === "opencode-v1" ? "opencode" : harness, scratch);
  }
  cpSync(join(repo, ".capture/shell-dialects/interpreter.cjs"), join(scratch, "interpreter.cjs"));
  if (harness === "codex") {
    // A second PreToolUse hook reads the transcript the payload names, as it stands at hook time.
    cpSync(join(repo, ".capture/shell-dialects/codex-transcript-at-hook.mjs"), join(scratch, "codex-transcript-at-hook.mjs"));
    const file = join(scratch, ".codex/hooks.json");
    const hooks = JSON.parse(readFileSync(file, "utf8"));
    hooks.hooks.PreToolUse.push({ hooks: [{ type: "command", timeout: 10,
      command: "node " + JSON.stringify(join(scratch, "codex-transcript-at-hook.mjs").replaceAll("\\", "/")) }] });
    writeFileSync(file, JSON.stringify(hooks, null, 2));
  }
  // v1 states its shell through hooks the tee plugin does not register; v2's tee already records them.
  if (harness === "opencode-v1") cpSync(join(repo, ".capture/shell-dialects/opencode-v1-report.js"), join(scratch, ".opencode/plugins/hooknostic-shell-report.js"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-home");
  process.env.CODEX_HOME = join(root, "codex-home");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.XDG_STATE_HOME = join(root, "state");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  if (process.platform === "win32") writeFileSync(join(process.env.CODEX_HOME, "config.toml"), '[windows]\nsandbox = "unelevated"\n');
  if (harness === "opencode-v1") {
    const version = process.env.HOOKNOSTIC_PLAYBACK_VERSION;
    if (!version) throw new Error("HOOKNOSTIC_PLAYBACK_VERSION is required for v1");
    await prepareOpenCodePluginDependency(scratch, version);
  }
  // The drives copy process.env, so a case's host configuration is applied there
  // for one session and restored afterwards. `null` unsets a variable.
  const overrides = Object.entries(configuration.env ?? {});
  const inherited = overrides.map(([name]) => [name, process.env[name]]);
  for (const [name, value] of overrides) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  const host = { SHELL: process.env.SHELL ?? null, pwshOnPath: pwshOnPath() };
  const server = await startModelPlayback(protocols[harness], "rewrite", script);
  let result;
  try {
    if (harness === "claude") result = await driveClaude(scratch, { url: server.baseUrl }, prompt);
    else if (harness === "codex") result = await driveCodex(scratch, { baseUrl: server.baseUrl + "/v1", name: "hooknostic-playback" }, prompt);
    else if (harness === "opencode-v1") {
      writeOpencodeConfig(scratch, server.baseUrl, "local-playback", "hooknostic-playback");
      if (configuration.opencodeShell) {
        const file = join(scratch, "opencode.json");
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), shell: configuration.opencodeShell }));
      }
      result = await driveOpencode(scratch, "hooknostic-playback", prompt);
    } else {
      writeFileSync(join(scratch, "opencode.json"), JSON.stringify({
        model: "playback/hooknostic-playback",
        ...(configuration.opencodeShell ? { shell: configuration.opencodeShell } : {}),
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
    for (const [name, value] of inherited) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
    // What the session saw, and in a configured case what it set; PATH is described, not copied.
    host, ...(configured ? { set: configuration.set, opencodeShell: configuration.opencodeShell ?? null } : {}),
    tail: (result.stdout + result.stderr).slice(-2500) };
  writeFileSync(join(destination, "drive.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ label, exit: summary.exit, errors: summary.errors,
    tools: tools.map((tool) => tool.name), ancestry: observation?.ancestry ?? null }));
  return summary;
}

// Host-configuration cases. Each names the one thing it sets; everything else a
// harness reads to choose an interpreter is pinned, so cases differ by that alone.
function configuredCases(name) {
  const tool = name.toLowerCase();
  if (process.platform === "linux") {
    const shells = ["zsh", "fish", "tcsh"];
    for (const shell of shells) if (!existsSync("/usr/bin/" + shell)) throw new Error("Install /usr/bin/" + shell);
    // Claude's own override takes the same shells, and PowerShell where it is installed.
    const overrides = [...shells, ...(existsSync("/usr/bin/pwsh") ? ["pwsh"] : [])];
    return [
      // No SHELL at all is what a container gives a harness by default.
      [tool + "-env-unset", { env: { SHELL: null }, set: "SHELL unset" }],
      ...shells.map((shell) => [tool + "-env-" + shell, { env: { SHELL: "/usr/bin/" + shell }, set: "SHELL names " + shell }]),
      ...(harness === "claude" ? overrides.map((shell) => [tool + "-claude-code-shell-" + shell,
        { env: { SHELL: "/bin/bash", CLAUDE_CODE_SHELL: "/usr/bin/" + shell }, set: "SHELL names bash, CLAUDE_CODE_SHELL names " + shell }]) : []),
    ];
  }
  const gitBash = process.env.HKN_GIT_BASH;
  const pwshDirectory = process.env.HKN_PWSH_DIR;
  if (gitBash && !existsSync(gitBash)) throw new Error("HKN_GIT_BASH does not exist");
  if (pwshDirectory && !existsSync(join(pwshDirectory, "pwsh.exe"))) throw new Error("HKN_PWSH_DIR holds no pwsh.exe");
  const withPwsh = pwshDirectory ? pwshDirectory + delimiter + (process.env.PATH ?? "") : undefined;
  if (harness === "claude") {
    const enabled = { SHELL: null, CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" };
    const set = "SHELL unset, CLAUDE_CODE_USE_POWERSHELL_TOOL=1";
    // Whether Bash can be pointed away from Git Bash: its path variable naming
    // something that is not a POSIX shell, or nothing, and Git taken off PATH.
    const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const withoutGit = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry && !/[\\/]Git([\\/]|$)|mingw64/i.test(entry)).join(delimiter);
    const elsewhere = [
      ["missing", join(system, "hooknostic-missing", "bash.exe"), "a missing file"],
      ["cmd", join(system, "cmd.exe"), "cmd.exe"],
      ["powershell", join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), "powershell.exe"],
    ];
    return [
      [tool + "-opted-in", { env: enabled, set }],
      ...(name === "PowerShell" && withPwsh
        ? [[tool + "-opted-in-pwsh-on-path", { env: { ...enabled, PATH: withPwsh }, set: set + ", pwsh.exe first on PATH" }]] : []),
      ...(name === "Bash" ? [
        ...elsewhere.map(([label, path, described]) => [tool + "-git-bash-path-" + label,
          { env: { SHELL: null, CLAUDE_CODE_GIT_BASH_PATH: path }, set: "SHELL unset, CLAUDE_CODE_GIT_BASH_PATH names " + described }]),
        [tool + "-git-off-path", { env: { SHELL: null, PATH: withoutGit }, set: "SHELL unset, Git for Windows removed from PATH" }],
      ] : []),
    ];
  }
  return [
    [tool + "-env-unset", { env: { SHELL: null }, set: "SHELL unset" }],
    ...(gitBash ? [[tool + "-env-git-bash", { env: { SHELL: gitBash }, set: "SHELL names Git for Windows bash.exe" }]] : []),
    [tool + "-config-cmd", { env: { SHELL: null }, opencodeShell: "cmd", set: 'SHELL unset, opencode.json shell: "cmd"' }],
    ...(withPwsh ? [[tool + "-pwsh-on-path", { env: { SHELL: null, PATH: withPwsh }, set: "SHELL unset, pwsh.exe first on PATH" }]] : []),
  ];
}

// Claude advertises PowerShell only when opted in; the other discoveries pin SHELL like their cases.
const discoveryConfiguration = !configured ? {}
  : process.platform === "linux" ? { env: { SHELL: "/bin/bash" }, set: "SHELL names bash" }
  : harness === "claude" ? { env: { SHELL: null, CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" }, set: "SHELL unset, CLAUDE_CODE_USE_POWERSHELL_TOOL=1" }
    : { env: { SHELL: null }, set: "SHELL unset" };
const discovery = await session("discovery", [{ kind: "text", text: "discovery complete" }], discoveryConfiguration);
if (discovery.exit !== 0 || discovery.errors.length) throw new Error("Discovery failed");
writeFileSync(join(out, "discovery.json"), JSON.stringify(discovery.tools, null, 2) + "\n");
const names = harness === "claude" ? ["Bash", "PowerShell"] : harness === "codex" ? ["exec_command"] : harness === "opencode-v2" ? ["shell"] : ["bash"];
let completed = 0;
for (const name of names) {
  const tool = discovery.tools.find((entry) => entry.name === name);
  if (!tool) { console.log("not advertised: " + name); continue; }
  const key = ["command", "cmd"].find((candidate) => tool.properties.includes(candidate));
  if (!key) throw new Error(name + " has no discovered command key");
  // cmd.exe does not separate commands with `;`, so Windows comparisons that reach it run the bare probe.
  const args = { [key]: (configured || harness === "codex") && process.platform === "win32" ? "node interpreter.cjs" : command };
  if (tool.properties.includes("description")) args.description = "Record the real shell process ancestry";
  const cases = configured ? configuredCases(name).map(([label, configuration]) => [label, args, configuration])
    : [[name.toLowerCase() + "-default", args]];
  if (!configured && harness === "codex" && tool.properties.includes("shell")) {
    if (process.platform === "win32") {
      cases.push(["exec-command-powershell", { ...args, shell: "powershell.exe" }],
        ["exec-command-cmd", { ...args, shell: "cmd.exe" }]);
    } else {
      cases.push(["exec-command-bash", { ...args, shell: "/bin/bash" }],
        ["exec-command-zsh", { ...args, shell: "/bin/zsh" }]);
      // Linux also requests interpreters outside the bash/zsh pair, where they are installed.
      for (const shell of process.platform === "linux" ? ["fish", "tcsh", "pwsh"] : []) {
        if (existsSync("/usr/bin/" + shell)) cases.push(["exec-command-" + shell, { ...args, shell: "/usr/bin/" + shell }]);
        else console.log("not installed: " + shell);
      }
    }
  }
  for (const [label, arguments_, configuration] of cases) {
    const result = await session(label, [{ kind: "tool", toolName: name, arguments: arguments_ }, { kind: "text", text: "probe complete" }], configuration);
    if (result.exit !== 0 || result.errors.length || !result.observation) throw new Error("Probe did not establish execution: " + label);
    completed++;
  }
}

if (completed === 0) throw new Error("No discovered shell tool was exercised");
