// Interactive skill-policy capture for GitHub Copilot CLI.
//
// usage: node .capture/copilot/interactive-skill-probe.mjs project|plugin [--headless]
//
// The project probe writes `.agents/skills` (the directory project delivery
// uses); the plugin probe writes an Agent Plugins 1.0 package loaded with
// `--plugin-dir`. Each run opens the real TUI under node-pty, submits a slash
// command, and records the screen. `--headless` also runs the -p control that
// names the skill: that path has no slash command and reaches the model-facing
// skill tool, which excludes a gated skill.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const requireFromCli = createRequire(resolve(ROOT, "packages/cli/package.json"));
const pty = requireFromCli("node-pty");
const { Terminal } = requireFromCli("@xterm/headless");

const PLUGIN_NAME = "hooknostic-interactive-skill-probe";
const PLUGIN_FILE = JSON.stringify(
  {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: PLUGIN_NAME,
    description: "Interactive skill policy probe",
    version: "1.0.0",
  },
  null,
  2,
);

function copilotBinary() {
  if (process.env.COPILOT_BINARY !== undefined) return process.env.COPILOT_BINARY;
  const packageName = `@github/copilot-${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "copilot.exe" : "copilot";
  const roots = [];
  if (process.platform === "win32" && process.env.APPDATA !== undefined) {
    roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  }
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim());
  } catch {
    // The platform root above covers an npm install without a spawnable shell.
  }
  for (const root of roots) {
    const candidate = join(root, "@github", "copilot", "node_modules", ...packageName.split("/"), executable);
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "copilot.cmd" : "copilot";
}

function skillText(name, gate) {
  const line = gate === true ? "disable-model-invocation: true\n" : gate === false ? "disable-model-invocation: false\n" : "";
  return `---\nname: ${name}\ndescription: ${gate === true ? "Gated" : "Open"} probe skill.\n${line}---\n\nWhen asked for the ${name} skill token, reply exactly ${name.toUpperCase()}-SKILL-TOKEN and nothing else.\n`;
}

function screen() {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  return {
    write: (data) => new Promise((resolve) => terminal.write(data, resolve)),
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(read())) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}\n${read()}`);
}

