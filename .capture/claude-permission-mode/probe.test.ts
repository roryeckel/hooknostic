import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { afterAll, test } from "vitest";
import { runProcess, startModelPlayback } from "../../packages/cli/test/harness-playback.js";

// Which permission mode does an interactive Claude session start in, which
// switches select the prompting mode, and which interstitials does the TUI
// render on the way? See README.md for the question and the observations.

const repoRoot = join(import.meta.dirname, "..", "..");
const pty = createRequire(join(repoRoot, "packages/cli/package.json"))("node-pty") as typeof import("node-pty");

function claudeBinary(): string {
  const override = process.env["HOOKNOSTIC_CLAUDE_BIN"];
  if (override !== undefined && override !== "") return override;
  const probe = process.platform === "win32" ? "where claude" : "which claude";
  const found = execSync(probe, { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => (process.platform === "win32" ? /\.(?:exe|cmd|bat)$/i.test(line) : line !== ""));
  if (found === undefined) throw new Error("claude not found: set HOOKNOSTIC_CLAUDE_BIN");
  return found;
}

const binary = claudeBinary();
const viaShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);
const version = (
  viaShell
    ? execFileSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/c", binary, "--version"], { encoding: "utf8" })
    : execFileSync(binary, ["--version"], { encoding: "utf8" })
)
  .trim()
  .split(/\s/)[0]!;

