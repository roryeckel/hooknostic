// Model-free Pi sessions for the lifecycle, shell, error, compaction, and
// continuation payloads the feature and completion probes do not produce.
// Each session uses a disposable home, agent directory, and project with a
// repository boundary, the scripted loopback model, and the passive tee (or
// one of its probe modes). Raw JSONL stays in ignored captured-sessions/.
// Run with Node's type stripping, after `pnpm run bundle`:
//   node --experimental-strip-types .capture/pi/probe-sessions.mjs [session]
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { runProcess, spawnIntact, startModelPlayback, writePiProviderExtension } =
  await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials } = await import("../../scripts/drive-capture-session.mjs");
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const executable = process.env.HKN_PI_BINARY ?? "pi";
const out = resolve(process.env.HKN_PI_SESSION_OUTPUT ?? join(repo, ".capture/pi/captured-sessions", process.platform));

const bash = (command) => ({ kind: "tool", toolName: "bash", arguments: { command } });
const SMALL_COMPACTION = { compaction: { keepRecentTokens: 1 } };

/**
 * rpc sessions send one prompt, wait for it to settle, then issue `compact`;
 * print sessions run one `-p` prompt. A summary turn follows when pi compacts.
 */
const SESSIONS = {
  // Lifecycle and the bash pair in an isolated project (no skills, no context files).
  basic: {
    turns: [bash("echo hooknostic-original"), { kind: "text", text: "BASIC_REPLY" }],
    prompt: "Run the probe command once, then reply.",
  },
  // The Windows PowerShell tool, forced as the only tool.
  powershell: {
    platforms: ["win32"],
    tools: "powershell",
    turns: [
      { kind: "tool", toolName: "powershell", arguments: { command: "Write-Output hooknostic-original" } },
      { kind: "text", text: "POWERSHELL_REPLY" },
    ],
    prompt: "Run the probe command once, then reply.",
  },
  // A project context file and a project skill reach before_agent_start; the
  // bash command fails with exit 7.
  populated: {
    skills: true,
    setup(project) {
      writeFileSync(join(project, "AGENTS.md"), "# Probe project\n\nContext file for the hooknostic capture probe.\n");
      mkdirSync(join(project, ".pi/skills/probe-skill"), { recursive: true });
      writeFileSync(
        join(project, ".pi/skills/probe-skill/SKILL.md"),
        "---\nname: probe-skill\ndescription: Probe skill for the hooknostic capture session.\n---\n\nProbe skill body.\n",
      );
    },
    turns: [bash("echo hooknostic-error; exit 7"), { kind: "text", text: "POPULATED_REPLY" }],
    prompt: "Run the failing probe command once, then reply.",
  },
  // RPC `compact` after one tool exchange: session_before_compact, session_compact.
  "compact-run": {
    rpc: true,
    settings: SMALL_COMPACTION,
    turns: [
      bash("echo hooknostic-compact-probe"),
      { kind: "text", text: "BEFORE_COMPACT_REPLY" },
      { kind: "text", text: "## Summary\nThe user asked for one probe command; it ran and the agent replied." },
    ],
    prompt: "Run the probe command once, then reply.",
  },
  // The tee's compact-cancel probe: ctx.compact() at agent_end, {cancel: true}
  // at session_before_compact, then session_compact_failed.
  "compact-cancel": {
    probe: "compact-cancel",
    settings: SMALL_COMPACTION,
    turns: [bash("echo hooknostic-compact-probe"), { kind: "text", text: "BEFORE_COMPACT_REPLY" }],
    prompt: "Run the probe command once, then reply.",
  },
  // The tee's prevent-stop probe: sendMessage({triggerTurn: true}) from
  // agent_settled starts a continuation run.
  continuation: {
    probe: "prevent-stop",
    turns: [
      { kind: "text", text: "FIRST_REPLY" },
      { kind: "text", text: "CONTINUED_REPLY" },
    ],
    prompt: "Reply once, then stop.",
  },
};

const only = process.argv[2];
if (only !== undefined && !(only in SESSIONS)) throw new Error("Unknown session: " + only);
mkdirSync(out, { recursive: true });
const detected = await runProcess(executable, ["--version"], { cwd: repo, env: withoutCredentials() });
if (detected.code !== 0) throw new Error(detected.stderr);
const version = detected.stdout.trim();
const expected = process.env.HKN_PI_EXPECTED_VERSION ?? piHarness.referenceVersion;
if (version !== expected) throw new Error(`Expected build ${expected}, found ${version}`);
writeFileSync(
  join(out, "metadata.json"),
  JSON.stringify(
    { version, platform: process.platform, date: new Date().toISOString(), account: userInfo().username, home: homedir() },
    null,
    2,
  ) + "\n",
);

