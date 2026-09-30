#!/usr/bin/env node
// Skill-directory capture: what text reaches the model when a skill is
// loaded, and which `${...}` references in its body the harness expands. See
// README.md.
//
//   node --experimental-strip-types .capture/skill-directory/drive.mjs <opencode-v1|opencode-v2|codex|claude>
//
// opencode-v1, opencode-v2 and codex spend nothing: the harness runs against
// the loopback playback model, which loads the probe skill through the
// harness's own skill mechanism, and the request that follows carries what the
// harness handed the model. `claude` spends three small Sonnet turns on the
// user's own login (a plugin skill through --plugin-dir, and a project skill)
// and prints the skill text Claude Code handed the model.
//
// Every state directory is redirected into a fresh OS-temp root, printed on
// stdout.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { prepareOpenCodePluginDependency, runProcess, startModelPlayback, openCodePlaybackConfigHome } =
  await import(pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href);
const { withoutCredentials, writeOpencodeConfig } = await import(
  pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href
);

const harness = process.argv[2];
const SKILL = readFileSync(new URL("SKILL.md", import.meta.url), "utf8");
const root = mkdtempSync(join(realpathSync(tmpdir()), `hkn-skill-dir-${harness}-`));
const project = join(root, "project");
const isolated = {
  HOME: root,
  USERPROFILE: root,
  PWD: project,
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
};
mkdirSync(join(project, ".agents", "skills", "where"), { recursive: true });
writeFileSync(join(project, ".agents", "skills", "where", "SKILL.md"), SKILL);
console.log(JSON.stringify({ harness, root }));

