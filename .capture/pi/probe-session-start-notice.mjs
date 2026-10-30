// Session-start notice probe with no model spend: can a Pi extension show the
// user a notice at session start that the model never sees? An extension
// answers every `session_start` with each fire-and-forget `ctx.ui` notice
// method (notify info and warning, setStatus, setWidget, setTitle) and, as the
// model-visible comparison, `pi.sendMessage` with a displayed custom message.
// Every string carries a per-run nonce and the start reason, so a match names
// the method and the reason that produced it.
//
// Three surfaces, each followed by a prompt after every session start so the
// loopback model receives a request that could carry the notice:
//   print  `-p` startup, `--continue -p`, `--fork <file> -p`
//   rpc    `--mode rpc` startup, new_session, switch_session, fork, clone,
//          then a second process with `--continue`
//   tui    the interactive TUI under node-pty, rendered by a headless xterm:
//          startup, /new, /reload, /resume, /fork, then `--continue`
//
// Run with Node's type stripping, after `pnpm run bundle`, naming each build:
//   node --experimental-strip-types .capture/pi/probe-session-start-notice.mjs <pi-binary>...
// Writes .capture/pi/captured-session-start/<version>/ (git-ignored).
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { runProcess, spawnIntact, startModelPlayback, writePiProviderExtension } =
  await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials } = await import("../../scripts/drive-capture-session.mjs");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const requireFromCli = createRequire(join(repo, "packages/cli/package.json"));
const pty = requireFromCli("node-pty");
const { Terminal } = requireFromCli("@xterm/headless");

const NONCE = randomBytes(4).toString("hex");
const NOTICE = `HKN-NOTICE-${NONCE}`;
const MESSAGE = `HKN-MESSAGE-${NONCE}`;
const FOUND = new RegExp(
  `HKN-(?:NOTICE|MESSAGE)-${NONCE}-\\d+-(?:startup|reload|new|resume|fork)(?:-(?:info|warning|status|widget|title))?`,
  "g",
);
const REPLY = "PLAYBACK-REPLY";

// The sequence number is the count of earlier starts in the shared log, so a
// start that repeats a reason (two startups, fork and clone) stays distinct.
const EXTENSION = `import { appendFileSync, existsSync, readFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", async (event, ctx) => {
    const log = process.env.HKN_NOTICE_LOG;
    const seq = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
    const reason = seq + "-" + event.reason;
    appendFileSync(log, JSON.stringify({
      seq, type: event.type, reason: event.reason, previousSessionFile: event.previousSessionFile !== undefined,
      mode: ctx.mode, hasUI: ctx.hasUI,
    }) + "\\n");
    const notice = process.env.HKN_NOTICE + "-" + reason;
    ctx.ui.notify(notice + "-info", "info");
    ctx.ui.notify(notice + "-warning", "warning");
    ctx.ui.setStatus("hkn", notice + "-status");
    ctx.ui.setWidget("hkn", [notice + "-widget"]);
    ctx.ui.setTitle(notice + "-title");
    pi.sendMessage({ customType: "hkn-notice", content: process.env.HKN_MESSAGE + "-" + reason, display: true });
  });
}
`;

/** Each distinct nonce string in a text. */
const found = (text) => [...new Set(text.match(FOUND) ?? [])].sort();

function environment(root) {
  const env = {};
  for (const [name, value] of Object.entries(withoutCredentials())) {
    if (!/^CLAUDE/.test(name) && name !== "AI_AGENT") env[name] = value;
  }
  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    // No version check or tool download: the only traffic is the loopback model.
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    HKN_NOTICE: NOTICE,
    HKN_MESSAGE: MESSAGE,
    HKN_NOTICE_LOG: join(root, "session-start.jsonl"),
  };
}

function starts(root) {
  const log = join(root, "session-start.jsonl");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

async function until(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function sessionFiles(root) {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
    }
  };
  walk(join(root, "agent", "sessions"));
  return files.sort();
}

