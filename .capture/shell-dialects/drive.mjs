#!/usr/bin/env node
// Evidence-only shell interpreter probe; model replies and argument values are scripted.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir, release, tmpdir, userInfo } from "node:os";
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
// `without-git` is for a Windows host with no Git for Windows: under each host
// configuration it records what Claude Code advertises and what each advertised
// shell tool runs. It refuses to run where it finds an install.
const mode = process.argv[3];
const modes = ["configured", "builds", "without-git"];
if (mode !== undefined && !modes.includes(mode)) throw new Error("The modes are " + modes.join(", "));
if (mode === "builds" && process.platform !== "win32") throw new Error("The builds comparison is established on Windows only");
const configured = mode === "configured";
const withoutGitMode = mode === "without-git";
// Where a Git for Windows install shows: git.exe on PATH, bash.exe at an install
// location, or its registry key. The locations are also spelled out, because
// Claude Code found one there with these variables redirected. This keeps the
// comparison off a host that plainly has one; it cannot see a copy unpacked
// somewhere else, so the record also keeps what Claude Code says it found.
function gitForWindows() {
  const onPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "git.exe"));
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"), "C:\\Program Files", "C:\\Program Files (x86)"];
  const installed = roots.filter(Boolean).map((root) => join(root, "Git", "bin", "bash.exe"));
  const keys = ["HKLM", "HKCU"].map((hive) => hive + "\\SOFTWARE\\GitForWindows")
    .filter((key) => spawnSync("reg", ["query", key], { stdio: "ignore" }).status === 0);
  return [...new Set([...onPath, ...installed].filter((file) => existsSync(file))), ...keys];
}
if (withoutGitMode) {
  if (process.platform !== "win32" || harness !== "claude") throw new Error("The without-git comparison is established for Claude Code on Windows only");
  const found = gitForWindows();
  if (found.length) throw new Error("Git for Windows is on this host: " + found.join(", "));
}
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
// A host that mounts this checkout read-only names another directory for the raw output.
const captureBase = process.env.HKN_CAPTURE_ROOT ? resolve(process.env.HKN_CAPTURE_ROOT) : resolve(repo, ".capture/shell-dialects/captured");
const captureRoot = resolve(captureBase, (mode ? [mode] : []).concat(process.platform === "win32" ? [] : process.platform).join("-"));
const out = resolve(captureRoot, mode === "builds" ? harness + "-" + version : harness);
if (dirname(out) !== captureRoot) throw new Error("Capture path must be a direct child of the output root");
// Only a previous capture of this harness is cleared: the root can be named from outside, and this deletes.
const previousCapture = () => {
  try {
    const previous = JSON.parse(readFileSync(join(out, "metadata.json"), "utf8"));
    return previous.harness === harness && previous.platform === process.platform && typeof previous.capturedAt === "string"
      && (mode !== "builds" || previous.version === version);
  } catch {
    return false;
  }
};
if (existsSync(out) && readdirSync(out).length && !previousCapture()) throw new Error("Not a capture directory, so not cleared: " + out);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Every directory on PATH holding a bash.exe, whoever installed it: Windows ships a WSL launcher by that name.
const bashOnPath = () => [...new Set((process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "bash.exe").toLowerCase()))].filter((file) => existsSync(file));
// The shell tools this driver calls on Claude Code. Promotion expects a call for each one advertised.
const claudeShellTools = ["Bash", "PowerShell"];
// The host configurations of the without-git comparison: a label, what it sets, and how the record words it.
function withoutGitConfigurations() {
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const powershell = join(system, "WindowsPowerShell", "v1.0", "powershell.exe");
  const cmd = join(system, "cmd.exe");
  return [
    ["default", {}, "nothing else set"],
    ["powershell-tool-off", { CLAUDE_CODE_USE_POWERSHELL_TOOL: "0" }, "CLAUDE_CODE_USE_POWERSHELL_TOOL=0"],
    ["git-bash-path-missing", { CLAUDE_CODE_GIT_BASH_PATH: join(system, "hooknostic-missing", "bash.exe") }, "CLAUDE_CODE_GIT_BASH_PATH names a missing file"],
    ["git-bash-path-cmd", { CLAUDE_CODE_GIT_BASH_PATH: cmd }, "CLAUDE_CODE_GIT_BASH_PATH names cmd.exe"],
    ["git-bash-path-powershell", { CLAUDE_CODE_GIT_BASH_PATH: powershell }, "CLAUDE_CODE_GIT_BASH_PATH names powershell.exe"],
    ["git-bash-path-cmd-powershell-tool-off", { CLAUDE_CODE_GIT_BASH_PATH: cmd, CLAUDE_CODE_USE_POWERSHELL_TOOL: "0" },
      "CLAUDE_CODE_GIT_BASH_PATH names cmd.exe, CLAUDE_CODE_USE_POWERSHELL_TOOL=0"],
    ["claude-code-shell-powershell", { CLAUDE_CODE_SHELL: powershell }, "CLAUDE_CODE_SHELL names powershell.exe"],
    ["shell-powershell", { SHELL: powershell }, "SHELL names powershell.exe"],
    // Where PATH holds a bash.exe, such as the WSL launcher Windows can ship, that one is named too.
    ...bashOnPath().slice(0, 1).map((file) => ["git-bash-path-bash-on-path", { CLAUDE_CODE_GIT_BASH_PATH: file }, "CLAUDE_CODE_GIT_BASH_PATH names the bash.exe on PATH"]),
  ];
}
// The account and its home are for promotion to redact from paths; they stay in the ignored raw output.
writeFileSync(join(out, "metadata.json"), JSON.stringify({ harness, version, platform: process.platform, capturedAt: new Date().toISOString(),
  account: userInfo().username, home: homedir(),
  ...(withoutGitMode ? { windows: release(), gitForWindows: gitForWindows(), bashOnPath: bashOnPath(),
    configurations: withoutGitConfigurations().map(([label]) => label), shellTools: claudeShellTools } : {}) }, null, 2) + "\n");
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
  // Claude Code's own interpreter variables are host configuration as well: a
  // session that does not set one runs without it, whatever this process inherited.
  const unset = harness === "claude"
    ? { CLAUDE_CODE_SHELL: null, CLAUDE_CODE_GIT_BASH_PATH: null, CLAUDE_CODE_USE_POWERSHELL_TOOL: null } : {};
  const overrides = Object.entries({ ...unset, ...(configuration.env ?? {}) });
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
  const summary = { label, exit: result.code, errors: server.errors, requests: server.requests.length, tools, observation,
    // What the session saw, and in a configured case what it set; PATH is described, not copied.
    host, ...(configured ? { set: configuration.set, opencodeShell: configuration.opencodeShell ?? null } : {}),
    ...(withoutGitMode ? { set: configuration.set } : {}),
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
    // The nearest this host comes to having no Git for Windows: every variable an
    // install location could be derived from names an empty directory.
    const hidden = () => {
      const empty = mkdtempSync(join(tmpdir(), "hkn-shell-dialect-empty-"));
      return { SHELL: null, PATH: withoutGit, ProgramFiles: empty, "ProgramFiles(x86)": empty, ProgramW6432: empty, LOCALAPPDATA: empty };
    };
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
        [tool + "-git-locations-redirected", { env: hidden(),
          set: "SHELL unset, Git for Windows removed from PATH, ProgramFiles, ProgramFiles(x86), ProgramW6432 and LOCALAPPDATA name an empty directory" }],
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

// A Windows host with no Git for Windows. Each host configuration gets its own
// discovery, because which shell tools exist is the question here, and then a
// call to every shell tool it advertised. A configuration under which Claude
// Code exits without starting is an observation, and so is a call that runs
// nothing: both are recorded. A session the driver could not complete, through
// a playback fault or a killed process, is neither, and stops the run.
async function withoutGit() {
  let exercised = 0;
  for (const [label, env, set] of withoutGitConfigurations()) {
    const configuration = { env: { SHELL: null, ...env }, set: (Object.hasOwn(env, "SHELL") ? "" : "SHELL unset, ") + set };
    const discovery = await session("discovery-" + label, [{ kind: "text", text: "discovery complete" }], configuration);
    if (discovery.exit === null || discovery.errors.length) throw new Error("Discovery did not complete: " + label);
    // Exiting before any model request is not starting; failing after one is a fault of this run.
    if (discovery.exit !== 0 && discovery.requests > 0) throw new Error("Discovery failed after starting: " + label);
    if (discovery.exit !== 0) { console.log("did not start under " + label); continue; }
    // A tool that takes a command and is not one this driver calls would be a shell tool nobody probed.
    const unprobed = discovery.tools.filter((tool) => ["command", "cmd"].some((key) => tool.properties.includes(key)) && !claudeShellTools.includes(tool.name));
    if (unprobed.length) throw new Error("An advertised tool takes a command and is not one this driver calls: " + unprobed.map((tool) => tool.name).join(", "));
    for (const name of claudeShellTools) {
      const tool = discovery.tools.find((entry) => entry.name === name);
      if (!tool) { console.log("not advertised under " + label + ": " + name); continue; }
      // The bare probe, as in the Windows host-configuration cases: cmd.exe may be what runs it.
      const args = { command: "node interpreter.cjs", ...(tool.properties.includes("description") ? { description: "Record the real shell process ancestry" } : {}) };
      const result = await session(name.toLowerCase() + "-" + label, [{ kind: "tool", toolName: name, arguments: args }, { kind: "text", text: "probe complete" }], configuration);
      if (result.exit === null || result.errors.length) throw new Error("Probe did not complete: " + result.label);
      if (result.observation) exercised++;
    }
  }
  if (exercised === 0) throw new Error("No advertised shell tool ran the probe");
}

// The default, configured and builds comparisons: one discovery, then every case of each advertised shell tool.
async function comparison() {
  // Claude advertises PowerShell only when opted in; the other discoveries pin SHELL like their cases.
  const discoveryConfiguration = !configured ? {}
    : process.platform === "linux" ? { env: { SHELL: "/bin/bash" }, set: "SHELL names bash" }
    : harness === "claude" ? { env: { SHELL: null, CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" }, set: "SHELL unset, CLAUDE_CODE_USE_POWERSHELL_TOOL=1" }
      : { env: { SHELL: null }, set: "SHELL unset" };
  const discovery = await session("discovery", [{ kind: "text", text: "discovery complete" }], discoveryConfiguration);
  if (discovery.exit !== 0 || discovery.errors.length) throw new Error("Discovery failed");
  writeFileSync(join(out, "discovery.json"), JSON.stringify(discovery.tools, null, 2) + "\n");
  const names = harness === "claude" ? claudeShellTools : harness === "codex" ? ["exec_command"] : harness === "opencode-v2" ? ["shell"] : ["bash"];
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
}

if (mode === "without-git") await withoutGit();
else await comparison();
