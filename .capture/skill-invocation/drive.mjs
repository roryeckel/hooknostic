#!/usr/bin/env node
// Evidence-only project-skill gate probe. All model replies are scripted on loopback.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { describeTools, runProcess, startModelPlayback, prepareOpenCodePluginDependency, openCodePlaybackConfigHome } =
  await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials, writeOpencodeConfig } = await import("../../scripts/drive-capture-session.mjs");
const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const harness = process.argv[2];
const protocol = {
  claude: "anthropic-messages",
  codex: "openai-responses",
  "opencode-v1": "openai-chat",
  "opencode-v2": "openai-chat",
}[harness];
if (!protocol) throw new Error("Specify claude, codex, opencode-v1, or opencode-v2");
const executable = process.env.HKN_SKILL_HARNESS_BINARY ?? (harness.startsWith("opencode") ? "opencode" : harness);
const versionResult = await runProcess(executable, ["--version"], {
  cwd: repo,
  env: withoutCredentials(),
  timeoutMs: 30000,
});
const version = versionResult.stdout.match(/\d+\.\d+\.\d+/)?.[0];
if (versionResult.code !== 0 || !version) throw new Error("Could not identify harness version");
const out = join(repo, ".capture/skill-invocation/captured", `${harness}-${version}-${Date.now()}`);
mkdirSync(out, { recursive: true });
const skillNames = ["gate-control", "gate-claude", "gate-codex", "gate-opencode"];
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;
const textStrings = (value) =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(textStrings)
      : [];
const evidenceStrings = (requests) => [
  ...new Set(textStrings(requests).filter((value) => /GATE_(DESCRIPTION|BODY)_/.test(value))),
];

