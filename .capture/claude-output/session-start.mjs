#!/usr/bin/env node
// SessionStart output probe with no model spend: which SessionStart responses
// does Claude Code honour, and where does each surface? The companion of
// probe.mjs (the Stop family), driven against the loopback playback model
// instead of a real one, so the model side is observed as recorded requests.
//
//   node --experimental-strip-types .capture/claude-output/session-start.mjs [variant...]
//   variant: notify | compose | context   (default: all three)
//
// Each variant runs a session three times in one scratch project: a fresh
// start, `--resume`, and `/compact` on the resumed session. A second
// SessionStart hook beside the stdin tee answers with the variant's body; every
// string carries a per-run nonce and the hook's `source`, so a match names the
// field and the start reason that produced it. Writes
// .capture/claude-output/captured/session-start/<variant>/ (git-ignored).
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { runProcess, startModelPlayback } = await import(pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href);
const { prepareScratch, withoutCredentials } = await import(pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href);

// A drive started from inside a Claude Code session inherits that session's
// CLAUDE*/CLAUDECODE variables, which make the probe a child session.
for (const name of Object.keys(process.env)) if (/^CLAUDE/.test(name) || name === "AI_AGENT") delete process.env[name];

const OUT = join(REPO, ".capture/claude-output/captured/session-start");
const NONCE = randomBytes(4).toString("hex");
const NOTICE = `HKN-NOTICE-${NONCE}`;
const CONTEXT = `HKN-CONTEXT-${NONCE}`;
const MODEL = "hooknostic-playback";
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "hkn-claude-config-"));

/** The answering hook. Reads the variant and nonces from its environment. */
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

function claudeEnv(baseUrl, variant) {
  return {
    ...withoutCredentials(),
    ANTHROPIC_API_KEY: "hooknostic-playback",
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    HKN_NOTIFY_VARIANT: variant,
    HKN_NOTICE: NOTICE,
    HKN_CONTEXT: CONTEXT,
    // The account's own configuration (user settings, installed plugins and
    // their SessionStart hooks) must not reach the probe session.
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
  };
}

function lines(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** Every stream record whose JSON mentions the marker, reduced to type, subtype and the matching text. */
function surfaced(records, marker) {
  return records
    .filter((record) => JSON.stringify(record).includes(marker))
    .map((record) => ({
      type: record.type,
      subtype: record.subtype,
      ...(record.level ? { level: record.level } : {}),
      excerpt: JSON.stringify(record).slice(0, 400),
    }));
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

async function run(scratch, variant, label, args) {
  const playback = await startModelPlayback("anthropic-messages", "rewrite", [{ kind: "text", text: "ready" }]);
  let result;
  try {
    result = await runProcess(
      "claude",
      [
        "-p",
        ...args,
        "--model",
        MODEL,
        "--settings",
        join(scratch, ".claude", "settings.json"),
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "2",
      ],
      { cwd: scratch, timeoutMs: 180_000, env: claudeEnv(playback.baseUrl, variant) },
    );
  } finally {
    await playback.close();
  }
  const records = lines(result.stdout);
  return {
    label,
    exit: result.code,
    sessionId: records.find((record) => record.type === "system" && record.subtype === "init")?.session_id,
    notice: { stream: surfaced(records, NOTICE), requests: inRequests(playback.requests, NOTICE) },
    context: { stream: surfaced(records, CONTEXT), requests: inRequests(playback.requests, CONTEXT) },
    playbackErrors: playback.errors,
    records,
    requests: playback.requests,
    stderr: result.stderr.slice(-2000),
  };
}

async function variantSession(variant) {
  const scratch = join(mkdtempSync(join(tmpdir(), "hkn-session-start-")), "claude");
  prepareScratch(REPO, "claude", scratch);
  writeFileSync(join(scratch, "notify-probe.mjs"), PROBE, "utf8");
  const settingsPath = join(scratch, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.SessionStart.push({
    hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/notify-probe.mjs"], timeout: 10 }],
  });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

  const runs = [await run(scratch, variant, "startup", ["Reply with the single word ready."])];
  const id = runs[0].sessionId;
  if (id !== undefined) {
    runs.push(await run(scratch, variant, "resume", ["Reply with the single word ready.", "--resume", id]));
    runs.push(await run(scratch, variant, "compact", ["/compact", "--resume", id]));
  }
  const received = readFileSync(join(scratch, "captured", "notify-probe.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).received.source);

  const dest = join(OUT, variant);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of runs) {
    writeFileSync(join(dest, `${entry.label}.stream.json`), JSON.stringify(entry.records, null, 2) + "\n", "utf8");
    writeFileSync(join(dest, `${entry.label}.requests.json`), JSON.stringify(entry.requests, null, 2) + "\n", "utf8");
  }
  const summary = {
    variant,
    nonce: NONCE,
    claude: (await runProcess("claude", ["--version"], { cwd: scratch, env: process.env })).stdout.trim(),
    scratch,
    sourcesReceived: received,
    runs: runs.map(({ records, requests, ...rest }) => rest),
  };
  writeFileSync(join(dest, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  for (const entry of summary.runs) {
    console.log(
      `[${variant}/${entry.label}] exit=${entry.exit} errors=${entry.playbackErrors.length} ` +
        `notice: stream=${entry.notice.stream.map((s) => `${s.type}/${s.subtype ?? "-"}`).join(",") || "none"} ` +
        `requests=${entry.notice.requests.map((r) => r.where.join("+")).join(",") || "none"} | ` +
        `context: stream=${entry.context.stream.map((s) => `${s.type}/${s.subtype ?? "-"}`).join(",") || "none"} ` +
        `requests=${entry.context.requests.map((r) => r.where.join("+")).join(",") || "none"}`,
    );
  }
  console.log(`[${variant}] sources received: ${received.join(", ")} -> ${dest}`);
}

const requested = process.argv.slice(2);
for (const variant of requested.length > 0 ? requested : ["notify", "compose", "context"]) await variantSession(variant);
