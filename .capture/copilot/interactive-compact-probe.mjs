// Manual preCompact capture for GitHub Copilot CLI.
//
// usage: node .capture/copilot/interactive-compact-probe.mjs [observe|block-json|block-exit2|context]
//
// Starts the real TUI under node-pty, sends a short prompt, then the
// interactive /compact command with a preCompact tee attached. The raw
// payload lands in captured/interactive-compact[-<mode>]/preCompact.jsonl.
// A mode other than observe makes the tee answer: `block-json` returns
// {decision:"block"}, `block-exit2` exits 2, and `context` returns
// additionalContext. After the compaction attempt the probe asks the model for
// the context token, and prints the session-event types, so a block shows as a
// missing compaction and a delivered context as a quoted token. sessionStart
// and an undocumented postCompact name are teed too, in a separate hook file.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { resolveCopilotBinary } from "./probe.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const requireFromCli = createRequire(resolve(REPO, "packages/cli/package.json"));
const pty = requireFromCli("node-pty");
const { Terminal } = requireFromCli("@xterm/headless");
const BIN = resolveCopilotBinary();
const TEE = resolve(import.meta.dirname, "tee.mjs");

const MODE = process.argv[2] ?? "observe";
const ANSWERS = {
  observe: { output: "", exitCode: "0" },
  "block-json": { output: JSON.stringify({ decision: "block", reason: "hooknostic-compact-block" }), exitCode: "0" },
  "block-exit2": { output: "", exitCode: "2" },
  context: { output: JSON.stringify({ additionalContext: "hooknostic-compact-token-8a3c" }), exitCode: "0" },
};
if (ANSWERS[MODE] === undefined) throw new Error(`unknown mode ${MODE}; known: ${Object.keys(ANSWERS).join(", ")}`);
const SUFFIX = MODE === "observe" ? "" : `-${MODE}`;

const ROOT = join(process.env.TEMP ?? ".", `hooknostic-copilot-compact-manual${SUFFIX}`);
const SCRATCH = join(ROOT, "project");
const OUT = join(REPO, `.capture/copilot/captured/interactive-compact${SUFFIX}`);

function screenReader() {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  return {
    write: (data) => new Promise((done) => terminal.write(data, done)),
    read() {
      const buffer = terminal.buffer.active;
      return Array.from({ length: terminal.rows }, (_, row) =>
        buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
      ).join("\n");
    },
    plain() {
      return stripVTControlCharacters(this.read());
    },
  };
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(read, predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(read())) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}\n${read()}`);
}

rmSync(ROOT, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(SCRATCH, ".copilot-home"), { recursive: true });
mkdirSync(join(SCRATCH, ".github", "hooks"), { recursive: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(SCRATCH, ".copilot-home", "config.json"),
  `${JSON.stringify(
    {
      firstLaunchAt: new Date().toISOString(),
      appTipShown: true,
      reasoningSummariesCleanupDone: true,
      askedSetupTerminals: ["windows-terminal"],
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(SCRATCH, "README.md"), "# interactive compact probe\n");
writeFileSync(
  join(SCRATCH, ".github", "hooks", "hooknostic.json"),
  `${JSON.stringify(
    {
      version: 1,
      hooks: {
        preCompact: [
          {
            type: "command",
            exec: process.execPath,
            args: [TEE, OUT, "preCompact", ANSWERS[MODE].output, ANSWERS[MODE].exitCode],
            timeoutSec: 30,
          },
        ],
      },
    },
    null,
    2,
  )}\n`,
);
const tee = (label) => ({ type: "command", exec: process.execPath, args: [TEE, OUT, label, "", "0"], timeoutSec: 30 });
writeFileSync(
  join(SCRATCH, ".github", "hooks", "extra.json"),
  `${JSON.stringify({ version: 1, hooks: { sessionStart: [tee("sessionStart")], postCompact: [tee("postCompact")] } }, null, 2)}\n`,
);

function eventTypes() {
  const walk = (dir) =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          return statSync(path).isDirectory() ? walk(path) : [path];
        })
      : [];
  const counts = {};
  for (const path of walk(join(SCRATCH, ".copilot-home")).filter((file) => file.endsWith("events.jsonl"))) {
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const type = JSON.parse(line).type;
      counts[type] = (counts[type] ?? 0) + 1;
    }
  }
  return counts;
}

const child = pty.spawn(BIN, ["--disable-client-telemetry", "--no-auto-update", "--allow-all-tools"], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: SCRATCH,
  env: {
    ...process.env,
    COPILOT_HOME: join(SCRATCH, ".copilot-home"),
    COPILOT_ALLOW_ALL: "true",
    COPILOT_AUTO_UPDATE: "false",
    TERM: "xterm-256color",
  },
});
const terminal = screenReader();
const chunks = [];
let exited = false;
child.onData((data) => {
  chunks.push(data);
  void terminal.write(data);
});
child.onExit(() => {
  exited = true;
});

try {
  await waitFor(
    () => terminal.plain(),
    (text) => text.split("\n").some((line) => line.trim() === "❯") && !text.slice(-2000).includes("Loading:"),
    120_000,
    "main prompt",
  );
  await sleep(1500);
  child.write("Say hello in one sentence.");
  await sleep(400);
  child.write("\r");
  await sleep(700);
  child.write("\r");
  await sleep(8_000);
  child.write("/compact");
  await sleep(500);
  child.write("\r");
  await waitFor(
    () => existsSync(join(OUT, "preCompact.jsonl")),
    (exists) => exists,
    60_000,
    "preCompact capture",
  );
  await sleep(8_000);
  console.log("captured preCompact");
  console.log(terminal.plain().slice(-3000));
  child.write("Reply with the exact value of any token beginning hooknostic-compact in your context, or reply NONE.");
  await sleep(400);
  child.write("\r");
  await sleep(700);
  child.write("\r");
  await sleep(45_000);
  console.log("---- after follow-up");
  console.log(terminal.plain().slice(-2500));
  console.log(`---- events ${JSON.stringify(eventTypes())}`);
} finally {
  writeFileSync(join(OUT, "final.ansi"), chunks.join(""));
  writeFileSync(join(OUT, "final.txt"), terminal.plain());
  try {
    child.write("/exit\r");
  } catch {
    // The TUI may already be gone.
  }
  await sleep(2500);
  if (!exited) {
    try {
      child.kill();
    } catch {
      // ConPTY teardown is best effort.
    }
  }
}
process.exit(0);
