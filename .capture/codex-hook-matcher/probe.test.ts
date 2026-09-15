import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runProcess, startModelPlayback } from "../../packages/cli/test/harness-playback.js";

function withoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|ANTHROPIC|OPENAI|CODEX_HOME|AI_PAT/i.test(name)) delete env[name];
  return env;
}

const toml = (value: string) => `'${value.replaceAll("'", "''")}'`;

// One PreToolUse group per candidate matcher; each records the tool name it saw.
const MATCHERS: Record<string, string | undefined> = {
  unmatched: undefined,
  wildcard: "*",
  exactBash: "Bash",
  exactExecCommand: "exec_command",
  wordList: "Bash|PowerShell",
  anchoredRegex: "^(?:Bash|exec_command)$",
  prefixOnly: "Ba",
  otherTool: "Read",
};

test("captures Codex PreToolUse matcher semantics for the shell tool", async () => {
  const model = await startModelPlayback("openai-responses", "rewrite");
  const root = await mkdtemp(join(tmpdir(), "hooknostic-codex-matcher-"));
  try {
    const project = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(project, ".codex"), { recursive: true });
    await mkdir(home);
    const log = join(root, "dispatch.log").replaceAll("\\", "/");
    const recorder = join(root, "record.mjs").replaceAll("\\", "/");
    await writeFile(
      recorder,
      `import { appendFileSync, readFileSync } from "node:fs";\nconst input = JSON.parse(readFileSync(0, "utf8"));\nappendFileSync(${JSON.stringify(log)}, process.argv[2] + "\\t" + input.tool_name + "\\n");\n`,
    );
    const groups = Object.entries(MATCHERS).map(([id, matcher]) => ({
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", command: `node ${recorder} ${id}`, timeout: 30 }],
    }));
    await writeFile(join(project, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: groups } }, null, 2));
    await runProcess("git", ["init"], { cwd: project, env: process.env, timeoutMs: 30_000 });
    const result = await runProcess(
      "codex",
      [
        "exec", "-", "--dangerously-bypass-hook-trust", "--color", "never",
        "-c", 'model="hooknostic-playback"', "-c", 'model_provider="hooknostic_playback"',
        "-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"',
        "-c", 'model_providers.hooknostic_playback.name="Hooknostic Playback"',
        "-c", `model_providers.hooknostic_playback.base_url=${toml(`${model.baseUrl}/v1`)}`,
        "-c", 'model_providers.hooknostic_playback.wire_api="responses"',
        "-c", "model_providers.hooknostic_playback.requires_openai_auth=false",
        "-c", "model_providers.hooknostic_playback.request_max_retries=0",
        "-c", "model_providers.hooknostic_playback.stream_max_retries=0",
        "-c", `projects={${toml(project)}={trust_level=${toml("trusted")}}}`,
      ],
      {
        cwd: project,
        input: "Use the shell tool once to create hooknostic-tool.txt, then stop.",
        timeoutMs: 90_000,
        env: { ...withoutCredentials(), CODEX_HOME: home },
      },
    );
    const version = await runProcess("codex", ["--version"], { cwd: root, env: process.env, timeoutMs: 30_000 });
    const dispatched = (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const observations = {
      codexVersion: version.stdout.trim(),
      exitCode: result.code,
      matchers: MATCHERS,
      dispatched: Object.fromEntries(
        Object.keys(MATCHERS).map((id) => [id, dispatched.filter(([seen]) => seen === id).map(([, tool]) => tool)]),
      ),
    };
    await writeFile(new URL("observations.json", import.meta.url), JSON.stringify(observations, null, 2) + "\n");
    expect(model.errors, result.stderr).toEqual([]);
    expect(observations.dispatched["unmatched"]!.length, `${result.stdout}\n${result.stderr}`).toBeGreaterThan(0);
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
