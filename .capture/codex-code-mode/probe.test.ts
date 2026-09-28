import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  playbackModelInfo,
  runProcess,
  type ScenarioScript,
  startModelPlayback,
} from "../../packages/cli/test/harness-playback.js";

function withoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/TOKEN|SECRET|PASSWORD|API_KEY|ANTHROPIC|OPENAI|CODEX_HOME|AI_PAT/i.test(name)) delete env[name];
  return env;
}

const toml = (value: string) => `'${value.replaceAll("'", "''")}'`;
const template = new URL("../codex-capture/.codex/hooks.json.template", import.meta.url);
const tee = new URL("../codex-capture/capture.mjs", import.meta.url);

// Extra recorder groups beside the catch-all tee (which has no matcher).
// `generated` is the matcher the Codex generator emits for
// `match: { kind: "shell" }` (the shell names in CODEX_TOOL_KINDS as a word
// list); `exec` names the Code Mode tool itself.
const MATCHERS: Record<string, string> = {
  generated: "Bash|exec_command|shell",
  exec: "exec",
};

const MARKER = "hooknostic-code-mode.txt";

interface Drive {
  /** Written into the static model catalog; undefined keeps the direct default. */
  toolMode: string | undefined;
  script: (project: string) => ScenarioScript;
}

const DRIVES: Record<string, Drive> = {
  // Control: the same session with no Code Mode -- a direct exec_command call.
  direct: {
    toolMode: undefined,
    script: () => [{ kind: "tool", disposition: "rewrite", marker: MARKER }, { kind: "text" }],
  },
  // The real gpt-5.6-luna catalog entry carries tool_mode "code_mode_only".
  codeModeOnly: {
    toolMode: "code_mode_only",
    script: () => [{ kind: "code", disposition: "rewrite", marker: MARKER }, { kind: "text" }],
  },
  // "code_mode": exec beside the direct tools; the script still chooses exec.
  codeMode: {
    toolMode: "code_mode",
    script: () => [{ kind: "code", disposition: "rewrite", marker: MARKER }, { kind: "text" }],
  },
  // The nested argument set the live gpt-5.6-luna call used (workdir, shell,
  // yield_time_ms, max_output_tokens), to rule out an argument-dependent path.
  liveShape: {
    toolMode: "code_mode_only",
    script: (project) => [
      {
        kind: "code",
        disposition: "rewrite",
        marker: MARKER,
        codeArgs: {
          workdir: project,
          ...(process.platform === "win32" ? { shell: "powershell" } : {}),
          yield_time_ms: 10_000,
          max_output_tokens: 10_000,
        },
      },
      { kind: "text" },
    ],
  },
};

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const contents = await readFile(path, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function drive(id: string, spec: Drive) {
  const root = await mkdtemp(join(tmpdir(), `hooknostic-codex-code-mode-${id}-`));
  const project = join(root, "project");
  const model = await startModelPlayback("openai-responses", "rewrite", spec.script(project));
  try {
    const home = join(root, "home");
    const captureDir = join(root, "capture");
    await mkdir(join(project, ".codex"), { recursive: true });
    await mkdir(home);
    await mkdir(join(captureDir, "captured"), { recursive: true });
    await copyFile(tee, join(captureDir, "capture.mjs"));
    const hooks = JSON.parse(
      (await readFile(template, "utf8")).replaceAll("${CAPTURE_DIR}", captureDir.replaceAll("\\", "/")),
    ) as { hooks: Record<string, unknown[]> };
    const log = join(root, "dispatch.log").replaceAll("\\", "/");
    const recorder = join(root, "record.mjs").replaceAll("\\", "/");
    await writeFile(
      recorder,
      `import { appendFileSync, readFileSync } from "node:fs";\nconst input = JSON.parse(readFileSync(0, "utf8"));\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ group: process.argv[2], event: input.hook_event_name, tool_name: input.tool_name }) + "\\n");\n`,
    );
    for (const event of ["PreToolUse", "PostToolUse"]) {
      for (const [group, matcher] of Object.entries(MATCHERS)) {
        hooks.hooks[event]!.push({
          matcher,
          hooks: [{ type: "command", command: `node "${recorder}" ${group}`, timeout: 30 }],
        });
      }
    }
    await writeFile(join(project, ".codex/hooks.json"), JSON.stringify(hooks, null, 2));
    await runProcess("git", ["init"], { cwd: project, env: process.env, timeoutMs: 30_000 });
    // A custom provider without auth never refreshes /models, so tool_mode
    // reaches Codex only through a static catalog -- the same field the real
    // gpt-5.6-luna catalog entry carries.
    const catalog = join(home, "catalog.json");
    await writeFile(
      catalog,
      JSON.stringify({
        models: [playbackModelInfo(spec.toolMode === undefined ? {} : { tool_mode: spec.toolMode })],
      }),
    );
    // Settings live in the scratch CODEX_HOME: runProcess spawns through a
    // shell on Windows, so a path in argv could split.
    await writeFile(
      join(home, "config.toml"),
      [
        'model = "hooknostic-playback"',
        'model_provider = "hooknostic_playback"',
        `model_catalog_json = ${toml(catalog)}`,
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "[model_providers.hooknostic_playback]",
        'name = "Hooknostic Playback"',
        `base_url = ${toml(`${model.baseUrl}/v1`)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "request_max_retries = 0",
        "stream_max_retries = 0",
        `[projects.${toml(project)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    const result = await runProcess("codex", ["exec", "-", "--dangerously-bypass-hook-trust", "--color", "never"], {
      cwd: project,
      input: "Use the shell once to create the marker file, then stop.",
      timeoutMs: 120_000,
      env: { ...withoutCredentials(), CODEX_HOME: home },
    });
    const captured: Record<string, Record<string, unknown>[]> = {};
    for (const name of await readdir(join(captureDir, "captured"))) {
      captured[name.replace(/\.jsonl$/, "")] = await readJsonl(join(captureDir, "captured", name));
    }
    const agentRequests = model.requests.filter((request) =>
      Array.isArray((request as Record<string, unknown>)["tools"]),
    ) as Record<string, unknown>[];
    const firstTools = (agentRequests[0]?.["tools"] ?? []) as Record<string, unknown>[];
    const emitted = agentRequests
      .flatMap((request) => (Array.isArray(request["input"]) ? (request["input"] as Record<string, unknown>[]) : []))
      .filter((item) => item["call_id"] === "call_playback");
    return {
      toolMode: spec.toolMode ?? null,
      exitCode: result.code,
      modelErrors: model.errors,
      advertisedTools: firstTools.map((tool) => `${String(tool["type"])}:${String(tool["name"] ?? "")}`),
      // The scripted call as Codex recorded it, and the output it returned.
      modelCall: emitted.find((item) => item["type"] === "custom_tool_call" || item["type"] === "function_call"),
      toolOutput: emitted.find((item) => /_call_output$/.test(String(item["type"]))),
      markerContents: await readFile(join(project, MARKER), "utf8").catch(() => null),
      hookLinesPrinted: `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("hook: ")),
      teed: {
        PreToolUse: captured["PreToolUse"] ?? [],
        PostToolUse: captured["PostToolUse"] ?? [],
        otherEvents: Object.keys(captured)
          .filter((event) => event !== "PreToolUse" && event !== "PostToolUse")
          .sort(),
      },
      matcherDispatch: await readJsonl(log),
    };
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}

// Redact the capturing account's home-directory segment only (harness-capture
// skill): drive letter, separators, and escaping stay intact.
function redactAccount(json: string): string {
  const name = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Separators repeat: a path inside a JSON-encoded JS string is escaped twice.
  return json.replace(new RegExp(`(Users(?:\\\\|/)+)${name}(?=\\\\|/)`, "gi"), "$1user");
}

test("captures what Codex hooks receive for Code Mode exec and its nested exec_command", async () => {
  const version = await runProcess("codex", ["--version"], { cwd: tmpdir(), env: process.env, timeoutMs: 30_000 });
  const observations: Record<string, unknown> = {
    codexVersion: version.stdout.trim(),
    platform: process.platform,
    capturedOn: new Date().toLocaleDateString("sv-SE"),
    matchers: MATCHERS,
    drives: {},
  };
  for (const [id, spec] of Object.entries(DRIVES)) {
    (observations["drives"] as Record<string, unknown>)[id] = await drive(id, spec);
  }
  const out = process.env["HOOKNOSTIC_CAPTURE_OUT"] ?? new URL("observations.json", import.meta.url);
  await writeFile(out, redactAccount(JSON.stringify(observations, null, 2)) + "\n");
  for (const [id, observed] of Object.entries(observations["drives"] as Record<string, { modelErrors: string[] }>)) {
    expect(observed.modelErrors, id).toEqual([]);
  }
});
