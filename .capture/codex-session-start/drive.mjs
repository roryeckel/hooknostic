#!/usr/bin/env node
// SessionStart notice probe for Codex CLI, with no model spend: can a
// SessionStart hook show the USER a notice that the MODEL never sees? The Codex
// companion of .capture/claude-output/session-start.mjs and session-start-pty.mjs.
//
//   HOOKNOSTIC_CODEX_BIN=<codex.exe> node --experimental-strip-types \
//     .capture/codex-session-start/drive.mjs [--surface exec|tui|all] [variant...]
//   variant: notify | compose | context | invalid   (default: all four)
//
// A SessionStart hook in a trusted scratch project answers with the variant's
// body; every string carries a per-run nonce and the payload's `source`, so a
// match names the field and the start reason. The model is the loopback
// playback server, so the model side is observed as the requests it recorded.
//
// exec surface: `codex exec` and `codex exec resume <id>`, each with the
// default human-readable output and with `--json`.
// tui surface: the interactive TUI under node-pty, read through a headless
// xterm screen. One session walks startup -> a prompt -> /compact -> /clear;
// then `codex resume <id>` and `codex fork <id>` start two more.
//
// CODEX_HOME is a fresh directory per variant holding its own trust entry and
// `[windows] sandbox`, so nothing reads or writes ~/.codex. Writes
// .capture/codex-session-start/captured/<codex-version>/<variant>/ (git-ignored).
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { runProcess, startModelPlayback } = await import(pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href);
const { withoutCredentials } = await import(pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href);
const requireFromCli = createRequire(join(REPO, "packages/cli/package.json"));
const pty = requireFromCli("node-pty");
const { Terminal } = requireFromCli("@xterm/headless");

