#!/usr/bin/env node
// Interactive companion of session-start.mjs: does the TUI show a SessionStart
// `systemMessage` at startup? Headless `-p` streams it as a system notice only
// for source=compact (README), and a headless stream is not the screen. This
// starts the real TUI under node-pty against the loopback playback model,
// walks the first-run dialogs, waits for the main input line, and searches the
// rendered screen for the notice nonce. No prompt is sent; no model turn runs.
//
//   node --experimental-strip-types .capture/claude-output/session-start-pty.mjs
//
// The dialog walk is a reduced copy of packages/cli/test/harness-playback.test.ts
// (walkFirstRunDialogs); see that file for why each dialog is answered as it is.
// Writes .capture/claude-output/captured/session-start-pty/ (git-ignored).
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { startModelPlayback } = await import(pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href);
const { prepareScratch, withoutCredentials } = await import(pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href);
const pty = createRequire(join(REPO, "packages/cli/package.json"))("node-pty");

const OUT = join(REPO, ".capture/claude-output/captured/session-start-pty");
const NONCE = randomBytes(4).toString("hex");
const NOTICE = `HKN-NOTICE-${NONCE}`;
const CONTEXT = `HKN-CONTEXT-${NONCE}`;
const SETTLE_MS = 600;
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const PROBE = `let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const source = (raw ? JSON.parse(raw) : {}).source ?? "unknown";
process.stdout.write(JSON.stringify({
  systemMessage: process.env.HKN_NOTICE + "-" + source,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: process.env.HKN_CONTEXT + "-" + source },
}));
`;

function claudeBinary() {
  if (process.env["HOOKNOSTIC_CLAUDE_BIN"]) return process.env["HOOKNOSTIC_CLAUDE_BIN"];
  const found = execSync(process.platform === "win32" ? "where claude" : "which claude", { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => (process.platform === "win32" ? /\.(?:exe|cmd|bat)$/i.test(line) : line !== ""));
  if (!found) throw new Error("claude binary not found: set HOOKNOSTIC_CLAUDE_BIN");
  return found;
}

function environment(baseUrl, configDir) {
  const env = {};
  for (const [name, value] of Object.entries(withoutCredentials())) {
    const inherited = name === "CLAUDECODE" || name === "AI_AGENT" || name === "TRACEPARENT" || name.startsWith("CLAUDE_");
    if (!inherited || name === "CLAUDE_CODE_GIT_BASH_PATH") env[name] = value;
  }
  return {
    ...env,
    ANTHROPIC_API_KEY: "hooknostic-playback",
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    HKN_NOTICE: NOTICE,
    HKN_CONTEXT: CONTEXT,
  };
}

const plain = (text) =>
  text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b[@-_]/g, "");
const compact = (text) => plain(text).replace(/\s+/g, "");

function mainPromptVisible(screen) {
  const current = screen.slice(-2500);
  const marker = Math.max(current.lastIndexOf("❯"), current.lastIndexOf(">"));
  if (marker === -1) return false;
  return !/^(?:\d+\.?)?(?:Yes|No|Claudeaccount|AnthropicConsoleaccount|3rd-partyplatform)/.test(current.slice(marker + 1));
}

async function select(term, screen, wanted) {
  const selected = () => {
    const current = screen().slice(-2500);
    const marker = Math.max(current.lastIndexOf("❯"), current.lastIndexOf(">"));
    return marker !== -1 && current.slice(marker + 1).replace(/^[0-9]*\.?/, "").startsWith(wanted);
  };
  for (let attempt = 0; attempt < 6 && !selected(); attempt += 1) {
    term.write("\u001b[A");
    await sleep(SETTLE_MS);
  }
  if (!selected()) throw new Error(`could not select ${wanted}`);
  term.write("\r");
  await sleep(SETTLE_MS);
}

async function walk(term, screen, timeoutMs = 60_000) {
  const handled = new Set();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = screen();
    const once = (key) => !handled.has(key) && handled.add(key);
    if (!handled.has("theme") && current.includes("Choosethetextstyle") && once("theme")) term.write("\r");
    else if (!handled.has("api-key") && current.includes("DoyouwanttousethisAPIkey") && once("api-key")) await select(term, screen, "Yes");
    else if (current.includes("Selectloginmethod:")) throw new Error("reached login onboarding");
    else if (!handled.has("security") && current.includes("PressEnte") && once("security")) term.write("\r");
    else if (!handled.has("terminal-setup") && current.includes("terminalsetup?") && once("terminal-setup")) term.write("\r");
    else if (!handled.has("trust") && current.includes("Quicksafetycheck") && once("trust")) await select(term, screen, "Yes,Itrustthisfolder");
    else if (mainPromptVisible(current)) return true;
    await sleep(400);
  }
  return false;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "hkn-session-start-pty-"));
  const scratch = join(root, "claude");
  prepareScratch(REPO, "claude", scratch);
  writeFileSync(join(scratch, "notify-probe.mjs"), PROBE, "utf8");
  const settingsPath = join(scratch, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.SessionStart.push({
    hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/notify-probe.mjs"], timeout: 10 }],
  });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  const configDir = join(root, "claude-config");
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: ["hooknostic-playback"], rejected: [] } }),
  );

  const playback = await startModelPlayback("anthropic-messages", "rewrite", [{ kind: "text", text: "ready" }]);
  const binary = claudeBinary();
  const argv = ["--settings", settingsPath, "--model", "hooknostic-playback"];
  const options = { name: "xterm-256color", cols: 160, rows: 50, cwd: scratch, env: environment(playback.baseUrl, configDir) };
  const term =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary)
      ? pty.spawn(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/c", binary, ...argv], options)
      : pty.spawn(binary, argv, options);
  let raw = "";
  term.onData((data) => {
    raw += data;
  });
  const screen = () => compact(raw);
  let reachedPrompt = false;
  let error;
  try {
    reachedPrompt = await walk(term, screen);
    // Let anything rendered after the input line appears arrive.
    await sleep(5_000);
  } catch (caught) {
    error = String(caught);
  } finally {
    term.kill();
    await playback.close();
  }
  const text = plain(raw);
  const noticeAt = text.indexOf(NOTICE);
  const summary = {
    nonce: NONCE,
    claude: execSync(`"${binary}" --version`, { encoding: "utf8" }).trim(),
    reachedPrompt,
    error,
    noticeOnScreen: compact(raw).includes(NOTICE),
    noticeExcerpt: noticeAt === -1 ? null : text.slice(Math.max(0, noticeAt - 200), noticeAt + 80),
    contextOnScreen: compact(raw).includes(CONTEXT),
    contextInRequests: playback.requests.some((body) => JSON.stringify(body).includes(CONTEXT)),
    noticeInRequests: playback.requests.some((body) => JSON.stringify(body).includes(NOTICE)),
    requests: playback.requests.length,
  };
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "screen.txt"), text, "utf8");
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

await main();
