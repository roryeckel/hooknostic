#!/usr/bin/env node
// Interactive companion of session-start.mjs: does the TUI show a SessionStart
// `systemMessage`, and for which sources? Headless `-p` streams it as a system
// notice only for source=compact (README), and a headless stream is not the
// screen. This starts the real TUI under node-pty against the loopback playback
// model, walks the first-run dialogs, and drives every source an interactive
// session can produce, searching the screen rendered after each step for the
// notice nonce:
//
//   process A  startup -> prompt -> /clear -> 3 prompts -> /compact -> prompt -> /resume -> prompt
//   process B  --resume <startup session id> -> prompt
//
// Each prompt makes a model request, so the context string is observed reaching
// the model after each source, and the notice is observed never doing so. The
// playback model answers every request (the /compact summary included) with
// the text "ready".
//
//   node --experimental-strip-types .capture/claude-output/session-start-pty.mjs [variant...]
//   variant: notify | compose | context   (default: all three)
//
// The dialog walk is a reduced copy of packages/cli/test/harness-playback.test.ts
// (walkFirstRunDialogs); see that file for why each dialog is answered as it is.
// Writes .capture/claude-output/captured/session-start-pty/<version>/<variant>/
// (git-ignored).
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The answering hook, as in session-start.mjs. Reads the variant and nonces from its environment. */
const PROBE = `import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const received = raw ? JSON.parse(raw) : {};
const source = received.source ?? "unknown";
const variant = process.env.HKN_NOTIFY_VARIANT;
const body = {};
if (variant === "notify" || variant === "compose") body.systemMessage = process.env.HKN_NOTICE + "-" + source;
if (variant === "context" || variant === "compose") {
  body.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: process.env.HKN_CONTEXT + "-" + source };
}
const dir = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), "captured");
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, "notify-probe.jsonl"), JSON.stringify({ variant, received, emitted: body }) + "\\n");
process.stdout.write(JSON.stringify(body));
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

function environment(baseUrl, configDir, variant) {
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
    HKN_NOTIFY_VARIANT: variant,
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
    else if (
      !handled.has("classifier-billing") &&
      current.includes("changingautomodetonolongerchargeforclassifierrequests") &&
      once("classifier-billing")
    )
      term.write("\r");
    else if (mainPromptVisible(current)) return true;
    await sleep(400);
  }
  return false;
}

async function until(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One TUI process. Every step records the screen rendered and the requests made from its start onward. */
async function session(context, label, argv) {
  const { binary, scratch, settingsPath, configDir, playback, variant, steps, log } = context;
  const fullArgv = ["--settings", settingsPath, "--model", "hooknostic-playback", ...argv];
  const options = { name: "xterm-256color", cols: 160, rows: 50, cwd: scratch, env: environment(playback.baseUrl, configDir, variant) };
  const term =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary)
      ? pty.spawn(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/c", binary, ...fullArgv], options)
      : pty.spawn(binary, fullArgv, options);
  let raw = "";
  term.onData((data) => {
    raw += data;
  });
  const screen = () => compact(raw);
  const sources = () => log().map((entry) => entry.received.source);

  let step;
  const begin = (name, source) => {
    step = { process: label, name, source, rawFrom: raw.length, requestsFrom: playback.requests.length, hooksFrom: sources().length };
    steps.push(step);
  };
  const end = () => {
    step.rawTo = raw.length;
    step.requestsTo = playback.requests.length;
  };
  /** Type text at the input line and submit it. */
  const type = async (text) => {
    term.write(text);
    await sleep(SETTLE_MS * 2);
    term.write("\r");
  };
  const awaitHook = (source) =>
    until(() => sources().slice(step.hooksFrom).includes(source), 60_000, `SessionStart source=${source}`);
  /** Submit a prompt and wait until the model answered it. */
  const prompt = async () => {
    const from = playback.requests.length;
    await type("Reply with the single word ready.");
    await until(() => playback.requests.length > from, 60_000, "a model request");
    await sleep(4_000);
  };

  try {
    begin(label === "A" ? "startup" : "--resume", label === "A" ? "startup" : "resume");
    if (!(await walk(term, screen))) throw new Error("main input line never rendered");
    await awaitHook(step.source);
    await sleep(5_000);
    end();
    begin(`prompt after ${step.name}`, null);
    await prompt();
    end();
    if (label === "A") {
      for (const [command, source] of [
        ["/clear", "clear"],
        ["/compact", "compact"],
        ["/resume", "resume"],
      ]) {
        if (command === "/compact") {
          // 2.1.238 answers "Not enough messages to compact." after the one
          // exchange that follows /clear.
          begin("prompts before /compact", null);
          await prompt();
          await prompt();
          end();
        }
        begin(command, source);
        await type(command);
        if (command === "/resume") {
          // The picker lists earlier sessions; take the preselected entry.
          await sleep(4_000);
          term.write("\r");
        }
        await awaitHook(source);
        await sleep(6_000);
        end();
        begin(`prompt after ${command}`, null);
        await prompt();
        end();
      }
    }
  } catch (caught) {
    step.error = String(caught);
    end();
  } finally {
    term.kill();
    await sleep(1_000);
  }
  return raw;
}

/** Where in each recorded model request the marker appears: system, user, assistant, or elsewhere. */
function inRequests(requests, marker) {
  return requests.flatMap((body, index) => {
    if (!JSON.stringify(body).includes(marker)) return [];
    const where = [];
    if (JSON.stringify(body.system ?? "").includes(marker)) where.push("system");
    for (const message of body.messages ?? []) {
      if (JSON.stringify(message.content ?? "").includes(marker)) where.push(message.role);
    }
    return [{ request: index, where: where.length > 0 ? where : ["elsewhere"] }];
  });
}

async function variantRun(binary, version, variant) {
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
  const logPath = join(scratch, "captured", "notify-probe.jsonl");
  const log = () =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];

  const playback = await startModelPlayback("anthropic-messages", "rewrite", [{ kind: "text", text: "ready" }]);
  const steps = [];
  const context = { binary, scratch, settingsPath, configDir, playback, variant, steps, log };
  const screens = {};
  try {
    screens.A = await session(context, "A", []);
    const startupId = log().find((entry) => entry.received.source === "startup")?.received.session_id;
    if (startupId) screens.B = await session(context, "B", ["--resume", startupId]);
  } finally {
    await playback.close();
  }

  const summary = {
    variant,
    nonce: NONCE,
    claude: version,
    scratch,
    sourcesReceived: log().map((entry) => entry.received.source),
    noticeInRequests: inRequests(playback.requests, NOTICE),
    contextInRequests: inRequests(playback.requests, CONTEXT),
    playbackErrors: playback.errors,
    steps: steps.map(({ process: label, name, source, rawFrom, rawTo, requestsFrom, requestsTo, error }) => {
      const shown = compact(screens[label].slice(rawFrom, rawTo));
      const requests = playback.requests.slice(requestsFrom, requestsTo);
      const seen = (marker) => [...new Set(shown.match(new RegExp(`${marker}-[a-z]+`, "g")) ?? [])];
      const sent = (marker) => [...new Set(JSON.stringify(requests).match(new RegExp(`${marker}-[a-z]+`, "g")) ?? [])];
      return {
        process: label,
        step: name,
        expectedSource: source,
        ...(error ? { error } : {}),
        noticesOnScreen: seen(NOTICE),
        contextsOnScreen: seen(CONTEXT),
        requests: requests.length,
        noticesInRequests: sent(NOTICE),
        contextsInRequests: sent(CONTEXT),
      };
    }),
  };
  const dest = join(OUT, version.split(" ")[0], variant);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const [label, raw] of Object.entries(screens)) writeFileSync(join(dest, `screen-${label}.txt`), plain(raw), "utf8");
  writeFileSync(join(dest, "requests.json"), JSON.stringify(playback.requests, null, 2) + "\n", "utf8");
  writeFileSync(join(dest, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  for (const step of summary.steps) {
    console.log(
      `[${version} ${variant}/${step.process}] ${step.step}${step.error ? ` ERROR ${step.error}` : ""}: ` +
        `screen notice=${step.noticesOnScreen.join(",") || "none"} context=${step.contextsOnScreen.join(",") || "none"} | ` +
        `requests=${step.requests} notice=${step.noticesInRequests.join(",") || "none"} context=${step.contextsInRequests.join(",") || "none"}`,
    );
  }
  console.log(`[${version} ${variant}] sources received: ${summary.sourcesReceived.join(", ")} -> ${dest}`);
}

const binary = claudeBinary();
const version = execSync(`"${binary}" --version`, { encoding: "utf8" }).trim();
const requested = process.argv.slice(2);
for (const variant of requested.length > 0 ? requested : ["notify", "compose", "context"]) await variantRun(binary, version, variant);