/**
 * Fresh top-level env, by the playback pty lane's rule: no credentials and no
 * enclosing Claude session variables (CLAUDECODE, CLAUDE_*, AI_AGENT,
 * TRACEPARENT), keeping only the Windows shell locator.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const session = name === "CLAUDECODE" || name === "AI_AGENT" || name === "TRACEPARENT" || name.startsWith("CLAUDE_");
    if (session && name !== "CLAUDE_CODE_GIT_BASH_PATH") continue;
    if (/^(?:ANTHROPIC|OPENAI|OPENROUTER|AZURE_OPENAI|AWS|GOOGLE_APPLICATION)_/.test(name)) continue;
    env[name] = value;
  }
  return env;
}

interface Variant {
  args?: string[];
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
}

const variants: Record<string, Variant> = {
  "no-switch": {},
  // The harness's own child-process markers (constant values from its child
  // environment builder), as a session started from inside Claude inherits them.
  "no-switch, nested markers": { env: { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" } },
  "--permission-mode manual": { args: ["--permission-mode", "manual"] },
  "--permission-mode default": { args: ["--permission-mode", "default"] },
  "settings permissions.defaultMode=default": { settings: { permissions: { defaultMode: "default" } } },
};

const observations: Record<string, unknown> = {};
const account = userInfo().username;
const redact = (text: string): string => text.split(account).join("user");

afterAll(async () => {
  await writeFile(
    join(import.meta.dirname, `observations-${version}.json`),
    JSON.stringify({ harness: "claude", version, platform: process.platform, variants: observations }, null, 2) + "\n",
  );
});

const tee = `import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.argv[2], input.trim() + "\\n", "utf8");
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

for (const [name, variant] of Object.entries(variants)) {
  test(`claude ${version}: ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-permission-mode-"));
    const project = join(dir, "project");
    const configDir = join(dir, "claude-config");
    await mkdir(project);
    await mkdir(configDir);
    await runProcess("git", ["init"], { cwd: project, env: process.env, timeoutMs: 30_000 });
    const teePath = join(dir, "tee.mjs").replaceAll("\\", "/");
    await writeFile(teePath, tee);
    const hook = (event: string): unknown => [
      { hooks: [{ type: "command", command: `node "${teePath}" "${join(dir, event).replaceAll("\\", "/")}.jsonl"` }] },
    ];
    await writeFile(
      join(configDir, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        customApiKeyResponses: { approved: ["hooknostic-playback"], rejected: [] },
      }),
    );
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({
        ...variant.settings,
        hooks: { PreToolUse: hook("PreToolUse"), PermissionRequest: hook("PermissionRequest") },
      }),
    );
    const server = await startModelPlayback("anthropic-messages", "rewrite", [
      { kind: "tool", disposition: "rewrite", marker: "hooknostic-mode-probe.txt" },
      { kind: "text" },
    ]);
    const record: Record<string, unknown> = { args: variant.args ?? [], settings: variant.settings ?? {} };
    if (variant.env !== undefined) record["injectedEnv"] = variant.env;
    observations[name] = record;
    let child: IPty | undefined;
    try {
      const args = variant.args ?? [];
      const options = {
        name: "xterm-256color",
        cols: 110,
        rows: 34,
        cwd: project,
        env: {
          ...cleanEnv(),
          ...variant.env,
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_API_KEY: "hooknostic-playback",
          ANTHROPIC_BASE_URL: server.baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
        },
      };
      child = viaShell
        ? pty.spawn(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/c", binary, ...args], options)
        : pty.spawn(binary, args, options);
      let raw = "";
      let exit: number | undefined;
      child.onData((data) => {
        raw += data;
      });
      child.onExit(({ exitCode }) => {
        exit = exitCode;
      });
      const plain = (): string => raw.replace(/\x1b\[[0-9;?>]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
      const flat = (): string => plain().replace(/\s+/g, "");
      const cursorAt = (): string => {
        const s = flat().slice(-2500);
        const at = Math.max(s.lastIndexOf("❯"), s.lastIndexOf(">"));
        return at === -1 ? "" : s.slice(at + 1).replace(/^[0-9]*\.?/, "");
      };
      const select = async (wanted: string): Promise<void> => {
        for (let i = 0; i < 6 && !cursorAt().startsWith(wanted); i += 1) {
          child!.write("\u001b[A");
          await sleep(600);
        }
        child!.write("\r");
        await sleep(600);
      };

      // First-run walk (same markers as the playback lane), recording which
      // dialogs rendered and in what order.
      const dialogs: string[] = [];
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && exit === undefined) {
        const s = flat();
        if (!dialogs.includes("theme") && s.includes("Choosethetextstyle")) {
          dialogs.push("theme");
          child.write("\r");
          await sleep(600);
        } else if (!dialogs.includes("api-key") && s.includes("DoyouwanttousethisAPIkey")) {
          dialogs.push("api-key");
          await select("Yes");
        } else if (!dialogs.includes("security") && s.includes("PressEnte")) {
          dialogs.push("security");
          child.write("\r");
          await sleep(600);
        } else if (!dialogs.includes("terminal-setup") && s.includes("terminalsetup?")) {
          dialogs.push("terminal-setup");
          child.write("\r");
          await sleep(600);
        } else if (!dialogs.includes("trust") && s.includes("Quicksafetycheck")) {
          dialogs.push("trust");
          await select("Yes,Itrustthisfolder");
        } else if (
          cursorAt() !== "" &&
          !/^(?:Yes|No|Claudeaccount|AnthropicConsoleaccount|3rd-partyplatform)/.test(cursorAt())
        ) {
          break;
        } else {
          await sleep(400);
        }
      }
      record["firstRunDialogs"] = dialogs;
      if (exit !== undefined) {
        record["exitedBeforePrompt"] = { exitCode: exit, output: redact(plain().trim().slice(-600)) };
        return;
      }
      await sleep(1_500);
      const startup = flat();
      record["startupScreen"] = {
        autoDefaultNotice: startup.includes("AutomodeisnowClaudeCode'sdefaultpermissionmode"),
        autoModeFooter: startup.includes("automodeon"),
        transcriptSavingOff: startup.includes("Transcriptsavingisoff"),
        inheritedChildSessionMarkerNotice: startup.includes("inheritedCLAUDE_CODE_CHILD_SESSIONmarker"),
      };

      child.write("Use the shell tool once to create hooknostic-mode-probe.txt.\r");
      const interstitials: string[] = [];
      const turnDeadline = Date.now() + 45_000;
      let seenModalAt = -1;
      let seenPromptAt = -1;
      while (Date.now() < turnDeadline && server.turnCount < 2 && exit === undefined) {
        const s = flat();
        const modalAt = s.lastIndexOf("We'rechangingautomodetonolongerchargeforclassifierrequests");
        if (modalAt > seenModalAt) {
          seenModalAt = modalAt;
          interstitials.push("classifier-billing-modal");
          await sleep(500);
          // Whitespace-stripped: the TUI renders some spaces as cursor moves.
          const modal = flat().slice(flat().lastIndexOf("We'rechangingautomode"));
          record["classifierBillingModalFrame"] = modal.slice(0, modal.indexOf("Esctocancel") + "Esctocancel".length);
          // "Enter to continue · Esc to cancel": continue.
          child.write("\r");
          await sleep(1_000);
          continue;
        }
        const promptAt = s.lastIndexOf("Doyouwanttoproceed");
        if (promptAt > seenPromptAt) {
          seenPromptAt = promptAt;
          interstitials.push("native-permission-prompt");
          // Deny, so the probe never executes the scripted command on approval.
          child.write("\u001b");
          await sleep(1_000);
          continue;
        }
        await sleep(500);
      }
      await sleep(1_500);
      const after = flat();
      record["afterPrompt"] = {
        interstitials,
        autoModeFooter: after.includes("automodeon"),
        modelTurns: server.turnCount,
        modelRequests: server.requests.length,
        commandExecuted: existsSync(join(project, "hooknostic-mode-probe.txt")),
      };
      const payloads = async (event: string): Promise<{ hook_event_name?: string; permission_mode?: string; tool_name?: string }[]> =>
        (await readFile(join(dir, `${event}.jsonl`), "utf8").catch(() => ""))
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { hook_event_name?: string; permission_mode?: string; tool_name?: string })
          .map(({ hook_event_name, permission_mode, tool_name }) => ({ hook_event_name, permission_mode, tool_name }));
      // Only the fields this question needs; full payloads carry local paths.
      record["hookPayloads"] = {
        PreToolUse: await payloads("PreToolUse"),
        PermissionRequest: await payloads("PermissionRequest"),
      };
    } finally {
      try {
        child?.kill();
      } catch {
        // already gone
      }
      await server.close();
    }
  });
}