async function runRpc(args, options) {
  const child = spawnIntact(executable, ["--mode", "rpc", ...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
  const rows = [];
  const state = { stderr: "", closed: false, code: null };
  let pending = "";
  child.stdout.on("data", (data) => {
    pending += data;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines.filter(Boolean)) rows.push(JSON.parse(line));
  });
  child.stderr.on("data", (data) => (state.stderr += data));
  child.on("close", (code) => Object.assign(state, { code, closed: true }));
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const hit = rows.find(predicate);
      if (hit) return hit;
      if (state.closed) throw new Error(`${label}: Pi exited ${state.code}: ${state.stderr}`);
      await delay(25);
    }
    throw new Error(`Timed out: ${label}; ${state.stderr}`);
  };
  let id = 0;
  const command = async (type, extra = {}) => {
    const n = String(++id);
    child.stdin.write(JSON.stringify({ id: n, type, ...extra }) + "\n");
    const response = await waitFor((row) => row.type === "response" && row.id === n, type);
    if (!response.success) throw new Error(`${type}: ${response.error}`);
    return response.data;
  };
  await command("prompt", { message: options.prompt });
  await waitFor((row) => row.type === "agent_settled", "settled");
  await command("compact");
  child.stdin.end();
  const deadline = Date.now() + 5000;
  while (!state.closed && Date.now() < deadline) await delay(25);
  if (!state.closed) child.kill();
  return { code: state.code, stdout: "", stderr: state.stderr };
}

for (const [label, config] of Object.entries(SESSIONS)) {
  if (only && label !== only) continue;
  if (config.platforms && !config.platforms.includes(process.platform)) continue;
  const root = mkdtempSync(join(tmpdir(), "hkn-pi-sessions-"));
  try {
    const project = join(root, "project");
    const capture = join(root, "captured");
    for (const path of [project, capture, join(root, "agent"), join(project, ".git"), join(project, ".pi")])
      mkdirSync(path, { recursive: true });
    writeFileSync(join(project, ".pi/settings.json"), JSON.stringify(config.settings ?? {}));
    cpSync(join(repo, ".capture/pi/hooknostic-capture.ts"), join(project, "capture.ts"));
    config.setup?.(project);
    const env = {
      ...withoutCredentials(),
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: join(root, "agent"),
      HKN_CAPTURE_DIR: capture,
      HKN_PI_PROBE: config.probe ?? "tee",
    };
    const server = await startModelPlayback("openai-chat", "rewrite", config.turns);
    let result;
    try {
      const provider = await writePiProviderExtension(project, server.baseUrl);
      const args = [
        "--provider",
        "hooknostic-playback",
        "--model",
        "hooknostic-playback",
        "-e",
        provider,
        "-e",
        join(project, "capture.ts"),
        ...(config.skills ? [] : ["--no-skills"]),
        ...(config.tools ? ["--tools", config.tools] : []),
        "--approve",
      ];
      result = config.rpc
        ? await runRpc(args, { cwd: project, env, prompt: config.prompt })
        : await runProcess(executable, [...args, "--no-session", "-p", config.prompt], {
            cwd: project,
            env,
            timeoutMs: 60000,
          });
    } finally {
      await server.close();
    }
    const target = join(out, label);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(capture, join(target, "events"), { recursive: true });
    const events = Object.fromEntries(
      readdirSync(capture).map((file) => [
        file.replace(/\.jsonl$/, ""),
        readFileSync(join(capture, file), "utf8").trim().split("\n").filter(Boolean).length,
      ]),
    );
    const observation = {
      label,
      version,
      date: new Date().toISOString(),
      exitCode: result.code,
      modelRequests: server.requests.length,
      events,
    };
    writeFileSync(join(target, "observation.json"), JSON.stringify(observation, null, 2) + "\n");
    console.log(JSON.stringify({ label, exitCode: result.code, modelRequests: server.requests.length }));
    if (result.code !== 0) throw new Error(`${label}: Pi exited ${result.code}: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
