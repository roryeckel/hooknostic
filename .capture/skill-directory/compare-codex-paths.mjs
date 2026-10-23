#!/usr/bin/env node
// Deliberate paid-model probe, separate from loopback playback. See comparison.md.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { projectSkillText, RELATIVE_SKILL_TEXT } from "../../packages/agent-plugin/dist/index.js";
import { codexSkillDirectoryValidation } from "../../packages/adapter-codex/src/skill-text.ts";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runs = Number(option("runs", "5"));
const bodies = option("bodies", "F,E-reconstructed").split(",");
const windowsSandbox = option("windows-sandbox", "unelevated");
const sandbox = process.argv.includes("--unsandboxed") ? "danger-full-access" : "workspace-write";
if (!["elevated", "unelevated"].includes(windowsSandbox)) throw new Error("Unsupported Windows sandbox selection");
if (!process.argv.includes("--live") || !Number.isInteger(runs) || runs < 1 || runs > 10 || bodies.some(body => !["F", "E-reconstructed"].includes(body)))
  throw new Error("Paid probe: specify --live [--runs=1..10] [--bodies=F,E-reconstructed] [--output=directory]");
if (process.platform !== "win32") throw new Error("This procedure reproduces the reported Windows environment only.");
const model = "gpt-6-luna";
const placeholder = "<absolute path of the directory containing this SKILL.md>";
const sourceRecord = readFileSync(new URL("codex-command.md", import.meta.url), "utf8");
const bodyF = /````markdown\r?\n([\s\S]*?)\r?\n````/.exec(sourceRecord)?.[1] + "\n";
if (!bodyF.startsWith("---\n") || !bodyF.includes("${SKILL_DIR}")) throw new Error("Missing body F reproduction.");
const bodyE = bodyF.replace("description: Show this probe's status (where its script runs)\n", "description: Show this probe's status (where its script runs)\nallowed-tools: Bash\nmetadata:\n  argument-hint: \"[args]\"\n");
const root = mkdtempSync(join(tmpdir(), "hkn-codex-path-comparison-"));
const output = resolve(option("output", join(repo, ".capture/skill-directory", `captured-comparison-${Date.now()}`)));
mkdirSync(output, { recursive: true });
const entry = join(process.env.APPDATA, "npm/node_modules/@openai/codex/package.json");
const require = createRequire(entry);
const binary = process.env.HKN_CODEX_BINARY ?? join(dirname(require.resolve("@openai/codex-win32-x64/package.json")), "vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const authSource = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
if (!existsSync(authSource)) throw new Error("A logged-in Codex auth.json is required; its contents are never printed or saved as evidence.");
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|^OPENAI_|^CODEX_|^HKN_/i.test(key)));
Object.assign(baseEnv, { CODEX_MANAGED_PACKAGE_ROOT: dirname(entry), CODEX_MANAGED_BY_NPM: "1" });
// Pin one Windows-compatible Bash for both arms; bare system Bash is WSL here.
const bashDirectory = "C:/Program Files/Git/bin";
if (!existsSync(join(bashDirectory, "bash.exe"))) throw new Error("Git Bash is required for this Windows probe.");
baseEnv.PATH = `${bashDirectory};${baseEnv.PATH ?? baseEnv.Path ?? ""}`;
delete baseEnv.Path;
const q = value => `'${String(value).replaceAll("'", "''")}'`;

function run(command, args, cwd, env, input = "", timeoutMs = 180000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); child.stdout.destroy(); child.stderr.destroy(); }, timeoutMs);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolvePromise({ code, timedOut, stdout, stderr }); });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
}

