// Claude Code's half of a root .mcp.json shared with GitHub Copilot CLI.
//
// usage: node .capture/copilot/claude-mcp-fence-probe.mjs [claude-binary]
//
// Copilot reads only the root .mcp.json when one exists, so a project that
// targets both harnesses shares that file. This asks what Claude does with the
// entry shape and fences a shared file needs:
//   - an entry carrying cwd (Copilot needs cwd "." under GITHUB_WORKSPACE);
//   - .claude/settings.json disabledMcpjsonServers, to keep a Copilot-only
//     server from Claude;
//   - .github/copilot/settings.json disabledMcpServers, Copilot's fence, which
//     Claude should ignore.
// Each stdio server appends its label and cwd to a log when Claude launches it.
// The API endpoint is unreachable on purpose, so no credential or spend is
// involved; servers start before the first model request.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLAUDE = process.argv[2] ?? (process.platform === "win32" ? "claude.exe" : "claude");
const ROOT = join(tmpdir(), "hooknostic-claude-mcp-fence");
rmSync(ROOT, { recursive: true, force: true });
const PROJECT = join(ROOT, "project");
mkdirSync(join(PROJECT, "sub"), { recursive: true });
mkdirSync(join(PROJECT, ".claude"), { recursive: true });
mkdirSync(join(PROJECT, ".github", "copilot"), { recursive: true });
const LOG = join(ROOT, "launched.jsonl");
const SERVER = join(ROOT, "server.mjs");
writeFileSync(
  SERVER,
  `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], JSON.stringify({ label: process.argv[3], cwd: process.cwd() }) + "\\n");
setTimeout(() => process.exit(0), 20000);
`,
);
const server = (label, extra = {}) => ({ command: "node", args: [SERVER, LOG, label], ...extra });
writeFileSync(
  join(PROJECT, ".mcp.json"),
  `${JSON.stringify(
    {
      mcpServers: {
        plain: server("plain"),
        "with-cwd": server("with-cwd", { cwd: "sub" }),
        "with-cwd-dot": server("with-cwd-dot", { cwd: "." }),
        "claude-fenced": server("claude-fenced"),
        "copilot-fenced": server("copilot-fenced"),
      },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(PROJECT, ".claude", "settings.json"),
  `${JSON.stringify({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ["claude-fenced"] }, null, 2)}\n`,
);
writeFileSync(
  join(PROJECT, ".github", "copilot", "settings.json"),
  `${JSON.stringify({ disabledMcpServers: ["copilot-fenced"] }, null, 2)}\n`,
);
spawnSync("git", ["init", "-q"], { cwd: PROJECT });

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/.test(key)));
const run = spawnSync(CLAUDE, ["-p", "Reply OK.", "--max-turns", "1"], {
  cwd: PROJECT,
  encoding: "utf8",
  timeout: 90_000,
  env: { ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "hooknostic-capture" },
});
const launched = existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const version = spawnSync(CLAUDE, ["--version"], { encoding: "utf8" }).stdout?.trim();
console.log(
  JSON.stringify(
    {
      version,
      launched: launched.map(({ label, cwd }) => ({ label, cwd: cwd.replace(PROJECT, "<project>") })),
      output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().slice(0, 300),
    },
    null,
    2,
  ),
);
