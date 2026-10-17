#!/usr/bin/env node
// Native project/package skill policy probes. Model replies are scripted on loopback.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const policyProbe = process.argv.includes("--policy");
const packaged = process.argv.includes("--package");
const discoveryDirectory = process.argv.find(argument => argument.startsWith("--discovery-root="))?.slice(17);
if (discoveryDirectory !== undefined && (packaged || !/^\.[a-z]+\/skills?$/.test(discoveryDirectory)))
  throw new Error("Discovery-root probes require a native project-relative skill directory and no package flag");
const selectedCase = process.argv.find(argument => argument.startsWith("--case="))?.slice(7);
const versionHome = mkdtempSync(join(tmpdir(), "hkn-skill-version-"));
const versionResult = await runProcess(executable, ["--version"], {
  cwd: repo,
  env: { ...withoutCredentials(), HOME: versionHome, USERPROFILE: versionHome, XDG_DATA_HOME: versionHome, XDG_STATE_HOME: versionHome, CODEX_HOME: versionHome },
  timeoutMs: 120000,
});
const version = versionResult.stdout.match(/\d+\.\d+\.\d+/)?.[0];
if (versionResult.code !== 0 || !version) throw new Error(`Could not identify harness version: ${versionResult.stderr} ${versionResult.stdout}`);
const out = join(repo, ".capture/skill-invocation/captured", `${harness}-${version}${policyProbe ? "-policy" : ""}${packaged ? "-package" : ""}${discoveryDirectory === undefined ? "" : `-discovery-${discoveryDirectory.replaceAll("/", "-")}`}-${Date.now()}`);
mkdirSync(out, { recursive: true });
const skillNames = ["gate-control", "gate-claude", "gate-codex", "gate-opencode"];
const nativeSkillName = name => packaged && harness === "opencode-v1" ? `gate-probe-${name}` : name;
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
  if (selectedCase !== undefined && label !== selectedCase && label !== "baseline") return;
  const root = mkdtempSync(join(tmpdir(), "hkn-skill-gate-"));
  const project = join(root, "project");
  const plugin = join(root, "plugin");
  mkdirSync(project, { recursive: true });
  const skills = packaged ? join(plugin, "skills") : discoveryDirectory === undefined ? join(project, harness === "claude" ? ".claude" : ".agents", "skills") : join(project, discoveryDirectory);
  for (const name of skillNames) {
    const dir = join(skills, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${nativeSkillName(name)}\ndescription: GATE_DESCRIPTION_${name} harmless capture control.\n${(gated || label === "allowed") && name === "gate-claude" ? `disable-model-invocation: ${gated}\n` : ""}${policyProbe && harness === "opencode-v2" && (gated || label === "allowed") && name === "gate-opencode" ? `metadata:\n  opencode/autoinvoke: "${!gated}"\n` : ""}---\n\nGATE_BODY_${name}\nRespond with the word done.\n`,
    );
    if (policyProbe && discoveryDirectory === ".claude/skills" && name === "gate-opencode" && (gated || label === "allowed")) {
      const path = join(dir, "SKILL.md");
      writeFileSync(path, readFileSync(path, "utf8").replace(`description: GATE_DESCRIPTION_${name} harmless capture control.\n`, `description: GATE_DESCRIPTION_${name} harmless capture control.\ndisable-model-invocation: ${gated}\n`));
    }
    if ((gated || label === "allowed") && name === "gate-codex") {
      mkdirSync(join(dir, "agents"));
      writeFileSync(join(dir, "agents/openai.yaml"), `policy:\n  allow_implicit_invocation: ${!gated}\n`);
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
  const git = await runProcess(process.env.HKN_SKILL_GIT_BINARY ?? "git", ["init"], { cwd: project, env, timeoutMs: 30000 });
  if (git.code !== 0) throw new Error(`Could not initialize isolated project: ${git.stderr}`);
  if (harness === "opencode-v1") await prepareOpenCodePluginDependency(project, version);
  if (packaged && harness === "claude") {
    mkdirSync(join(plugin, ".claude-plugin"));
    writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "gate-probe", version: "1.0.0" }));
    const marketplace = join(root, "marketplace");
    mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
    cpSync(plugin, join(marketplace, "plugins/gate-probe"), { recursive: true });
    writeFileSync(join(marketplace, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "gate-capture", owner: { name: "Hooknostic contributors" }, plugins: [{ name: "gate-probe", source: "./plugins/gate-probe" }] }));
    for (const args of [["plugin", "marketplace", "add", marketplace], ["plugin", "install", "gate-probe@gate-capture"]]) {
      const installed = await runProcess(executable, args, { cwd: project, env, timeoutMs: 60000 });
      if (installed.code !== 0) throw new Error(`Plugin install failed: ${installed.stderr} ${installed.stdout}`);
    }
  }
  if (packaged && harness === "codex") {
    mkdirSync(join(plugin, ".codex-plugin"));
    writeFileSync(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "gate-probe", version: "1.0.0", description: "Harmless skill policy capture", skills: "./skills/" }));
    const marketplace = join(root, "marketplace");
    mkdirSync(join(marketplace, ".agents/plugins"), { recursive: true });
    cpSync(plugin, join(marketplace, "plugins/gate-probe"), { recursive: true });
    writeFileSync(join(marketplace, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "gate-capture", owner: { name: "Hooknostic contributors" }, plugins: [{ name: "gate-probe", source: { source: "local", path: "./plugins/gate-probe" } }] }));
    for (const args of [["plugin", "marketplace", "add", marketplace], ["plugin", "add", "gate-probe@gate-capture"]]) {
      const installed = await runProcess(executable, args, { cwd: project, env, timeoutMs: 60000 });
      if (installed.code !== 0) throw new Error(`Plugin install failed: ${installed.stderr} ${installed.stdout}`);
    }
  }
  let installedPackage;
  if (packaged && harness.startsWith("opencode")) {
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "gate-probe", version: "1.0.0", type: "module", exports: { ".": "./index.js", "./server": "./index.js" } }));
    const values = skillNames.map(name => ({ id: `gate-probe/${name}`, name, description: `GATE_DESCRIPTION_${name} harmless capture control.`, manifest: `skills/${name}/SKILL.md`, ...((gated || label === "allowed") && name === "gate-opencode" ? { autoinvoke: !gated } : {}) }));
    const common = 'import { readFileSync } from "node:fs";\nimport { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst root = dirname(fileURLToPath(import.meta.url));\n';
    const module = harness === "opencode-v1"
      ? `export default async () => ({ config(config) { config.skills = { ...(config.skills ?? {}), paths: [...(config.skills?.paths ?? []), join(root, "skills")] }; ${gated || label === "allowed" ? `config.permission = { ...(config.permission ?? {}), skill: { "${nativeSkillName("gate-opencode")}": "${gated ? "deny" : "allow"}" } };` : ""} } });\n`
      : `export default { id: "gate-probe", async setup(ctx) { await ctx.skill.transform(editor => { for (const skill of ${JSON.stringify(values)}) { const { manifest, ...info } = skill; const path = join(root, manifest); editor.add({ ...info, path, content: readFileSync(path, "utf8").replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/, "") }); } }); } };\n`;
    writeFileSync(join(plugin, "index.js"), common + module);
    const relocated = join(root, "installed"); mkdirSync(relocated);
    writeFileSync(join(relocated, "package.json"), JSON.stringify({ private: true }));
    const installed = await runProcess("npm", ["install", "--offline", "--ignore-scripts", "--install-links", "--no-audit", "--no-fund", plugin], { cwd: relocated, env, timeoutMs: 60000 });
    if (installed.code !== 0) throw new Error(`Local package install failed: ${installed.stderr} ${installed.stdout}`);
    installedPackage = join(relocated, "node_modules/gate-probe");
  }
  if (action?.kind === "read-skill") {
    const candidates = packaged ? readdirSync(env.CODEX_HOME, { recursive: true }).filter(path => String(path).replaceAll("\\", "/").endsWith("/skills/gate-codex/SKILL.md")) : [];
    const path = packaged ? join(env.CODEX_HOME, candidates[0] ?? "missing-skill") : join(skills, "gate-codex/SKILL.md");
    if (!existsSync(path)) throw new Error("Installed skill path was not found");
    action = { kind: "tool", toolName: action.toolName, arguments: { [action.key]: process.platform === "win32" ? `Get-Content -Raw -LiteralPath ${q(path)}` : `cat ${q(path)}`, ...(action.toolName === "exec_command" ? { login: false, yield_time_ms: 30000, max_output_tokens: 2000 } : {}) } };
  }
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
        writeFileSync(join(env.CODEX_HOME, "config.toml"), (existsSync(join(env.CODEX_HOME, "config.toml")) ? readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8") : "") + '\n[windows]\nsandbox = "unelevated"\n');
      result = await runProcess(
        executable,
        [
          "exec",
          "-",
          ...(policyProbe && label.startsWith("load-") ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
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
        { cwd: project, input: prompt, timeoutMs: 240000, env },
      );
    } else if (harness === "opencode-v1") {
      writeOpencodeConfig(project, server.baseUrl, "local-playback", "hooknostic-playback");
      const configPath = join(project, "opencode.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (packaged) config.plugin = [installedPackage];
      if (!packaged && (gated || label === "allowed") && !label.startsWith("plugin-")) config.permission = { skill: { "gate-opencode": gated ? "deny" : "allow" } };
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
      result = await runProcess(executable, ["run", ...(label === "explicit-native" ? ["--command", nativeSkillName("gate-opencode"), ""] : [prompt]), "--model", "drift/hooknostic-playback"], {
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
            ...(packaged ? { plugins: [installedPackage] } : {}),
            providers: {
              playback: {
                name: "Playback",
                env: ["HKN_PLAYBACK_KEY"],
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: server.baseUrl + "/v1" },
                models: { "hooknostic-playback": { name: "Playback", limit: { context: 128000, output: 4096 } } },
              },
            },
            ...(gated && !policyProbe ? { permission: { skill: { "gate-opencode": "deny" } } } : {}),
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
  } catch (error) {
    // Retain failed controls for diagnosis; promotion still rejects them.
    result = { code: null, stdout: "", stderr: String(error) };
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
    policyProbe,
    delivery: packaged ? "package" : "project",
    ...(discoveryDirectory === undefined ? {} : { discoveryDirectory }),
    ...(harness === "codex" && policyProbe && label.startsWith("load-") ? { loadingSandbox: "disabled for synthetic read controls" } : {}),
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
  const visible = (name) => evidence.initial.some((text) => text.includes(`GATE_DESCRIPTION_${name}`) || (harness === "claude" && new RegExp(`^- (?:gate-probe:)?${name}(?::|$)`, "m").test(text)));
  evidence.visibleSkills = skillNames.filter(visible);
  writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    JSON.stringify({
      label,
      pluginConfig,
      version,
      exit: result.code,
      errors: server.errors,
      requests: server.requests.length,
      listed: evidence.visibleSkills,
      bodies: skillNames.filter((name) =>
        [...evidence.initial, ...evidence.subsequent].some((text) => text.includes(`GATE_BODY_${name}`)),
      ),
      out: dir,
    }),
  );
  if (result.code !== 0 || server.errors.length || !server.requests.length)
    throw new Error(`Inconclusive ${label}: ${result.stderr.slice(-1500)}`);
  if (policyProbe) {
    const native = harness === "claude" ? "gate-claude" : harness === "codex" ? "gate-codex" : "gate-opencode";
    if (["baseline", "gated", "allowed"].includes(label)) {
      if (!visible("gate-control") || (visible(native) === gated)) throw new Error(`Invalid discovery control: ${label}`);
    }
    if (label === "explicit-native" || label === "load-control") {
      if (![...evidence.initial, ...evidence.subsequent].some(text => text.includes(`GATE_BODY_${native}`))) throw new Error(`Skill body did not reach the model: ${label}`);
    }
    if (label === "load-gated") {
      const loaded = [...evidence.initial, ...evidence.subsequent].some(text => text.includes(`GATE_BODY_${native}`));
      if (loaded !== (harness === "codex" || harness === "opencode-v2"))
        throw new Error(`Unexpected forced-loading result: ${harness}`);
    }
  }
  return evidence;
}

if (discoveryDirectory !== undefined && !policyProbe) {
  await session("baseline", false, "Reply with done.");
} else if (process.argv[3] === "--plugin-only") {
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
  if (!skillNames.every((name) => discovery.visibleSkills.includes(name)))
    throw new Error("Baseline failed to advertise every control");
  await session("gated", true, "Reply with done.");
  if (policyProbe) await session("allowed", false, "Reply with done.");
  if (harness === "codex") await session("explicit-native", true, packaged ? "$gate-probe:gate-codex" : "$gate-codex");
  else if (harness === "claude") await session("explicit-native", true, packaged ? "/gate-probe:gate-claude" : "/gate-claude");
  else {
    const tool = discovery.tools.find((tool) => tool.name.toLowerCase() === "skill");
    const key = tool?.properties.find((key) => key === "name" || key === "id");
    if (!tool || !key) throw new Error("No discovered skill tool argument");
    const action = { kind: "tool", toolName: tool.name, arguments: { [key]: packaged && harness === "opencode-v2" ? "gate-probe/gate-opencode" : nativeSkillName("gate-opencode") } };
    await session("load-control", false, "Reply with done.", action);
    await session(policyProbe ? "load-gated" : "load-denied", true, "Reply with done.", action);
    if (policyProbe) await session("explicit-native", true, harness === "opencode-v1" ? `/${nativeSkillName("gate-opencode")}` : packaged ? "@gate-probe/gate-opencode" : "@gate-opencode", harness === "opencode-v2" ? action : undefined);
  }
  if (policyProbe && (harness === "claude" || harness === "codex")) {
    const tool = discovery.tools.find(tool => harness === "claude" ? tool.name.toLowerCase() === "skill" : /exec_command|shell_command|shell/.test(tool.name));
    const key = tool?.properties.find(key => harness === "claude" ? key === "skill" : key === "cmd" || key === "command");
    if (!tool || !key) throw new Error("No native loading tool was advertised");
    const action = harness === "claude" ? { kind: "tool", toolName: tool.name, arguments: { [key]: packaged ? "gate-probe:gate-claude" : "gate-claude" } } : { kind: "read-skill", toolName: tool.name, key };
    await session("load-control", false, "Reply with done.", action);
    await session("load-gated", true, "Reply with done.", action);
  }
}
console.log(JSON.stringify({ completed: harness, out }));