/** A disposable home, agent directory, and project, with the loopback model. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "hkn-pi-notice-"));
  const project = join(root, "project");
  for (const path of [project, join(root, "agent"), join(project, ".git"), join(project, ".pi")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(project, ".pi/settings.json"), "{}");
  writeFileSync(join(project, "notice.js"), EXTENSION);
  const server = await startModelPlayback("openai-chat", "rewrite", [{ kind: "text", text: REPLY }]);
  const provider = await writePiProviderExtension(project, server.baseUrl);
  const args = [
    "--provider", "hooknostic-playback", "--model", "hooknostic-playback",
    "-e", provider, "-e", join(project, "notice.js"),
    "--no-skills", "--approve",
  ];
  return { root, project, server, args, env: environment(root) };
}

/** A killed ConPTY child can hold the workspace open briefly on Windows. */
function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    console.warn(`Left ${root}: ${error.code}`);
  }
}

/** Which nonces each model request carries. */
const requestNonces = (server) => server.requests.map((body) => found(JSON.stringify(body)));

async function printSurface(executable) {
  const ws = await workspace();
  const runs = [];
  try {
    const run = async (label, extra) => {
      const before = ws.server.requests.length;
      const result = await runProcess(executable, [...ws.args, ...extra, "-p", `print ${label}`], {
        cwd: ws.project, env: ws.env, timeoutMs: 60000,
      });
      runs.push({
        label, exitCode: result.code, requests: ws.server.requests.length - before,
        stdout: found(result.stdout), stderr: found(result.stderr), stdoutHasReply: result.stdout.includes(REPLY),
      });
    };
    await run("startup", []);
    await run("continue", ["--continue"]);
    const [first] = sessionFiles(ws.root);
    await run("fork", ["--fork", first]);
    return { runs, starts: starts(ws.root), requests: requestNonces(ws.server), sessionFiles: sessionFiles(ws.root).length };
  } finally {
    await ws.server.close();
    cleanup(ws.root);
  }
}

function rpcProcess(executable, ws, extra) {
  const child = spawnIntact(executable, [...ws.args, ...extra, "--mode", "rpc"], {
    cwd: ws.project, env: ws.env, stdio: ["pipe", "pipe", "pipe"],
  });
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
  let id = 0;
  const command = async (type, extra = {}) => {
    const n = String(++id);
    child.stdin.write(JSON.stringify({ id: n, type, ...extra }) + "\n");
    const response = await until(() => rows.find((row) => row.type === "response" && row.id === n) ?? (state.closed && "closed"), type);
    if (response === "closed") throw new Error(`${type}: Pi exited ${state.code}: ${state.stderr}`);
    if (!response.success) throw new Error(`${type}: ${response.error}`);
    return response.data;
  };
  const prompt = async (message) => {
    const settled = rows.filter((row) => row.type === "agent_settled").length;
    await command("prompt", { message });
    await until(() => rows.filter((row) => row.type === "agent_settled").length > settled, `settled ${message}`);
  };
  const close = async () => {
    child.stdin.end();
    await until(() => state.closed, "rpc exit", 5000).catch(() => child.kill());
    return state;
  };
  return { rows, command, prompt, close };
}

/** Where each nonce surfaced on the RPC stdout stream, by row kind. */
function rpcSightings(rows) {
  const sightings = {};
  for (const row of rows) {
    const kind = row.type === "extension_ui_request" ? `extension_ui_request:${row.method}` : row.type;
    for (const hit of found(JSON.stringify(row))) (sightings[hit] ??= new Set()).add(kind);
  }
  return Object.fromEntries(Object.entries(sightings).map(([hit, kinds]) => [hit, [...kinds].sort()]));
}

