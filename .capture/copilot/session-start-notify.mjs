#!/usr/bin/env node
// sessionStart notice probe with no model spend: can a GitHub Copilot CLI hook
// show the user a notice at session start that the model never sees? Driven
// against the loopback playback model through the BYOK variables the playback
// lane uses (runCopilotPlayback), so the model side is observed as recorded
// requests and no provider configured for the account is contacted.
//
//   node --experimental-strip-types .capture/copilot/session-start-notify.mjs [variant...]
//   variant: notify | compose | context | prompt | pascal-notify | pascal-compose | pascal-context | pascal-prompt
//   (default: all eight)
//
// Each variant runs one scratch project four times: a fresh start and a
// `--resume=<id>` of that session, each with text and with `--output-format
// json`. A command hook answers with the variant's body; every string carries
// a per-run nonce and the payload's `source`, so a match names the field and the
// start reason that produced it:
//   HKN-NOTICE-<hex>-<source>   systemMessage
//   HKN-CONTEXT-<hex>-<source>  top-level additionalContext
//   HKN-HSOCTX-<hex>-<source>   hookSpecificOutput.additionalContext (Pascal only)
//   HKN-PROMPT-<hex>            a type:"prompt" entry's prompt
// The `pascal-*` variants register the same body under `SessionStart` instead
// of `sessionStart`. Every nonce is searched in stdout, stderr, the session
// event log under COPILOT_HOME, and each loopback request.
//
// Build selection: COPILOT_BINARY names the executable (default: the installed
// native binary, as probe.mjs resolves it). Left to auto-update, a native
// binary starts the newest build in the shared %LOCALAPPDATA%copilotpkg
// cache whatever its own version; COPILOT_AUTO_UPDATE=false kept a scratch
// 1.0.101 install on 1.0.101, so every run sets it, and the summary records
// `--version` under that environment.
// Writes .capture/copilot/captured/session-start-notify/<build>/<variant>/ (git-ignored).
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveCopilotBinary } from "./probe.mjs";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { runProcess, startModelPlayback } = await import(pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href);
const { withoutCredentials } = await import(pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href);

for (const name of Object.keys(process.env)) if (/^CLAUDE/.test(name) || name === "AI_AGENT") delete process.env[name];

export const BIN = process.env.COPILOT_BINARY ?? resolveCopilotBinary();
export const NONCE = randomBytes(4).toString("hex");
export const MARKERS = {
  notice: `HKN-NOTICE-${NONCE}`,
  context: `HKN-CONTEXT-${NONCE}`,
  hsoContext: `HKN-HSOCTX-${NONCE}`,
  prompt: `HKN-PROMPT-${NONCE}`,
};
const VARIANTS = ["notify", "compose", "context", "prompt"].flatMap((v) => [v, `pascal-${v}`]);

/** The answering hook. Reads the variant and nonce from its environment. */
const HOOK = `import { appendFileSync } from "node:fs";
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const received = raw ? JSON.parse(raw) : {};
const source = received.source ?? "unknown";
const variant = process.env.HKN_VARIANT.replace(/^pascal-/, "");
const pascal = process.env.HKN_VARIANT.startsWith("pascal-");
const body = {};
if (variant === "notify" || variant === "compose") body.systemMessage = process.env.HKN_NOTICE + "-" + source;
if (variant === "context" || variant === "compose") {
  body.additionalContext = process.env.HKN_CONTEXT + "-" + source;
  if (pascal) body.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: process.env.HKN_HSOCTX + "-" + source };
}
appendFileSync(process.env.HKN_LOG, JSON.stringify({ variant: process.env.HKN_VARIANT, received, emitted: body }) + "\\n");
process.stdout.write(JSON.stringify(body));
`;

export function hookFile(variant, hookPath, nonce) {
  const event = variant.startsWith("pascal-") ? "SessionStart" : "sessionStart";
  const entries = variant.endsWith("prompt")
    ? [
        // The prompt entry rides beside a silent command entry, so the log still
        // shows whether (and with which source) the event fired.
        { type: "prompt", prompt: `Reply with the token HKN-PROMPT-${nonce} and nothing else.` },
        { type: "command", exec: process.execPath, args: [hookPath], timeoutSec: 30 },
      ]
    : [{ type: "command", exec: process.execPath, args: [hookPath], timeoutSec: 30 }];
  return { version: 1, hooks: { [event]: entries } };
}