async function session(label, gated, prompt, action) {
  const root = mkdtempSync(join(tmpdir(), "hkn-skill-gate-"));
  const project = join(root, "project");
  const skills = join(project, harness === "claude" ? ".claude" : ".agents", "skills");
  for (const name of skillNames) {
    const dir = join(skills, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: GATE_DESCRIPTION_${name} harmless capture control.\n${gated && name === "gate-claude" ? "disable-model-invocation: true\n" : ""}---\n\nGATE_BODY_${name}\nRespond with the word done.\n`,
    );
    if (gated && name === "gate-codex") {
      mkdirSync(join(dir, "agents"));
      writeFileSync(join(dir, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    }
  }
  const env = {
    ...withoutCredentials(),
    HOME: root,
    USERPROFILE: root,
    PWD: project,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    CODEX_HOME: join(root, "codex-home"),
    CLAUDE_CONFIG_DIR: join(root, "claude-home"),
  };
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ])
    mkdirSync(env[key], { recursive: true });
  for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
  ])
    delete env[key];
  const git = await runProcess("git", ["init"], { cwd: project, env, timeoutMs: 30000 });
  if (git.code !== 0) throw new Error("Could not initialize isolated project");
  if (harness === "opencode-v1") await prepareOpenCodePluginDependency(project, version);
  const server = await startModelPlayback(protocol, "rewrite", [
    ...(action ? [action] : []),
    { kind: "text", text: "capture complete" },
  ]);
  let result;
  try {
    if (harness === "claude") {
      result = await runProcess(
        executable,
        [
          "-p",
          prompt,
          "--model",
          "hooknostic-playback",
          "--dangerously-skip-permissions",
          "--max-turns",
          "4",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        {
          cwd: project,
          timeoutMs: 120000,
          env: {
            ...env,
            ANTHROPIC_API_KEY: "local-playback",
            ANTHROPIC_BASE_URL: server.baseUrl,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
            DISABLE_AUTOUPDATER: "1",
            DISABLE_TELEMETRY: "1",
          },
        },
      );
    } else if (harness === "codex") {
      if (process.platform === "win32")
        writeFileSync(join(env.CODEX_HOME, "config.toml"), '[windows]\nsandbox = "unelevated"\n');
      result = await runProcess(
        executable,
        [
          "exec",
          "-",
          "--color",
          "never",
          "-c",
          'model="hooknostic-playback"',
          "-c",
          'model_provider="gate_probe"',
          "-c",
          'approval_policy="never"',
          "-c",
          'model_providers.gate_probe.name="Skill Gate Probe"',
          "-c",
          `model_providers.gate_probe.base_url=${q(server.baseUrl + "/v1")}`,
          "-c",
          'model_providers.gate_probe.wire_api="responses"',
          "-c",
          "model_providers.gate_probe.requires_openai_auth=false",
          "-c",
          "model_providers.gate_probe.request_max_retries=0",
          "-c",
          "model_providers.gate_probe.stream_max_retries=0",
          "-c",
          `projects={${q(project)}={trust_level="trusted"}}`,
        ],
        { cwd: project, input: prompt, timeoutMs: 120000, env },
      );
    } else if (harness === "opencode-v1") {
      writeOpencodeConfig(project, server.baseUrl, "local-playback", "hooknostic-playback");
      const configPath = join(project, "opencode.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (gated && !label.startsWith("plugin-")) config.permission = { skill: { "gate-opencode": "deny" } };
      if (gated && label.startsWith("plugin-")) {
        const plugins = join(project, ".opencode/plugins");
        mkdirSync(plugins, { recursive: true });
        writeFileSync(
          join(plugins, "gate.js"),
          'import { writeFileSync } from "node:fs";\nexport default async () => ({ config(config) { config.permission = { ...(config.permission ?? {}), skill: { "gate-opencode": "deny" } }; writeFileSync(new URL("../../plugin-config.json", import.meta.url), JSON.stringify(config.permission)); } });\n',
        );
      }
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      // Match the dependency helper's isolated config location.
      env.XDG_CONFIG_HOME = openCodePlaybackConfigHome(project);
      result = await runProcess(executable, ["run", prompt, "--model", "drift/hooknostic-playback"], {
        cwd: project,
        timeoutMs: 120000,
        env,
      });
    } else {
      writeFileSync(
        join(project, "opencode.json"),
        JSON.stringify(
          {
            model: "playback/hooknostic-playback",
            providers: {
              playback: {
                name: "Playback",
                env: ["HKN_PLAYBACK_KEY"],
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: server.baseUrl + "/v1" },
                models: { "hooknostic-playback": { name: "Playback", limit: { context: 128000, output: 4096 } } },
              },
            },
            ...(gated ? { permission: { skill: { "gate-opencode": "deny" } } } : {}),
          },
          null,
          2,
        ),
      );
      result = await runProcess(executable, ["run", "--standalone", "--auto", "--format", "json", prompt], {
        cwd: project,
        timeoutMs: 120000,
        env: { ...env, HKN_PLAYBACK_KEY: "local-playback" },
      });
    }
  } finally {
    await server.close();
  }
  const dir = join(out, label);
  mkdirSync(dir);
  writeFileSync(join(dir, "requests.json"), JSON.stringify(server.requests, null, 2) + "\n");
  writeFileSync(join(dir, "process.json"), JSON.stringify(result, null, 2) + "\n");
  const pluginConfig = existsSync(join(project, "plugin-config.json"))
    ? JSON.parse(readFileSync(join(project, "plugin-config.json"), "utf8"))
    : null;
  const modelRequests = server.requests.filter((request) => describeTools(request).length > 0);
  const evidence = {
    pluginConfig,
    harness,
    version,
    platform: process.platform,
    capturedAt: new Date().toISOString(),
    label,
    gated,
    prompt,
    action: action ?? null,
    exit: result.code,
    errors: server.errors,
    requestCount: server.requests.length,
    tools: server.requests.map(describeTools).find((tools) => tools.length) ?? [],
    initial: evidenceStrings(modelRequests.slice(0, 1)),
    subsequent: evidenceStrings(modelRequests.slice(1)),
  };
  writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    JSON.stringify({
      label,
      pluginConfig,
      version,
      exit: result.code,
      errors: server.errors,
      requests: server.requests.length,
      listed: skillNames.filter((name) => evidence.initial.some((text) => text.includes(`GATE_DESCRIPTION_${name}`))),
      bodies: skillNames.filter((name) =>
        [...evidence.initial, ...evidence.subsequent].some((text) => text.includes(`GATE_BODY_${name}`)),
      ),
      out: dir,
    }),
  );
  if (result.code !== 0 || server.errors.length || !server.requests.length)
    throw new Error(`Inconclusive ${label}: ${result.stderr.slice(-1500)}`);
  return evidence;
}

if (process.argv[3] === "--plugin-only") {
  if (harness !== "opencode-v1") throw new Error("The v1 config callback probe requires opencode-v1");
  const baseline = await session("plugin-baseline", false, "Reply with done.");
  if (!skillNames.every((name) => baseline.initial.some((text) => text.includes(`GATE_DESCRIPTION_${name}`))))
    throw new Error("Plugin baseline failed to advertise every control");
  const tool = baseline.tools.find((tool) => tool.name.toLowerCase() === "skill");
  const key = tool?.properties.find((key) => key === "name" || key === "id");
  if (!tool || !key) throw new Error("No discovered skill tool argument");
  await session("plugin-gated", true, "Reply with done.");
  await session("plugin-load-denied", true, "Reply with done.", {
    kind: "tool",
    toolName: tool.name,
    arguments: { [key]: "gate-opencode" },
  });
} else {
  const discovery = await session("baseline", false, "Reply with done.");
  if (!skillNames.every((name) => discovery.initial.some((text) => text.includes(`GATE_DESCRIPTION_${name}`))))
    throw new Error("Baseline failed to advertise every control");
  await session("gated", true, "Reply with done.");
  if (harness === "codex") await session("explicit-native", true, "$gate-codex");
  else if (harness === "claude") await session("explicit-native", true, "/gate-claude");
  else {
    const tool = discovery.tools.find((tool) => tool.name.toLowerCase() === "skill");
    const key = tool?.properties.find((key) => key === "name" || key === "id");
    if (!tool || !key) throw new Error("No discovered skill tool argument");
    const action = { kind: "tool", toolName: tool.name, arguments: { [key]: "gate-opencode" } };
    await session("load-control", false, "Reply with done.", action);
    await session("load-denied", true, "Reply with done.", action);
  }
}
console.log(JSON.stringify({ completed: harness, out }));