function prepare(mode) {
  const scratch = join(tmpdir(), `hooknostic-copilot-interactive-skill-${mode}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, ".copilot-home"), { recursive: true });
  writeFileSync(
    join(scratch, ".copilot-home", "config.json"),
    `${JSON.stringify(
      {
        firstLaunchAt: new Date().toISOString(),
        appTipShown: true,
        reasoningSummariesCleanupDone: true,
        // The first interactive launch asks to edit Windows Terminal's
        // keybindings. Recording that it was already asked keeps the probe at
        // the main prompt instead of racing a dialog.
        askedSetupTerminals: ["windows-terminal"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(scratch, "README.md"), "# copilot interactive skill probe\n");
  if (mode === "project") {
    for (const [name, gate] of [
      ["gated", true],
      ["open", undefined],
      ["allowed", false],
    ]) {
      mkdirSync(join(scratch, ".agents/skills", name), { recursive: true });
      writeFileSync(join(scratch, ".agents/skills", name, "SKILL.md"), skillText(name, gate));
    }
  } else {
    const plugin = join(scratch, "plugin");
    mkdirSync(join(plugin, "skills"), { recursive: true });
    writeFileSync(join(plugin, "plugin.json"), `${PLUGIN_FILE}\n`);
    for (const [name, gate] of [
      ["gated", true],
      ["open", undefined],
      ["allowed", false],
    ]) {
      mkdirSync(join(plugin, "skills", name), { recursive: true });
      writeFileSync(join(plugin, "skills", name, "SKILL.md"), skillText(name, gate));
    }
  }
  execFileSync("git", ["init", "-q"], { cwd: scratch });
  execFileSync("git", ["add", "-A"], { cwd: scratch });
  execFileSync("git", ["-c", "user.email=capture@example.invalid", "-c", "user.name=capture", "commit", "-qm", "probe"], {
    cwd: scratch,
  });
  return scratch;
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

/**
 * The terminal token alone is not enough: the prompt could name it and the
 * model could parrot it. The session event log states whether Copilot injected
 * the skill context and recorded the gate. Fail the capture if it did not.
 */
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

/**
 * The terminal token alone is not enough: the prompt could name it and the
 * model could parrot it. The session event log states whether Copilot injected
 * the skill context and recorded the gate. Fail the capture if it did not.
 */
function readSessionEvidence(scratch, command) {
  const events = readEvents(join(scratch, ".copilot-home"));
  const invoked = events.find((event) => event.type === "skill.invoked" && event.data?.name === "gated");
  const message = events.find(
    (event) => event.type === "user.message" && String(event.data?.content ?? "").startsWith(command),
  );
  const context = String(message?.data?.transformedContent ?? "");
  if (invoked === undefined) throw new Error("session log has no skill.invoked event for gated");
  if (invoked.data.disableModelInvocation !== true) throw new Error("skill.invoked does not report the gate");
  if (invoked.data.trigger !== "user-invoked") throw new Error("skill.invoked was not a user invocation");
  if (!context.includes('<skill-context name="gated">')) throw new Error("user.message carries no skill context");
  return {
    skillInvoked: invoked.data,
    userMessage: { content: message.data.content, transformedContent: context },
  };
}

/** The -p control must have actually called skill(gated) and got not-found. */
function readHeadlessEvidence(home) {
  const events = readEvents(home);
  const start = events.find(
    (event) =>
      event.type === "tool.execution_start" &&
      event.data?.toolName === "skill" &&
      event.data?.arguments?.skill === "gated",
  );
  if (start === undefined) throw new Error("headless log has no skill(gated) tool call");
  const complete = events.find(
    (event) => event.type === "tool.execution_complete" && event.data?.toolCallId === start.data.toolCallId,
  );
  if (complete === undefined) throw new Error("headless log has no skill(gated) tool result");
  if (complete.data.success !== false) throw new Error("skill(gated) unexpectedly succeeded");
  if (complete.data.error?.message !== "Skill not found: gated") {
    throw new Error(`skill(gated) returned ${JSON.stringify(complete.data.error?.message)}`);
  }
  const message = events.find(
    (event) =>
      event.type === "assistant.message" &&
      String(event.data?.content ?? "").includes('TOOL_RESULT=Skill "gated" not found'),
  );
  if (message === undefined) throw new Error("headless log has no not-found tool result message");
  const available = /Available skills: ([^\n]+)/.exec(String(message.data.content))?.[1] ?? "";
  if (!available.includes("allowed")) throw new Error("explicit disable-model-invocation: false was not listed");
  if (available.includes("gated")) throw new Error("gated skill appeared in the model-facing available list");
  return {
    toolStart: start.data,
    toolComplete: complete.data,
    message: message.data.content,
  };
}

async function captureInteractive(mode, scratch) {
  const command = mode === "project" ? "/gated" : `/${PLUGIN_NAME}:gated`;
  const prompt = `${command} Report the exact token this skill defines for itself.`;
  const output = join(HERE, "captured", `interactive-skill-${mode}`);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  const args = ["--disable-client-telemetry", "--no-auto-update"];
  if (mode === "plugin") args.push("--plugin-dir", join(scratch, "plugin"));
  const child = pty.spawn(copilotBinary(), args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: scratch,
    env: {
      ...process.env,
      COPILOT_HOME: join(scratch, ".copilot-home"),
      COPILOT_ALLOW_ALL: "true",
      COPILOT_AUTO_UPDATE: "false",
      TERM: "xterm-256color",
    },
  });
  const terminal = screen();
  const chunks = [];
  let exited = false;
  let finalScreen = "";
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
      (text) =>
        text.split("\n").some((line) => line.trim() === "❯") &&
        !text.slice(-2000).includes("Loading:"),
      120_000,
      "main prompt",
    );
    await sleep(1500);
    child.write(prompt);
    await sleep(400);
    child.write("\r");
    await sleep(700);
    child.write("\r");
    await waitFor(
      () => terminal.plain(),
      (text) => {
        return (
          text.includes("GATED-SKILL-TOKEN") || /Skill not found|skill not found|Unknown command/.test(text)
        );
      },
      180_000,
      "gated slash response",
    );
  } finally {
    finalScreen = terminal.plain();
    writeFileSync(join(output, "final.ansi"), chunks.join(""));
    writeFileSync(join(output, "final.txt"), finalScreen);
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
  const evidence = readSessionEvidence(scratch, command);
  writeFileSync(join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return { command, screen: finalScreen, output, evidence };
}

function captureHeadless(mode, scratch) {
  const home = join(scratch, ".copilot-home-headless");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
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
  const args = [
    "--allow-all-tools",
    "--disable-client-telemetry",
    "--no-auto-update",
    ...(mode === "plugin" ? ["--plugin-dir", join(scratch, "plugin")] : []),
    "-p",
    "Call the skill tool with the skill name gated right now, even if it is not in your list. Then reply with exactly one line: TOOL_RESULT=<the skill tool result, verbatim>, or NO_TOOL.",
  ];
  const result = spawnSync(copilotBinary(), args, {
    cwd: scratch,
    env: {
      ...process.env,
      COPILOT_HOME: home,
      COPILOT_ALLOW_ALL: "true",
      COPILOT_AUTO_UPDATE: "false",
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`headless Copilot exited ${String(result.status)}`);
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!/skill\(gated\)\s+Skill not found: gated/.test(text)) throw new Error("headless output has no not-found line");
  const evidence = readHeadlessEvidence(home);
  writeFileSync(join(HERE, "captured", `interactive-skill-${mode}`, "headless.txt"), text);
  writeFileSync(
    join(HERE, "captured", `interactive-skill-${mode}`, "headless-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return result;
}

const mode = process.argv[2];
if (mode !== "project" && mode !== "plugin") {
  console.error("usage: node .capture/copilot/interactive-skill-probe.mjs project|plugin [--headless]");
  process.exit(2);
}
const scratch = prepare(mode);
const interactive = await captureInteractive(mode, scratch);
console.log(`mode=${mode} command=${interactive.command}`);
console.log(
  `evidence: skill=gated trigger=${interactive.evidence.skillInvoked.trigger} gate=${interactive.evidence.skillInvoked.disableModelInvocation} source=${interactive.evidence.skillInvoked.source}`,
);
console.log(interactive.screen.slice(-5000));
if (process.argv.includes("--headless")) {
  const headless = captureHeadless(mode, scratch);
  console.log(`headless exit=${headless.status}`);
  console.log((headless.stdout ?? "").trim().slice(-2000));
}
process.exit(0);