export function copilotEnv(baseUrl, home, extra = {}) {
  return {
    ...withoutCredentials(),
    COPILOT_HOME: home,
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_ALLOW_ALL: "true",
    COPILOT_PROVIDER_BASE_URL: `${baseUrl}/v1`,
    COPILOT_PROVIDER_TYPE: "openai",
    COPILOT_PROVIDER_WIRE_API: "completions",
    COPILOT_PROVIDER_API_KEY: "hooknostic-playback",
    COPILOT_MODEL: "hooknostic-playback",
    COPILOT_PROVIDER_MODEL_ID: "gpt-5.4",
    COPILOT_PROVIDER_WIRE_MODEL: "hooknostic-playback",
    COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "128000",
    COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "8192",
    ...extra,
  };
}

export function copilotVersion() {
  const env = { ...process.env, COPILOT_AUTO_UPDATE: "false" };
  return execFileSync(BIN, ["--version"], { env, encoding: "utf8" }).split(/\r?\n/)[0].trim();
}

/** Prepare a scratch git project with the variant's hook file and a private COPILOT_HOME. */
export function prepareProject(variant, label) {
  const root = mkdtempSync(join(tmpdir(), `hkn-copilot-ssn-${label}-`));
  const project = join(root, "project");
  const home = join(root, "copilot-home");
  mkdirSync(join(project, ".github", "hooks"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(project, "README.md"), "# session start notice probe\n");
  execFileSync("git", ["init", "-q"], { cwd: project });
  const hookPath = join(root, "notify-hook.mjs");
  writeFileSync(hookPath, HOOK, "utf8");
  writeFileSync(join(project, ".github", "hooks", "notify.json"), JSON.stringify(hookFile(variant, hookPath, NONCE), null, 2));
  return { root, project, home, log: join(root, "hook-log.jsonl") };
}

export function hookEnv(variant, log) {
  return {
    HKN_VARIANT: variant,
    HKN_NOTICE: MARKERS.notice,
    HKN_CONTEXT: MARKERS.context,
    HKN_HSOCTX: MARKERS.hsoContext,
    HKN_LOG: log,
  };
}

/** Every events.jsonl record under COPILOT_HOME whose JSON mentions the marker. */
export function inEvents(home, marker) {
  const walk = (dir) =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          return statSync(path).isDirectory() ? walk(path) : [path];
        })
      : [];
  return walk(home)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.includes(marker))
        .map((line) => {
          const record = JSON.parse(line);
          return { type: record.type, excerpt: line.slice(0, 400) };
        }),
    );
}

/** Where in each recorded chat-completions request the marker appears, by message role. */
export function inRequests(requests, marker) {
  return requests.flatMap((body, index) => {
    if (!JSON.stringify(body).includes(marker)) return [];
    const where = (body.messages ?? [])
      .filter((message) => JSON.stringify(message.content ?? "").includes(marker))
      .map((message) => message.role);
    const tokens = [...new Set(JSON.stringify(body).match(new RegExp(`${marker}(?:-[a-z]+)?`, "g")))];
    return [{ request: index, where: where.length > 0 ? where : ["elsewhere"], tokens }];
  });
}

export function sessionIdFrom(log) {
  if (!existsSync(log)) return undefined;
  const first = JSON.parse(readFileSync(log, "utf8").split("\n")[0]);
  return first.received.sessionId ?? first.received.session_id;
}

function report(stdout, stderr, home, requests) {
  return Object.fromEntries(
    Object.entries(MARKERS).map(([key, marker]) => [
      key,
      {
        stdout: stdout.split(/\r?\n/).filter((line) => line.includes(marker)).map((line) => line.slice(0, 400)),
        stderr: stderr.split(/\r?\n/).filter((line) => line.includes(marker)).map((line) => line.slice(0, 400)),
        events: inEvents(home, marker),
        requests: inRequests(requests, marker),
      },
    ]),
  );
}