/** Every text in the given requests that carries the probe skill's body. */
function evidence(requests) {
  const texts = [];
  const walk = (value) => {
    if (typeof value === "string") {
      if (value.includes("PORTABLE=")) texts.push(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  requests.forEach(walk);
  return [...new Set(texts)];
}

if (harness === "opencode-v1") {
  const version = (await runProcess("opencode", ["--version"], { cwd: REPO, env: process.env })).stdout.trim();
  await prepareOpenCodePluginDependency(project, version);
  // Discovery turn: learn the skill tool's name and argument key from the
  // live request, then load the probe skill with it.
  const server = await startModelPlayback("openai-chat", "rewrite", [
    { kind: "tool", toolName: "skill", arguments: { name: "where" } },
    { kind: "text", text: "hooknostic-final-answer" },
  ]);
  try {
    writeOpencodeConfig(project, server.baseUrl, "hooknostic-playback", "hooknostic-playback");
    await runProcess("git", ["init"], { cwd: project, env: process.env, timeoutMs: 30_000 });
    const result = await runProcess("opencode", ["run", "Load the where skill.", "--model", "drift/hooknostic-playback"], {
      cwd: project,
      timeoutMs: 120_000,
      env: { ...withoutCredentials(), ...isolated, XDG_CONFIG_HOME: openCodePlaybackConfigHome(project) },
    });
    writeFileSync(join(root, "requests.json"), JSON.stringify(server.requests, null, 2));
    console.log(
      JSON.stringify({ version, code: result.code, errors: server.errors, evidence: evidence(server.requests.slice(1)) }, null, 2),
    );
  } finally {
    await server.close();
  }
} else if (harness === "opencode-v2") {
  const executable =
    process.env.HKN_OPENCODE_BINARY ??
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA, "opencode2", "node_modules", "@opencode", "cli", "bin", "opencode.exe")
      : "opencode2");
  // The v2 skill tool takes the skill's id, which for a native skill is its
  // directory (../opencode-v2 tools).
  const server = await startModelPlayback("openai-chat", "rewrite", [
    { kind: "tool", toolName: "skill", arguments: { id: "where" } },
    { kind: "text", text: "hooknostic-final-answer" },
  ]);
  try {
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({
        model: "playback/hooknostic-playback",
        providers: {
          playback: {
            name: "Playback",
            env: ["HKN_PLAYBACK_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${server.baseUrl}/v1` },
            models: { "hooknostic-playback": { name: "Playback", limit: { context: 128000, output: 4096 } } },
          },
        },
      }),
    );
    const env = { ...withoutCredentials(), ...isolated, XDG_CONFIG_HOME: join(root, "config"), HKN_PLAYBACK_KEY: "local" };
    const code = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, ["run", "--standalone", "--auto", "--format", "json", "Load the where skill."], {
        cwd: project,
        env,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on("error", rejectPromise);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolvePromise(exitCode);
      });
    });
    writeFileSync(join(root, "requests.json"), JSON.stringify(server.requests, null, 2));
    console.log(JSON.stringify({ code, errors: server.errors, evidence: evidence(server.requests.slice(1)) }, null, 2));
  } finally {
    await server.close();
  }
} else if (harness === "codex") {
  // An explicit `$where` mention, which Codex answers by handing the model the
  // skill; the model only answers text.
  const server = await startModelPlayback("openai-responses", "rewrite", [
    { kind: "text", text: "hooknostic-final-answer" },
  ]);
  const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
  try {
    await runProcess("git", ["init"], { cwd: project, env: process.env, timeoutMs: 30_000 });
    mkdirSync(join(root, "codex-home"), { recursive: true });
    const result = await runProcess(
      "codex",
      [
        "exec",
        "-",
        "--color",
        "never",
        "-c",
        'model="hooknostic-playback"',
        "-c",
        'model_provider="hooknostic_drift"',
        "-c",
        'approval_policy="never"',
        "-c",
        'model_providers.hooknostic_drift.name="Hooknostic Drift"',
        "-c",
        `model_providers.hooknostic_drift.base_url=${q(`${server.baseUrl}/v1`)}`,
        "-c",
        'model_providers.hooknostic_drift.wire_api="responses"',
        "-c",
        "model_providers.hooknostic_drift.requires_openai_auth=false",
        "-c",
        "model_providers.hooknostic_drift.request_max_retries=0",
        "-c",
        "model_providers.hooknostic_drift.stream_max_retries=0",
        "-c",
        `projects={${q(project)}={trust_level=${q("trusted")}}}`,
      ],
      {
        cwd: project,
        input: "$where print the lines.",
        timeoutMs: 120_000,
        env: { ...withoutCredentials(), ...isolated, CODEX_HOME: join(root, "codex-home") },
      },
    );
    const version = (await runProcess("codex", ["--version"], { cwd: REPO, env: process.env })).stdout.trim();
    writeFileSync(join(root, "requests.json"), JSON.stringify(server.requests, null, 2));
    console.log(JSON.stringify({ version, code: result.code, errors: server.errors, evidence: evidence(server.requests) }, null, 2));
  } finally {
    await server.close();
  }
} else if (harness === "claude") {
  const plugin = join(root, "plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "skills", "where"), { recursive: true });
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "skilldir-probe", version: "0.0.0", description: "Skill-directory probe" }),
  );
  writeFileSync(join(plugin, "skills", "where", "SKILL.md"), SKILL);
  // The frontmatter reaches the model only through the skill listing, so the
  // third turn asks for a description quoted without loading the skill.
  mkdirSync(join(plugin, "skills", "fmprobe"), { recursive: true });
  writeFileSync(
    join(plugin, "skills", "fmprobe", "SKILL.md"),
    "---\nname: fmprobe\ndescription: Frontmatter probe. SKILL=${CLAUDE_SKILL_DIR} ROOT=${CLAUDE_PLUGIN_ROOT} " +
      "SESSION=${CLAUDE_SESSION_ID} AGENT=${PLUGIN_ROOT} PORTABLE=${SKILL_DIR}\n---\n\nDo nothing.\n",
  );
  mkdirSync(join(project, ".claude", "skills", "where-local"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "skills", "where-local", "SKILL.md"),
    SKILL.replace("name: where\n", "name: where-local\n"),
  );
  await runProcess("git", ["init"], { cwd: project, env: process.env, timeoutMs: 30_000 });
  const version = (await runProcess("claude", ["--version"], { cwd: project, env: process.env })).stdout.trim();
  const skillText = async (args, prompt) => {
    const result = await runProcess(
      "claude",
      [...args, "-p", prompt, "--model", "sonnet", "--output-format", "stream-json", "--verbose"],
      { cwd: project, env: process.env, timeoutMs: 300_000 },
    );
    return result.stdout
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .filter((message) => message.type === "user" && message.message?.content?.[0]?.type === "text")
      .map((message) => message.message.content[0].text);
  };
  console.log(JSON.stringify({ version }));
  for (const text of await skillText(["--plugin-dir", plugin], "Load the probe skill with the Skill tool and follow it."))
    console.log(`plugin skill:\n${text}`);
  for (const text of await skillText([], "Load the where-local skill with the Skill tool and follow it."))
    console.log(`project skill:\n${text}`);
  const quoted = await runProcess(
    "claude",
    [
      "--plugin-dir",
      plugin,
      "-p",
      "Without loading or invoking any skill, copy the exact description text of the skill named fmprobe from your list of available skills, character for character, inside a code block. Nothing else.",
      "--model",
      "sonnet",
      "--output-format",
      "json",
    ],
    { cwd: project, env: process.env, timeoutMs: 300_000 },
  );
  // `json` output is a list of messages; the last one is the result.
  const messages = [JSON.parse(quoted.stdout)].flat();
  const result = messages.find((message) => message.type === "result")?.result;
  console.log(`frontmatter, as the model quoted it:\n${result}`);
} else {
  throw new Error(`unknown harness ${harness}`);
}