async function rpcSurface(executable) {
  const ws = await workspace();
  const steps = [];
  try {
    const rpc = rpcProcess(executable, ws, []);
    const step = async (label, action) => {
      const count = starts(ws.root).length;
      if (action) await action();
      await until(() => starts(ws.root).length > count, `${label} session_start`);
      await delay(500);
      await rpc.prompt(`rpc ${label}`);
      steps.push({ label, start: starts(ws.root).at(-1) });
    };
    await step("startup");
    const { sessionFile: first } = await rpc.command("get_state");
    await step("new_session", () => rpc.command("new_session"));
    await step("switch_session", () => rpc.command("switch_session", { sessionPath: first }));
    await step("fork", async () => {
      const { messages } = await rpc.command("get_fork_messages");
      await rpc.command("fork", { entryId: messages[0].entryId });
    });
    await step("clone", () => rpc.command("clone"));
    const closed = await rpc.close();
    const resumed = rpcProcess(executable, ws, ["--continue"]);
    const count = starts(ws.root).length;
    await until(() => starts(ws.root).length > count, "continue session_start");
    await delay(500);
    await resumed.prompt("rpc continue");
    steps.push({ label: "continue", start: starts(ws.root).at(-1) });
    const closedAgain = await resumed.close();
    return {
      steps,
      starts: starts(ws.root),
      exitCodes: [closed.code, closedAgain.code],
      stdout: { first: rpcSightings(rpc.rows), continue: rpcSightings(resumed.rows) },
      uiRequests: [...rpc.rows, ...resumed.rows]
        .filter((row) => row.type === "extension_ui_request")
        .map(({ id: _id, ...row }) => row),
      requests: requestNonces(ws.server),
    };
  } finally {
    await ws.server.close();
    cleanup(ws.root);
  }
}

function terminalSession(executable, ws, extra) {
  const terminal = new Terminal({ cols: 160, rows: 48, allowProposedApi: true });
  const options = { name: "xterm-256color", cols: 160, rows: 48, cwd: ws.project, env: ws.env };
  const argv = [...ws.args, ...extra];
  const child =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)
      ? pty.spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", executable, ...argv], options)
      : pty.spawn(executable, argv, options);
  let raw = "";
  child.onData((data) => {
    raw += data;
    terminal.write(data);
  });
  const screen = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").join("\n");
  };
  // Everything ever painted: xterm's scrollback plus the visible rows.
  const history = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").join("\n");
  };
  return { child, screen, history, raw: () => raw, dispose: () => terminal.dispose() };
}

async function tuiSurface(executable) {
  const ws = await workspace();
  const steps = [];
  const screens = {};
  try {
    const drive = async (term, label, keys, prompted = true) => {
      const count = starts(ws.root).length;
      for (const key of keys) {
        term.child.write(key);
        await delay(600);
      }
      // A slash command's first Enter may only accept the autocomplete entry.
      const started = await until(() => starts(ws.root).length > count, `${label} session_start`, 4000).catch(() => false);
      if (!started && keys.length > 0) {
        term.child.write("\r");
        await until(() => starts(ws.root).length > count, `${label} session_start`, 15000);
      }
      await delay(1500);
      const atStart = found(term.screen());
      screens[`${label}-start`] = stripVTControlCharacters(term.screen());
      let afterPrompt = [];
      if (prompted) {
        const before = ws.server.requests.length;
        term.child.write(`tui ${label}`);
        await delay(300);
        term.child.write("\r");
        await until(() => ws.server.requests.length > before, `${label} request`);
        await until(() => term.screen().includes(REPLY), `${label} reply`, 15000).catch(() => {});
        await delay(1000);
        afterPrompt = found(term.screen());
        screens[`${label}-prompt`] = stripVTControlCharacters(term.screen());
      }
      steps.push({ label, start: starts(ws.root).at(-1), screenAtStart: atStart, screenAfterPrompt: afterPrompt });
    };
    const first = terminalSession(executable, ws, []);
    let firstRaw = "";
    try {
      await drive(first, "startup", []);
      await drive(first, "new", ["/new"]);
      await drive(first, "reload", ["/reload"]);
      await drive(first, "resume", ["/resume", "\r", "\r"]);
      await drive(first, "fork", ["/fork", "\r", "\r"]);
    } catch (error) {
      steps.push({ error: String(error) });
    } finally {
      firstRaw = first.raw();
      screens.history = stripVTControlCharacters(first.history());
      first.child.kill();
      first.dispose();
    }
    const resumed = terminalSession(executable, ws, ["--continue"]);
    try {
      await drive(resumed, "continue", []);
    } catch (error) {
      steps.push({ error: String(error) });
    } finally {
      firstRaw += resumed.raw();
      screens["continue-history"] = stripVTControlCharacters(resumed.history());
      resumed.child.kill();
      resumed.dispose();
    }
    return {
      steps,
      starts: starts(ws.root),
      // setTitle reaches the terminal as an OSC title sequence, not a cell.
      titleSequences: found((firstRaw.match(/\u001b\]0;[^\u0007]*\u0007/g) ?? []).join("\n")),
      everPainted: found(stripVTControlCharacters(firstRaw)),
      requests: requestNonces(ws.server),
      screens,
    };
  } finally {
    await ws.server.close();
    cleanup(ws.root);
  }
}

