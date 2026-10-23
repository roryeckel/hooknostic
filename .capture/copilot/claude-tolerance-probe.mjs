// Does Claude Code still run a project hook entry that carries a key GitHub
// Copilot CLI rejects?
//
// usage: node .capture/copilot/claude-tolerance-probe.mjs [claude-binary]
//
// Copilot reads .claude/settings.json and validates its inline hooks strictly:
// one entry it rejects drops the file's whole hooks field for Copilot
// (claude-settings-probe.sh). This probe asks the other half: for each
// candidate key, does Claude still load the settings file (its `env` value
// reaches the hook) and run the entry (the hook appends a line)? Each variant
// writes Hooknostic's generated form (command "node", script in args) into its
// own scratch project. SessionStart fires before any model request, and the
// API endpoint is unreachable on purpose, so no credential or spend is involved.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLAUDE = process.argv[2] ?? (process.platform === "win32" ? "claude.exe" : "claude");
const ROOT = join(tmpdir(), "hooknostic-claude-tolerance");
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const LOG = join(ROOT, "ran.jsonl");
const MARK = join(ROOT, "mark.mjs");
writeFileSync(
  MARK,
  `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], JSON.stringify({ label: process.argv[3], env: process.env.HKN_PROBE_ENV ?? null }) + "\\n");
`,
);

const VARIANTS = {
  control: {},
  "timeoutSec-string": { timeoutSec: "hooknostic: Claude Code only; GitHub Copilot CLI must not run this entry" },
  exec: { exec: "node" },
};

// Claude marks a child of another Claude session; strip the host's variables.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/.test(key)));
const results = {};
for (const [label, extra] of Object.entries(VARIANTS)) {
  const project = join(ROOT, label);
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        env: { HKN_PROBE_ENV: `applied-${label}` },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node", args: [MARK, LOG, label], timeout: 30, ...extra }] }],
        },
      },
      null,
      2,
    )}\n`,
  );
  spawnSync("git", ["init", "-q"], { cwd: project });
  const run = spawnSync(CLAUDE, ["-p", "Reply OK.", "--max-turns", "1"], {
    cwd: project,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "hooknostic-capture" },
  });
  results[label] = { exit: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().slice(0, 400) };
}
const ran = existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const version = spawnSync(CLAUDE, ["--version"], { encoding: "utf8" }).stdout?.trim();
for (const label of Object.keys(VARIANTS)) {
  const line = ran.find((entry) => entry.label === label);
  results[label] = { ran: line !== undefined, env: line?.env ?? null, ...results[label] };
}
console.log(JSON.stringify({ version, results }, null, 2));