const NONCE = randomBytes(4).toString("hex");
const NOTICE = `HKN-NOTICE-${NONCE}`;
const CONTEXT = `HKN-CONTEXT-${NONCE}`;
const MODEL = "hooknostic-playback";
const COLS = 160;
const ROWS = 50;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function codexBinary() {
  if (process.env["HOOKNOSTIC_CODEX_BIN"]) return resolve(process.env["HOOKNOSTIC_CODEX_BIN"]);
  const found = execSync(process.platform === "win32" ? "where codex" : "which codex", { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => (process.platform === "win32" ? /\.(?:exe|cmd)$/i.test(line) : line !== ""));
  if (!found) throw new Error("codex binary not found: set HOOKNOSTIC_CODEX_BIN");
  return found;
}
const BIN = codexBinary();
const VERSION = execFileSync(BIN, ["--version"], { encoding: "utf8", shell: /\.cmd$/i.test(BIN) }).trim();
const HELP = execFileSync(BIN, ["--help"], { encoding: "utf8", shell: /\.cmd$/i.test(BIN) });
const OUT = join(REPO, ".capture/codex-session-start/captured", VERSION.replace(/^codex-cli\s+/, ""));
/** The variant's output directory; TUI snapshots write into it as they are taken. */
let DEST = OUT;

/** The answering hook. Reads the variant and nonces from its environment. */
const PROBE = `import { appendFileSync } from "node:fs";
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
// Control: a field the additionalProperties:false schema rejects, so a
// "Completed" line on the other variants can be read as "validated".
if (variant === "invalid") body.hknUnknownField = process.env.HKN_NOTICE + "-" + source;
appendFileSync(process.env.HKN_PROBE_LOG, JSON.stringify({ variant, received, emitted: body }) + "\\n");
process.stdout.write(JSON.stringify(body));
`;

const toml = (value) => `'${String(value).replaceAll("'", "''")}'`;

function prepare(variant) {
  const root = mkdtempSync(join(tmpdir(), `hkn-codex-session-start-${variant}-`));
  const project = join(root, "project");
  const home = join(root, "codex-home");
  mkdirSync(join(project, ".codex"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(project, "README.md"), "# SessionStart notice probe\n");
  writeFileSync(join(root, "notify-probe.mjs"), PROBE, "utf8");
  const probe = join(root, "notify-probe.mjs").replaceAll("\\", "/");
  writeFileSync(
    join(project, ".codex", "hooks.json"),
    JSON.stringify(
      { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node "${probe}"`, timeout: 10 }] }] } },
      null,
      2,
    ),
  );
  execFileSync("git", ["init", "-q"], { cwd: project });
  return { root, project, home, log: join(root, "notify-probe.jsonl") };
}

function writeConfig(scratch, baseUrl) {
  writeFileSync(
    join(scratch.home, "config.toml"),
    [
      `model = "${MODEL}"`,
      'model_provider = "hooknostic_playback"',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      "check_for_update_on_startup = false",
      "",
      "[model_providers.hooknostic_playback]",
      'name = "Hooknostic Playback"',
      `base_url = ${toml(`${baseUrl}/v1`)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
      `[projects.${toml(scratch.project)}]`,
      'trust_level = "trusted"',
      "",
      "[windows]",
      'sandbox = "unelevated"',
      "",
    ].join("\n"),
  );
}

function environment(scratch, variant) {
  const env = {};
  // A drive started from inside an agent session must not look like a child of it.
  for (const [name, value] of Object.entries(withoutCredentials())) {
    if (!/^(?:CLAUDE|CODEX_)/.test(name) && name !== "AI_AGENT") env[name] = value;
  }
  return {
    ...env,
    CODEX_HOME: scratch.home,
    HKN_NOTIFY_VARIANT: variant,
    HKN_NOTICE: NOTICE,
    HKN_CONTEXT: CONTEXT,
    HKN_PROBE_LOG: scratch.log,
  };
}

function probeLog(scratch) {
  if (!existsSync(scratch.log)) return [];
  return readFileSync(scratch.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Where in each Responses request a marker appears: instructions, or an input item's role/type. */
function inRequests(requests, marker) {
  return requests.flatMap((body, index) => {
    if (!JSON.stringify(body).includes(marker)) return [];
    const where = [];
    if (JSON.stringify(body.instructions ?? "").includes(marker)) where.push("instructions");
    for (const item of body.input ?? []) {
      if (JSON.stringify(item).includes(marker)) where.push(item.role ?? item.type ?? "item");
    }
    return [{ request: index, where: where.length > 0 ? where : ["elsewhere"], sources: locate(JSON.stringify(body), marker) }];
  });
}

function locate(text, marker) {
  const sources = [];
  for (const match of text.matchAll(new RegExp(`${marker}-(startup|resume|clear|compact|fork|unknown)`, "g"))) {
    sources.push(match[1]);
  }
  return [...new Set(sources)];
}

const modelSide = (requests, from) => ({
  notice: inRequests(requests.slice(from), NOTICE).map((r) => ({ ...r, request: r.request + from })),
  context: inRequests(requests.slice(from), CONTEXT).map((r) => ({ ...r, request: r.request + from })),
});

// ---------------------------------------------------------------------------
// exec surface
// ---------------------------------------------------------------------------

async function exec(scratch, variant, playback, label, args) {
  const from = playback.requests.length;
  const before = probeLog(scratch).length;
  const result = await runProcess(
    BIN,
    // `exec resume` rejects `--color`; resumed runs keep the default.
    ["exec", ...args, "--dangerously-bypass-hook-trust", "--skip-git-repo-check", ...(args[0] === "resume" ? [] : ["--color", "never"])],
    { cwd: scratch.project, timeoutMs: 120_000, env: environment(scratch, variant), input: "" },
  );
  const fired = probeLog(scratch).slice(before);
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    label,
    exit: result.code,
    sources: fired.map((entry) => entry.received.source),
    sessionId: fired[0]?.received.session_id,
    notice: { stdout: locate(result.stdout, NOTICE), stderr: locate(result.stderr, NOTICE) },
    context: { stdout: locate(result.stdout, CONTEXT), stderr: locate(result.stderr, CONTEXT) },
    requests: modelSide(playback.requests, from),
    hookLines: output.split(/\r?\n/).filter((line) => /hook|SessionStart/i.test(line)).slice(0, 20),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function execSurface(variant) {
  const scratch = prepare(variant);
  const playback = await startModelPlayback("openai-responses", "rewrite", [{ kind: "text", text: "ready" }]);
  writeConfig(scratch, playback.baseUrl);
  const prompt = "Reply with the single word ready.";
  const runs = [];
  try {
    runs.push(await exec(scratch, variant, playback, "startup", [prompt]));
    runs.push(await exec(scratch, variant, playback, "startup-json", ["--json", prompt]));
    const plainId = runs[0].sessionId;
    const jsonId = runs[1].sessionId;
    if (plainId) runs.push(await exec(scratch, variant, playback, "resume", ["resume", plainId, prompt]));
    if (jsonId) runs.push(await exec(scratch, variant, playback, "resume-json", ["resume", "--json", jsonId, prompt]));
  } finally {
    await playback.close();
  }
  return { scratch, playback, runs };
}

// ---------------------------------------------------------------------------
// tui surface
// ---------------------------------------------------------------------------

function screenReader() {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  return {
    write: (data) => new Promise((done) => terminal.write(data, done)),
    /** The whole buffer, scrollback included: Codex's inline TUI scrolls finished history above the viewport. */
    all() {
      const buffer = terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").join(
        "\n",
      );
    },
    viewport() {
      const buffer = terminal.buffer.active;
      return Array.from({ length: terminal.rows }, (_, row) =>
        buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
      ).join("\n");
    },
  };
}

const compact = (text) => stripVTControlCharacters(text).replace(/\s+/g, "");

async function waitFor(read, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(read())) return true;
    await sleep(250);
  }
  return false;
}

/** One interactive Codex process; `steps` runs inside it while the screen is recorded. */
async function tui(scratch, variant, playback, label, argv, steps) {
  const before = probeLog(scratch).length;
  const from = playback.requests.length;
  const extra = HELP.includes("--no-daemon") ? ["--no-daemon"] : [];
  const fullArgv = [...argv, "--dangerously-bypass-hook-trust", ...extra];
  const options = { name: "xterm-256color", cols: COLS, rows: ROWS, cwd: scratch.project, env: environment(scratch, variant) };
  const child = /\.cmd$/i.test(BIN)
    ? pty.spawn(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/c", BIN, ...fullArgv], options)
    : pty.spawn(BIN, fullArgv, options);
  const screen = screenReader();
  let raw = "";
  let exited = false;
  child.onData((data) => {
    raw += data;
    void screen.write(data);
  });
  child.onExit(() => {
    exited = true;
  });
  const snapshots = [];
  const ctx = {
    type: async (text) => {
      for (const char of text) {
        child.write(char);
        await sleep(15);
      }
    },
    enter: () => child.write("\r"),
    /**
     * Types into an idle, empty composer and presses Enter until the playback
     * server sees a new request (or, for a command that makes none, until the
     * composer is empty again). Keystrokes sent while the TUI is still loading
     * a resumed thread, or still compacting, are dropped or merged otherwise.
     */
    submit: async (text, expectRequest = true) => {
      const idle = (view) => compact(view).includes("AskCodextodoanything") && !/esc to interrupt/i.test(view);
      await waitFor(() => screen.viewport(), idle, 60_000);
      await sleep(1_000);
      await ctx.type(text);
      await waitFor(() => compact(screen.viewport()), (view) => view.includes(compact(text)), 10_000);
      const sent = ctx.requestCount();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        child.write("\r");
        const done = expectRequest
          ? await ctx.waitForRequests(sent + 1, 20_000)
          : await waitFor(() => screen.viewport(), idle, 20_000);
        if (done) break;
      }
      await waitFor(() => screen.viewport(), idle, 60_000);
      await sleep(3_000);
    },
    sleep,
    screen,
    sources: () => probeLog(scratch).slice(before).map((entry) => entry.received.source),
    waitFor: (predicate, ms) => waitFor(() => compact(screen.all()), predicate, ms),
    waitForRequests: (count, ms) => waitFor(() => playback.requests.length - from, (n) => n >= count, ms),
    requestCount: () => playback.requests.length - from,
    snapshot: (step) => {
      console.error(`  tui/${label}: ${step} (sources so far: ${ctx.sources().join(",") || "none"})`);
      mkdirSync(DEST, { recursive: true });
      writeFileSync(join(DEST, `tui-${label}-${step}.viewport.txt`), screen.viewport(), "utf8");
      snapshots.push({
        step,
        sources: ctx.sources(),
        noticeOnScreen: locate(compact(screen.all()), NOTICE),
        contextOnScreen: locate(compact(screen.all()), CONTEXT),
        noticeInRaw: locate(compact(raw), NOTICE),
        requests: modelSide(playback.requests, from),
      });
    },
  };
  let error;
  try {
    await steps(ctx);
  } catch (caught) {
    error = String(caught?.stack ?? caught);
  } finally {
    if (!exited) {
      child.write("\u0003");
      await sleep(500);
      if (!exited) child.write("\u0003");
      await sleep(1500);
      if (!exited) child.kill();
    }
    console.error(`  tui/${label}: done (exited=${exited})`);
  }
  const fired = probeLog(scratch).slice(before);
  return {
    label,
    argv: fullArgv,
    error,
    sources: fired.map((entry) => entry.received.source),
    sessionIds: [...new Set(fired.map((entry) => entry.received.session_id))],
    snapshots,
    screen: screen.all(),
    raw: stripVTControlCharacters(raw),
  };
}

/** The composer is ready once the startup header and a prompt hint are drawn. */
const composerReady = (text) => /model:|directory:/i.test(text) && /(?:›|>)/.test(text);

async function tuiSurface(variant) {
  const scratch = prepare(variant);
  const playback = await startModelPlayback("openai-responses", "rewrite", [{ kind: "text", text: "ready" }]);
  writeConfig(scratch, playback.baseUrl);
  const runs = [];
  try {
    runs.push(
      await tui(scratch, variant, playback, "startup", [], async (t) => {
        await t.waitFor(composerReady, 60_000);
        await t.sleep(5_000);
        t.snapshot("startup");
        await t.submit("Reply with the single word ready.");
        t.snapshot("after-prompt");
        // SessionStart is dispatched with a session's first submitted turn, not
        // when the composer appears, so each command is followed by a prompt.
        // /compact calls the model; /clear does not.
        for (const command of ["/compact", "/clear"]) {
          await t.submit(command, command === "/compact");
          t.snapshot(`after-${command.slice(1)}`);
          await t.submit("Reply with the single word ready.");
          t.snapshot(`after-${command.slice(1)}-prompt`);
        }
      }),
    );
    const id = runs[0].sessionIds[0];
    if (id !== undefined) {
      for (const mode of ["resume", "fork"]) {
        runs.push(
          await tui(scratch, variant, playback, mode, [mode, id], async (t) => {
            await t.waitFor(composerReady, 60_000);
            await t.sleep(5_000);
            t.snapshot(mode);
            await t.submit("Reply with the single word ready.");
            t.snapshot(`${mode}-after-prompt`);
          }),
        );
      }
    }
  } finally {
    await playback.close();
  }
  return { scratch, playback, runs };
}

// ---------------------------------------------------------------------------

function save(dest, surface, result) {
  mkdirSync(dest, { recursive: true });
  for (const run of result.runs) {
    const base = join(dest, `${surface}-${run.label}`);
    if (run.stdout !== undefined) writeFileSync(`${base}.stdout.txt`, run.stdout, "utf8");
    if (run.stderr !== undefined) writeFileSync(`${base}.stderr.txt`, run.stderr, "utf8");
    if (run.screen !== undefined) writeFileSync(`${base}.screen.txt`, run.screen, "utf8");
    if (run.raw !== undefined) writeFileSync(`${base}.raw.txt`, run.raw, "utf8");
  }
  writeFileSync(join(dest, `${surface}-requests.json`), JSON.stringify(result.playback.requests, null, 2) + "\n");
  writeFileSync(join(dest, `${surface}-probe-log.json`), JSON.stringify(probeLog(result.scratch), null, 2) + "\n");
  return result.runs.map(({ stdout, stderr, screen, raw, ...rest }) => rest);
}

const argv = process.argv.slice(2);
const surfaceAt = argv.indexOf("--surface");
const surface = surfaceAt === -1 ? "all" : argv[surfaceAt + 1];
const variants = argv.filter((arg, index) => !arg.startsWith("--") && index !== surfaceAt + 1);
for (const variant of variants.length > 0 ? variants : ["notify", "compose", "context", "invalid"]) {
  const dest = join(OUT, variant);
  DEST = dest;
  rmSync(dest, { recursive: true, force: true });
  const summary = { variant, nonce: NONCE, codex: VERSION, binary: BIN };
  if (surface === "exec" || surface === "all") summary.exec = save(dest, "exec", await execSurface(variant));
  if (surface === "tui" || surface === "all") summary.tui = save(dest, "tui", await tuiSurface(variant));
  writeFileSync(join(dest, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  for (const run of summary.exec ?? []) {
    console.log(
      `[${VERSION} ${variant} exec/${run.label}] exit=${run.exit} sources=${run.sources.join(",") || "none"} ` +
        `notice stdout=${run.notice.stdout.join(",") || "-"} stderr=${run.notice.stderr.join(",") || "-"} ` +
        `model=${run.requests.notice.map((r) => r.where.join("+")).join(",") || "none"} | ` +
        `context stdout=${run.context.stdout.join(",") || "-"} stderr=${run.context.stderr.join(",") || "-"} ` +
        `model=${run.requests.context.map((r) => r.where.join("+")).join(",") || "none"}`,
    );
  }
  for (const run of summary.tui ?? []) {
    for (const snap of run.snapshots) {
      console.log(
        `[${VERSION} ${variant} tui/${run.label}/${snap.step}] sources=${snap.sources.join(",") || "none"} ` +
          `notice screen=${snap.noticeOnScreen.join(",") || "-"} model=${snap.requests.notice.map((r) => r.where.join("+")).join(",") || "none"} | ` +
          `context screen=${snap.contextOnScreen.join(",") || "-"} model=${snap.requests.context.map((r) => r.where.join("+")).join(",") || "none"}`,
      );
    }
    if (run.error) console.log(`[${VERSION} ${variant} tui/${run.label}] error: ${run.error.split("\n")[0]}`);
  }
  console.log(`[${variant}] -> ${dest}`);
}
// node-pty's ConPTY agent can keep the event loop alive after every child exits.
process.exit(0);
