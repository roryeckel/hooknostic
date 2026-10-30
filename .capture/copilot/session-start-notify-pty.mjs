#!/usr/bin/env node
// Interactive companion of session-start-notify.mjs: does the Copilot TUI show
// a sessionStart `systemMessage`, or a `type:"prompt"` entry, to the user, and
// does either reach the model? Headless `-p` surfaced neither (README). This
// starts the real TUI under node-pty with an @xterm/headless screen against the
// loopback playback model (the same BYOK variables), waits for the main input
// line, and searches the rendered screen for each nonce. It then submits one
// prompt so a model request exists to search; the event fires on that first
// prompt, not at launch. The startup session then runs `/clear` and a second
// prompt, exits, and the session is repeated with `--resume=<id>`.
//
//   node --experimental-strip-types .capture/copilot/session-start-notify-pty.mjs [variant...]
//   variant: as session-start-notify.mjs (default: notify compose prompt pascal-notify)
//
// COPILOT_BINARY selects the build, as in the headless probe.
// Writes .capture/copilot/captured/session-start-notify-pty/<build>/<variant>/ (git-ignored).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BIN,
  MARKERS,
  NONCE,
  copilotEnv,
  copilotVersion,
  hookEnv,
  inEvents,
  inRequests,
  prepareProject,
  sessionIdFrom,
} from "./session-start-notify.mjs";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { startModelPlayback } = await import(pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href);
const requireFromCli = createRequire(join(REPO, "packages/cli/package.json"));
const pty = requireFromCli("node-pty");
const { Terminal } = requireFromCli("@xterm/headless");

const COLS = 160;
const ROWS = 50;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function screen() {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  return {
    write: (data) => new Promise((done) => terminal.write(data, done)),
    /** The whole buffer, scrollback included, as plain text. */
    text() {
      const buffer = terminal.buffer.active;
      return stripVTControlCharacters(
        Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").join("\n"),
      );
    },
  };
}

async function waitFor(read, predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(read())) return true;
    await sleep(250);
  }
  console.log(`timed out waiting for ${label}`);
  return false;
}

const promptReady = (text) => text.split("\n").some((line) => line.trim() === "❯") && !text.slice(-2000).includes("Loading:");

/** The screen lines that carry a marker; the screen wraps at COLS, so the nonce is matched whole. */
function onScreen(text) {
  return Object.fromEntries(
    Object.entries(MARKERS).map(([key, marker]) => [key, text.split("\n").filter((line) => line.includes(marker)).map((line) => line.trim())]),
  );
}

async function session(paths, variant, label, args, clear = false) {
  const playback = await startModelPlayback("openai-chat", "rewrite", [{ kind: "text", text: "ready" }]);
  const terminal = screen();
  const chunks = [];
  let exited = false;
  const child = pty.spawn(
    BIN,
    // --trust-folder is refused outside a new -p session; COPILOT_ALLOW_ALL
    // (copilotEnv) trusts the folder instead.
    ["--allow-all-tools", "--disable-client-telemetry", "--no-auto-update", ...args],
    {
      name: "xterm-256color",
      cols: COLS,
      rows: ROWS,
      cwd: paths.project,
      env: { ...copilotEnv(playback.baseUrl, paths.home, hookEnv(variant, paths.log)), TERM: "xterm-256color" },
    },
  );
  child.onData((data) => {
    chunks.push(data);
    void terminal.write(data);
  });
  child.onExit(() => {
    exited = true;
  });
  let atStart;
  let afterTurn;
  let afterClear;
  let startRequests = 0;
  try {
    await waitFor(() => terminal.text(), promptReady, 120_000, `${label} main prompt`);
    // A prompt hook, if it submits anything, does so around the first prompt.
    await sleep(6_000);
    atStart = terminal.text();
    startRequests = playback.requests.length;
    child.write("Reply with the single word ready.");
    await sleep(400);
    child.write("\r");
    await waitFor(() => playback.requests.length, (count) => count > startRequests, 30_000, `${label} model request`);
    await sleep(5_000);
    afterTurn = terminal.text();
    if (clear) {
      // /clear starts a fresh session inside the running TUI: another start
      // source candidate. A prompt follows, since the event waits for one.
      child.write("/clear");
      await sleep(500);
      child.write("\r");
      await sleep(4_000);
      const before = playback.requests.length;
      child.write("Reply with the single word ready.");
      await sleep(400);
      child.write("\r");
      await waitFor(() => playback.requests.length, (count) => count > before, 30_000, `${label} post-clear request`);
      await sleep(5_000);
      afterClear = terminal.text();
    }
  } finally {
    try {
      child.write("/exit\r");
    } catch {
      // The TUI may already be gone.
    }
    await sleep(3_000);
    if (!exited) {
      try {
        child.kill();
      } catch {
        // ConPTY teardown is best effort.
      }
    }
    await playback.close();
  }
  return {
    label,
    screenAtStart: onScreen(atStart ?? ""),
    screenAfterTurn: onScreen(afterTurn ?? ""),
    ...(clear ? { screenAfterClear: onScreen(afterClear ?? "") } : {}),
    requestsBeforeTyping: startRequests,
    requests: Object.fromEntries(Object.keys(MARKERS).map((key) => [key, inRequests(playback.requests, MARKERS[key])])),
    events: Object.fromEntries(Object.keys(MARKERS).map((key) => [key, inEvents(paths.home, MARKERS[key]).map((e) => e.type)])),
    playbackErrors: playback.errors,
    raw: { ansi: chunks.join(""), atStart: atStart ?? "", afterTurn: (afterClear ?? afterTurn) ?? "", requests: playback.requests },
  };
}