async function run(paths, variant, label, args) {
  const playback = await startModelPlayback("openai-chat", "rewrite", [{ kind: "text", text: "ready" }]);
  let result;
  try {
    result = await runProcess(
      BIN,
      // The CLI refuses --trust-folder beside --resume, and the startup run
      // records no trust under COPILOT_HOME; COPILOT_ALLOW_ALL (copilotEnv)
      // trusts the folder for a resumed session.
      [
        ...(args.some((arg) => arg.startsWith("--resume")) ? [] : ["--trust-folder"]),
        "--allow-all-tools",
        "--disable-client-telemetry",
        "--no-auto-update",
        ...args,
      ],
      {
        cwd: paths.project,
        timeoutMs: 180_000,
        env: copilotEnv(playback.baseUrl, paths.home, hookEnv(variant, paths.log)),
      },
    );
  } finally {
    await playback.close();
  }
  return {
    label,
    exit: result.code,
    found: report(result.stdout, result.stderr, paths.home, playback.requests),
    playbackErrors: playback.errors,
    stdout: result.stdout,
    stderr: result.stderr,
    requests: playback.requests,
  };
}

function brief(found) {
  return Object.entries(found)
    .map(([key, where]) => {
      const surfaces = [
        where.stdout.length ? "stdout" : "",
        where.stderr.length ? "stderr" : "",
        where.events.length ? `events(${[...new Set(where.events.map((e) => e.type))].join("+")})` : "",
        where.requests.length
          ? `model(${[...new Set(where.requests.flatMap((r) => r.where))].join("+")}: ${[...new Set(where.requests.flatMap((r) => r.tokens))].map((t) => t.split("-").at(-1)).join("+")})`
          : "",
      ].filter(Boolean);
      return surfaces.length ? `${key}=${surfaces.join(",")}` : "";
    })
    .filter(Boolean)
    .join(" ") || "nothing";
}

async function variantSession(variant, build, outRoot) {
  const paths = prepareProject(variant, variant);
  const prompt = "Reply with the single word ready.";
  const runs = [];
  for (const format of ["text", "json"]) {
    const formatArgs = format === "json" ? ["--output-format", "json"] : [];
    const before = existsSync(paths.log) ? readFileSync(paths.log, "utf8").split("\n").filter(Boolean).length : 0;
    runs.push(await run(paths, variant, `startup-${format}`, [...formatArgs, "-p", prompt]));
    const id = (() => {
      const lines = readFileSync(paths.log, "utf8").split("\n").filter(Boolean);
      const record = lines[before] && JSON.parse(lines[before]);
      return record?.received.sessionId ?? record?.received.session_id;
    })();
    if (id !== undefined) runs.push(await run(paths, variant, `resume-${format}`, [...formatArgs, `--resume=${id}`, "-p", prompt]));
  }
  const hookLog = existsSync(paths.log)
    ? readFileSync(paths.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const dest = join(outRoot, variant);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of runs) {
    writeFileSync(join(dest, `${entry.label}.stdout.txt`), entry.stdout, "utf8");
    writeFileSync(join(dest, `${entry.label}.stderr.txt`), entry.stderr, "utf8");
    writeFileSync(join(dest, `${entry.label}.requests.json`), JSON.stringify(entry.requests, null, 2) + "\n", "utf8");
  }
  const summary = {
    variant,
    nonce: NONCE,
    copilot: build,
    hookFile: hookFile(variant, "<hook>", NONCE),
    hookFired: hookLog.map((record) => ({ source: record.received.source, event: record.received.hook_event_name ?? "sessionStart" })),
    runs: runs.map(({ stdout, stderr, requests, ...rest }) => ({ ...rest, requestCount: requests.length })),
  };
  writeFileSync(join(dest, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  for (const entry of summary.runs) {
    console.log(`[${variant}/${entry.label}] exit=${entry.exit} requests=${entry.requestCount} errors=${entry.playbackErrors.length} ${brief(entry.found)}`);
  }
  console.log(`[${variant}] hook fired: ${summary.hookFired.map((h) => `${h.event}/${h.source}`).join(", ") || "never"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const build = copilotVersion();
  console.log(`${build} (${BIN}) nonce ${NONCE}`);
  const outRoot = join(REPO, ".capture/copilot/captured/session-start-notify", build.match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown");
  const requested = process.argv.slice(2);
  for (const variant of requested.length > 0 ? requested : VARIANTS) {
    if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}; known: ${VARIANTS.join(", ")}`);
    await variantSession(variant, build, outRoot);
  }
}