const versionResult = await run(binary, ["--version"], repo, baseEnv);
const version = /\d+\.\d+\.\d+/.exec(versionResult.stdout)?.[0];
if (version !== codexSkillDirectoryValidation.version) throw new Error(`Expected ${codexSkillDirectoryValidation.version}, got ${version}`);
const metadata = { version, model, runsPerCell: runs, bodies, windowsSandbox, sandbox, bashDirectory, placeholder, root, output, startedAt: new Date().toISOString(), reconstructedFrontmatter: { "allowed-tools": "Bash", "metadata.argument-hint": "[args]" } };
writeFileSync(join(output, "metadata.json"), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ phase: "started", ...metadata }));
const results = [];
let sequence = 0;
for (let round = 1; round <= runs; round++) {
  for (const [bodyIndex, body] of bodies.entries()) {
    const projections = (round + bodyIndex) % 2 ? ["dot", "absolute-placeholder"] : ["absolute-placeholder", "dot"];
    for (const projection of projections) {
      const label = `run-${String(++sequence).padStart(2, "0")}`;
      const state = join(root, label);
      const project = join(state, "project");
      const home = join(state, "codex-home");
      const marketplace = join(state, "marketplace");
      const plugin = join(marketplace, "plugins/skilldir-probe");
      const skill = join(plugin, "skills/where");
      const record = join(output, label);
      for (const dir of [project, home, record, join(marketplace, ".agents/plugins"), join(plugin, ".codex-plugin"), join(plugin, "scripts"), join(skill, "scripts")]) mkdirSync(dir, { recursive: true });
      const env = { ...baseEnv, CODEX_HOME: home, HOME: state, USERPROFILE: state, XDG_CONFIG_HOME: join(state, "config"), XDG_DATA_HOME: join(state, "data"), XDG_CACHE_HOME: join(state, "cache"), XDG_STATE_HOME: join(state, "state") };
      // Keep the bundled model catalog stable without inheriting user config or skills.
      const catalog = join(dirname(authSource), "models_cache.json");
      if (existsSync(catalog)) copyFileSync(catalog, join(home, "models_cache.json"));
      writeFileSync(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "skilldir-probe", version: "0.0.2", description: "Skill-directory probe", skills: "./skills/" }));
      writeFileSync(join(plugin, "scripts/.keep"), "");
      const source = body === "F" ? bodyF : bodyE;
      const target = { ...RELATIVE_SKILL_TEXT, skillDirectory: projection === "dot" ? "." : placeholder };
      const contents = projectSkillText(new TextEncoder().encode(source), target).contents;
      writeFileSync(join(skill, "SKILL.md"), contents);
      writeFileSync(join(record, "SKILL.md"), contents);
      writeFileSync(join(skill, "scripts/where.sh"), '#!/usr/bin/env bash\necho "where.sh ran; working directory: $(pwd); arguments: $*"\nprintf \'%s\\t%s\\t%s\\n\' "$(pwd)" "$0" "$*" >> "${HKN_EXECUTION_TRACE:?}"\n');
      writeFileSync(join(marketplace, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "skilldir-probe-market", owner: { name: "Hooknostic contributors" }, plugins: [{ name: "skilldir-probe", version: "0.0.2", source: { source: "local", path: "./plugins/skilldir-probe" } }] }));
      const git = await run("git", ["init"], project, env);
      if (git.code !== 0) throw new Error(`git init failed: ${git.stderr}`);
      for (const args of [["plugin", "marketplace", "add", marketplace], ["plugin", "add", "skilldir-probe@skilldir-probe-market"]]) {
        const installed = await run(binary, args, project, env);
        if (installed.code !== 0) throw new Error(`Installation failed: ${installed.stdout}\n${installed.stderr}`);
      }
      const installedSkill = join(home, "plugins/cache/skilldir-probe-market/skilldir-probe/0.0.2/skills/where");
      if (!existsSync(join(installedSkill, "SKILL.md"))) throw new Error("Expected installed skill is missing.");
      const executions = join(project, "executions.tsv");
      const bashPwd = await run("bash", ["-c", "pwd -P"], project, env);
      if (bashPwd.code !== 0) throw new Error(`Cannot identify bash's working directory: ${bashPwd.stderr}`);
      env.HKN_EXECUTION_TRACE = posix.join(bashPwd.stdout.trim(), "executions.tsv");
      const bashLauncher = posix.resolve(bashPwd.stdout.trim(), relative(project, join(installedSkill, "scripts/where.sh")).replaceAll("\\", "/"));
      const control = await run("bash", [bashLauncher, "--project", project], project, env);
      if (control.code !== 0 || !existsSync(executions)) throw new Error(`Launcher control failed: ${control.stdout}\n${control.stderr}`);
      writeFileSync(join(record, "control.json"), JSON.stringify({ bashWorkingDirectory: bashPwd.stdout.trim(), bashLauncher, ...control }, null, 2));
      unlinkSync(executions);
      const args = ["exec", "--json", "--color", "never", "--sandbox", sandbox, "-c", `windows.sandbox=${q(windowsSandbox)}`, "-c", "approval_policy=\"never\"", "-c", `projects={${q(project)}={trust_level=${q("trusted")}}}`, "-m", model, "$skilldir-probe:where"];
      console.log(JSON.stringify({ phase: "running", label, round, body, projection }));
      let session;
      try {
        copyFileSync(authSource, join(home, "auth.json"));
        session = await run(binary, args, project, env);
      } finally {
        const temporaryAuth = join(home, "auth.json");
        if (existsSync(temporaryAuth)) unlinkSync(temporaryAuth);
      }
      writeFileSync(join(record, "stdout.jsonl"), session.stdout);
      writeFileSync(join(record, "stderr.txt"), session.stderr);
      const sessions = join(home, "sessions");
      for (const path of existsSync(sessions) ? readdirSync(sessions, { recursive: true }) : []) {
        if (String(path).endsWith(".jsonl")) copyFileSync(join(sessions, path), join(record, "rollout.jsonl"));
      }
      const events = session.stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { unparsed: line }; } });
      const commands = events.filter(event => event.type === "item.completed" && event.item?.type === "command_execution").map(event => event.item);
      const attempts = commands.filter(item => /where\.sh/.test(item.command) && /\bbash\b|&\s*["']?[^\n]*where\.sh/i.test(item.command));
      const trace = existsSync(executions) ? readFileSync(executions, "utf8") : "";
      if (trace) writeFileSync(join(record, "executions.tsv"), trace);
      const result = { label, round, body, projection, exitCode: session.code, timedOut: session.timedOut, firstAttemptSuccess: attempts.length ? attempts[0].exit_code === 0 && attempts[0].aggregated_output?.includes("where.sh ran;") : null, eventualExecution: trace.length > 0, executionCount: trace.trim().split("\n").filter(Boolean).length, commandCount: commands.length, launcherAttempts: attempts, errors: events.filter(event => /error|failed/.test(event.type)), usage: events.findLast(event => event.type === "turn.completed")?.usage, state, installedSkill };
      results.push(result);
      writeFileSync(join(record, "result.json"), JSON.stringify(result, null, 2));
      writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ phase: "completed", label, body, projection, firstAttemptSuccess: result.firstAttemptSuccess, eventualExecution: result.eventualExecution, errors: result.errors.length, usage: result.usage }));
      if (result.timedOut || result.errors.length || result.exitCode !== 0) throw new Error(`Session ${label} did not complete cleanly; inspect its evidence before continuing.`);
    }
  }
}
console.log(JSON.stringify({ phase: "finished", count: results.length, output }));