function brief(result) {
  return Object.keys(MARKERS)
    .map((key) => {
      const parts = [
        result.screenAtStart[key].length ? "screen@start" : "",
        result.screenAfterTurn[key].length && !result.screenAtStart[key].length ? "screen@turn" : "",
        result.screenAfterClear?.[key].length ? "screen@clear" : "",
        result.requests[key].length
          ? `model(${[...new Set(result.requests[key].flatMap((r) => r.where))].join("+")}: ${[...new Set(result.requests[key].flatMap((r) => r.tokens))].map((t) => t.split("-").at(-1)).join("+")})`
          : "",
      ].filter(Boolean);
      return parts.length ? `${key}=${parts.join(",")}` : "";
    })
    .filter(Boolean)
    .join(" ") || "nothing";
}

async function variantSession(variant, build, outRoot) {
  const paths = prepareProject(variant, `pty-${variant}`);
  const runs = [await session(paths, variant, "startup", [], true)];
  const id = sessionIdFrom(paths.log);
  if (id !== undefined) runs.push(await session(paths, variant, "resume", [`--resume=${id}`]));
  const dest = join(outRoot, variant);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of runs) {
    writeFileSync(join(dest, `${entry.label}.ansi`), entry.raw.ansi, "utf8");
    writeFileSync(join(dest, `${entry.label}.start.txt`), entry.raw.atStart, "utf8");
    writeFileSync(join(dest, `${entry.label}.turn.txt`), entry.raw.afterTurn, "utf8");
    writeFileSync(join(dest, `${entry.label}.requests.json`), JSON.stringify(entry.raw.requests, null, 2) + "\n", "utf8");
  }
  // In the TUI the event fires on the first submitted prompt, not at launch:
  // its payload's initialPrompt is the typed text.
  const hookFired = existsSync(paths.log)
    ? readFileSync(paths.log, "utf8").split("\n").filter(Boolean).map((line) => {
        const { received } = JSON.parse(line);
        return { source: received.source, initialPrompt: received.initialPrompt ?? received.initial_prompt };
      })
    : [];
  const summary = { variant, nonce: NONCE, copilot: build, hookFired, runs: runs.map(({ raw, ...rest }) => rest) };
  writeFileSync(join(dest, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(`[pty ${variant}] hook fired: ${hookFired.map((h) => h.source).join(", ") || "never"}`);
  for (const entry of summary.runs) {
    console.log(`[pty ${variant}/${entry.label}] preTyping=${entry.requestsBeforeTyping} errors=${entry.playbackErrors.length} ${brief(entry)}`);
  }
}

const build = copilotVersion();
console.log(`${build} (${BIN}) nonce ${NONCE}`);
const outRoot = join(REPO, ".capture/copilot/captured/session-start-notify-pty", build.match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown");
const requested = process.argv.slice(2);
for (const variant of requested.length > 0 ? requested : ["notify", "compose", "prompt", "pascal-notify"]) {
  await variantSession(variant, build, outRoot);
}
process.exit(0);