const binaries = process.argv.slice(2);
if (binaries.length === 0) binaries.push(process.env.HKN_PI_BINARY ?? "pi");
for (const executable of binaries) {
  const detected = await runProcess(executable, ["--version"], { cwd: repo, env: withoutCredentials() });
  if (detected.code !== 0) throw new Error(detected.stderr);
  const version = detected.stdout.trim();
  const out = join(repo, ".capture/pi/captured-session-start", version);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const summary = { version, platform: process.platform, date: new Date().toISOString(), nonce: NONCE };
  for (const [surface, probe] of Object.entries({ print: printSurface, rpc: rpcSurface, tui: tuiSurface })) {
    try {
      summary[surface] = await probe(executable);
    } catch (error) {
      summary[surface] = { error: String(error?.stack ?? error) };
    }
  }
  const shown = {
    print: summary.print.runs?.flatMap((run) => [...run.stdout, ...run.stderr]),
    rpc: summary.rpc.stdout && [...Object.keys(summary.rpc.stdout.first), ...Object.keys(summary.rpc.stdout.continue)],
    tui: summary.tui.everPainted && [...summary.tui.everPainted, ...summary.tui.titleSequences],
  };
  const startsOf = {
    print: summary.print.starts,
    rpc: summary.rpc.starts,
    tui: summary.tui.starts,
  };
  // One row per observed start: where its notice and message surfaced, and
  // whether any model request carried either.
  summary.verdicts = Object.entries(startsOf).flatMap(([surface, list]) =>
    (list ?? []).map((start) => {
      const key = `${NONCE}-${start.seq}-${start.reason}`;
      const sent = (summary[surface].requests ?? []).flat();
      return {
        surface,
        seq: start.seq,
        reason: start.reason,
        hasUI: start.hasUI,
        noticeShown: (shown[surface] ?? [])
          .filter((hit) => hit.startsWith(`HKN-NOTICE-${key}-`))
          .map((hit) => hit.slice(`HKN-NOTICE-${key}-`.length))
          .sort(),
        noticeToModel: sent.some((hit) => hit.startsWith(`HKN-NOTICE-${key}`)),
        messageShown: (shown[surface] ?? []).includes(`HKN-MESSAGE-${key}`),
        messageToModel: sent.includes(`HKN-MESSAGE-${key}`),
      };
    }),
  );
  const { screens, ...tui } = summary.tui;
  if (screens) for (const [name, text] of Object.entries(screens)) writeFileSync(join(out, `tui-${name}.txt`), text);
  summary.tui = tui;
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  appendFileSync(join(out, "nonce.txt"), NONCE + "\n");
  console.log(`${version}: ${join(out, "summary.json")}`);
}
