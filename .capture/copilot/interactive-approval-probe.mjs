// Interactive approval capture for GitHub Copilot CLI.
//
// usage: node .capture/copilot/interactive-approval-probe.mjs allow|deny
//
// A preToolUse hook returns permissionDecision "ask". The probe drives the
// real TUI under node-pty, selects Yes or No in the native "Hook permission
// request" dialog, and asserts the structured session log: an approved ask
// runs the command, a denied ask does not.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { resolveCopilotBinary } from "./probe.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const requireFromCli = createRequire(resolve(REPO, "packages/cli/package.json"));
const pty = requireFromCli("node-pty");
const { Terminal } = requireFromCli("@xterm/headless");
const BIN = resolveCopilotBinary();
const TEE = resolve(import.meta.dirname, "tee.mjs");

const mode = process.argv[2];
if (mode !== "allow" && mode !== "deny") {
  console.error("usage: node .capture/copilot/interactive-approval-probe.mjs allow|deny");
  process.exit(2);
}

const ROOT = join(process.env.TEMP ?? ".", `hooknostic-copilot-approval-${mode}`);
const SCRATCH = join(ROOT, "project");
const OUT = join(REPO, ".capture/copilot/captured", `interactive-approval-${mode}`);

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

function findEventLogs(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findEventLogs(path));
    else if (entry.name === "events.jsonl") found.push(path);
  }
  return found;
}

function readEvents(home) {
  const root = join(home, "session-state");
  if (!existsSync(root)) throw new Error(`no session state under ${root}`);
  return findEventLogs(root).flatMap((path) =>
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line)),
  );
}

function permissionEvidence(home, toolCallId) {
  const events = readEvents(home);
  const requested = events.find(
    (event) =>
      event.type === "permission.requested" &&
      (event.data?.toolCallId === toolCallId || event.data?.permissionRequest?.toolCallId === toolCallId),
  );
  const completed = events.find(
    (event) => event.type === "permission.completed" && event.data?.toolCallId === toolCallId,
  );
  const tool = events.find((event) => event.type === "tool.execution_complete" && event.data?.toolCallId === toolCallId);
  if (requested === undefined) throw new Error("no permission.requested event");
  if (completed === undefined) throw new Error("no permission.completed event");
  if (tool === undefined) throw new Error("no tool.execution_complete event");
  return { requested: requested.data, completed: completed.data, tool: tool.data };
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
writeFileSync(join(SCRATCH, "README.md"), "# interactive approval probe\n");
writeFileSync(
  join(SCRATCH, ".github", "hooks", "hooknostic.json"),
  `${JSON.stringify(
    {
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            exec: process.execPath,
            args: [
              TEE,
              join(OUT, "hooks"),
              "preToolUse",
              JSON.stringify({ permissionDecision: "ask", permissionDecisionReason: "approval probe" }),
              "0",
            ],
            timeoutSec: 30,
          },
        ],
      },
    },
    null,
    2,
  )}\n`,
);

const home = join(SCRATCH, ".copilot-home");
const child = pty.spawn(BIN, ["--disable-client-telemetry", "--no-auto-update", "--allow-all-tools"], {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: SCRATCH,
  env: {
    ...process.env,
    COPILOT_HOME: home,
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
  child.write("Run the shell command: echo approval-ok > approval.txt. Then reply DONE.");
  await sleep(400);
  child.write("\r");
  await sleep(700);
  child.write("\r");
  await waitFor(
    () => terminal.plain(),
    (text) => /Hook permission request|Do you want to allow this tool call/i.test(text),
    120_000,
    "native approval prompt",
  );
  writeFileSync(join(OUT, "prompt.txt"), terminal.plain());
  if (mode === "allow") {
    child.write("\r");
    await waitFor(
      () => existsSync(join(SCRATCH, "approval.txt")),
      (exists) => exists,
      60_000,
      "approved command to run",
    );
  } else {
    child.write("\u001b[B");
    await sleep(300);
    child.write("\r");
    await sleep(500);
    // "No (Esc to stop)" is the native stop path for a denied hook ask.
    child.write("\u001b");
    await sleep(5000);
  }
  await waitFor(
    () => terminal.plain(),
    (text) => !/Hook permission request|Do you want to allow this tool call/i.test(text),
    30_000,
    "approval dialog to close",
  );
  await waitFor(
    () => readEvents(home),
    (events) => events.some((event) => event.type === "tool.execution_complete"),
    30_000,
    "tool completion event",
  );
  const toolCallId = (() => {
    const events = readEvents(home);
    const start = events.find((event) => event.type === "tool.execution_start");
    if (start === undefined) throw new Error("no tool.execution_start event");
    return start.data.toolCallId;
  })();
  const evidence = permissionEvidence(home, toolCallId);
  const exists = existsSync(join(SCRATCH, "approval.txt"));
  if (mode === "allow") {
    if (evidence.completed.result?.kind !== "approved") throw new Error("ask was not approved");
    if (evidence.tool.success !== true) throw new Error("approved tool did not succeed");
    if (!exists) throw new Error("approved command did not create approval.txt");
  } else {
    if (evidence.completed.result?.kind !== "denied-interactively-by-user")
      throw new Error("ask was not denied interactively");
    if (evidence.tool.success !== false) throw new Error("denied tool unexpectedly succeeded");
    if (exists) throw new Error("denied command created approval.txt");
  }
  writeFileSync(
    join(OUT, "evidence.json"),
    `${JSON.stringify({ mode, approvalFile: exists, ...evidence }, null, 2)}\n`,
  );
  console.log(`mode=${mode} approvalFile=${exists} permission=${JSON.stringify(evidence.completed.result)}`);
  console.log(terminal.plain().slice(-4000));
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
