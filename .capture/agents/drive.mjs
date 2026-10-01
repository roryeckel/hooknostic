#!/usr/bin/env node
// Custom-agent (subagent definition) probe with no model spend. The real harness
// binary runs against the loopback playback model; a hand-written NATIVE agent
// file is seeded into a scratch project; the scripted parent delegates to it by
// name. A routing proxy sends every request that carries the agent's
// instruction marker, or the delegated task sentinel in a user message, to a
// child backend with its own script, so parent and child turns never share one
// turn counter. The primary-* and mode cases run the session itself as the
// agent instead, so the child backend drives the whole session. See README.md
// for the question, method and provenance boundary.
//
//   node --experimental-strip-types .capture/agents/drive.mjs <harness> [--only <case>]
//   harness: claude | codex | codex-home | opencode-v1 | opencode-v2
//
// opencode-v1 needs a 1.18 build first on PATH and HOOKNOSTIC_PLAYBACK_VERSION
// (see .capture/file-tools/README.md). Writes .capture/agents/captured/<harness>/<case>/
// (git-ignored): summary.json (the observations), requests.json (every model
// request with its lane), drive.json (exit code and output tail) and the tee's
// raw hook payloads.
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { openCodePlaybackConfigHome, prepareOpenCodePluginDependency, runProcess, startModelPlayback } = await import(
  pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href
);
const { driveCodex, driveOpencode, prepareScratch, withoutCredentials, writeOpencodeConfig } = await import(
  pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href
);
const { runProject } = await import(pathToFileURL(join(REPO, "packages/core/src/project.ts")).href);
const { buildProject } = await import(pathToFileURL(join(REPO, "packages/core/src/build.ts")).href);
const { AGENT_PLUGIN_MANIFEST_SCHEMA } = await import(pathToFileURL(join(REPO, "packages/agent-plugin/src/types.ts")).href);
const { defaultAdapterRegistry } = await import(pathToFileURL(join(REPO, "packages/cli/src/registry.ts")).href);
const { opencodeHarness, opencodeV1Adapter, opencodeV2Harness } = await import(
  pathToFileURL(join(REPO, "packages/adapter-opencode/src/index.ts")).href
);

// A drive started from inside a Claude Code session inherits that session's
// CLAUDE*/CLAUDECODE variables, which make the probe a child session.
for (const name of Object.keys(process.env)) if (/^CLAUDE/.test(name) || name === "AI_AGENT") delete process.env[name];

const OUT = join(REPO, ".capture/agents/captured");
const NONCE = randomBytes(4).toString("hex");
/** Only in the agent's instructions: proof they reached the child. */
const MARKER = `HKN-SUBAGENT-${NONCE}`;
/** Only in the agent's description: proof the parent was told about it. */
const DESC = `HKN-DESC-${NONCE}`;
/** Only in the delegated task: identifies the child's first user message. */
const TASK = `HKN-CHILD-TASK-${NONCE}`;
const CHILD_DONE = `HKN-CHILD-DONE-${NONCE}`;
/** A file the child's scripted shell call tries to write (sandbox probe). */
const CHILD_WRITE = "hn-child-write.txt";
const NAME = "hn-probe";
const MODEL = "hooknostic-playback";
const ALT_MODEL = "hooknostic-playback-alt";
const PROMPT = "Delegate the probe task to the hn-probe agent exactly once, then stop.";
/** The user turn of a session that runs as the agent itself (the primary-* cases). */
const PRIMARY_PROMPT = "Read seed.txt, then reply with the single word ready.";
const DESCRIPTION = `${DESC} Hooknostic capture probe. Use only when explicitly asked.`;
const INSTRUCTIONS = `${MARKER}\nYou are a hooknostic capture probe. Read seed.txt when asked, then reply with the single word ready.`;
const DELEGATION = `${TASK} Read seed.txt, then reply with the single word ready.`;
const PROTOCOL = {
  claude: "anthropic-messages",
  codex: "openai-responses",
  "codex-home": "openai-responses",
  "opencode-v1": "openai-chat",
  "opencode-v2": "openai-chat",
};

// ---------------------------------------------------------------------------
// Request texts, per wire protocol
// ---------------------------------------------------------------------------

function textParts(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part && typeof part === "object" && typeof part.text === "string" ? [part.text] : []));
}

/** System/developer-level texts and user-level texts of one model request. */
function texts(body) {
  const system = [];
  const user = [];
  if (body.system !== undefined) system.push(...textParts(body.system)); // anthropic-messages
  if (typeof body.instructions === "string") system.push(body.instructions); // openai-responses
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.role === "system" || item.role === "developer") system.push(...textParts(item.content));
    else if (item.role === "user") user.push(...textParts(item.content));
  }
  return { system, user };
}

function isChild(body) {
  const { system, user } = texts(body);
  return system.some((text) => text.includes(MARKER)) || user.some((text) => text.includes(TASK));
}

/** Every declared tool, namespace groups flattened, as raw declarations. */
function toolDeclarations(body) {
  const walk = (entries, namespace) =>
    (Array.isArray(entries) ? entries : []).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      if (entry.type === "namespace" && Array.isArray(entry.tools)) return walk(entry.tools, entry.name);
      return [namespace === undefined ? entry : { ...entry, namespace }];
    });
  return walk(body.tools);
}

function toolName(tool) {
  return typeof tool.name === "string" ? tool.name : typeof tool.function?.name === "string" ? tool.function.name : undefined;
}

// ---------------------------------------------------------------------------
// Routing proxy: one playback backend per lane
// ---------------------------------------------------------------------------

async function startRouter(protocol, parentScript, childScript, onRequest = () => {}) {
  const parent = await startModelPlayback(protocol, "rewrite", parentScript);
  const child = await startModelPlayback(protocol, "rewrite", childScript);
  const log = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed;
      try {
        parsed = body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
      } catch {
        parsed = undefined;
      }
      const lane = parsed !== undefined && isChild(parsed) ? "child" : "parent";
      if (parsed !== undefined) {
        log.push({ lane, url: req.url, body: parsed });
        // A lane's script is read when its backend answers, so a drive may
        // complete a scripted call from what this request carries.
        onRequest(lane, parsed);
      }
      const backend = new URL(lane === "child" ? child.baseUrl : parent.baseUrl);
      const headers = { ...req.headers, host: backend.host, "content-length": String(body.length) };
      delete headers["transfer-encoding"];
      const upstream = httpRequest(
        { host: backend.hostname, port: backend.port, method: req.method, path: req.url, headers },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(error));
      });
      upstream.end(body);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    log,
    errors: () => [...parent.errors.map((e) => `parent: ${e}`), ...child.errors.map((e) => `child: ${e}`)],
    close: async () => {
      await new Promise((resolveClose) => {
        server.close(() => resolveClose());
        for (const socket of sockets) socket.destroy();
      });
      await parent.close();
      await child.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Native agent definitions (hand-written, per harness)
// ---------------------------------------------------------------------------

function claudeAgent(extra = []) {
  return [
    "---",
    `name: ${NAME}`,
    `description: ${DESCRIPTION}`,
    "tools: Read, Grep",
    `model: ${ALT_MODEL}`,
    "maxTurns: 2",
    ...extra,
    "---",
    INSTRUCTIONS,
    "",
  ].join("\n");
}

/**
 * For the plan-* cases: no tool list, so the child's tools are the harness
 * default, and `permissionMode: plan`, which keeps ExitPlanMode in a subagent's
 * tools when honoured -- a visible trace of the one field under test.
 */
function claudePlanAgent() {
  return ["---", `name: ${NAME}`, `description: ${DESCRIPTION}`, "permissionMode: plan", "---", INSTRUCTIONS, ""].join(
    "\n",
  );
}

function codexAgent() {
  return [
    `name = "${NAME}"`,
    `description = "${DESCRIPTION}"`,
    'developer_instructions = """',
    INSTRUCTIONS,
    '"""',
    `model = "${ALT_MODEL}"`,
    // Without it the child inherits the parent's effort, which a different model
    // may not support: 0.156.1 refuses the spawn when the user config says xhigh.
    'model_reasoning_effort = "low"',
    'sandbox_mode = "read-only"',
    "",
  ].join("\n");
}

function opencodeV1Agent(stepsKey = "steps") {
  return [
    "---",
    `description: ${DESCRIPTION}`,
    "mode: subagent",
    `model: drift/${ALT_MODEL}`,
    `${stepsKey}: 2`,
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    INSTRUCTIONS,
    "",
  ].join("\n");
}

function opencodeV2Agent(readOnly = false) {
  return [
    "---",
    `description: ${DESCRIPTION}`,
    "mode: subagent",
    `model: playback/${ALT_MODEL}`,
    "steps: 2",
    // v2's documented rule list (action/resource/effect), denying the write paths.
    ...(readOnly
      ? [
          "permissions:",
          ...["edit", "shell"].flatMap((action) => [`  - action: ${action}`, '    resource: "*"', "    effect: deny"]),
        ]
      : []),
    "---",
    INSTRUCTIONS,
    "",
  ].join("\n");
}

/**
 * For the primary and mode cases: the same agent with no turn cap, so a session
 * running as the agent is not cut short, and on OpenCode with the `mode` under
 * test. The tool restriction and model stay, to be observed on the session.
 */
function claudePrimaryAgent() {
  return claudeAgent().replace("maxTurns: 2\n", "");
}

function opencodeV1ModeAgent(mode) {
  return opencodeV1Agent().replace("mode: subagent", `mode: ${mode}`).replace("steps: 2\n", "");
}

function opencodeV2ModeAgent(mode) {
  return opencodeV2Agent().replace("mode: subagent", `mode: ${mode}`).replace("steps: 2\n", "");
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/**
 * The same agent as a portable Hooknostic Agent Definition 0.1 file under
 * `<dir>/portable-agents/`. `withOpenCode: false` leaves out `native.opencode`,
 * for a route that cannot carry native fields and would report them.
 */
function writePortableDefinition(dir, harness, withOpenCode = true, mode = undefined) {
  const provider = harness === "opencode-v2" ? "playback" : "drift";
  write(
    join(dir, "portable-agents", `${NAME}.md`),
    [
      "---",
      `name: ${NAME}`,
      `description: ${DESCRIPTION}`,
      ...(mode === undefined ? [] : [`mode: ${mode}`]),
      "native:",
      "  claude:",
      `    model: ${ALT_MODEL}`,
      "    tools: [Read, Grep]",
      "  codex:",
      `    model: ${ALT_MODEL}`,
      "    model_reasoning_effort: low",
      ...(withOpenCode ? ["  opencode:", `    model: ${provider}/${ALT_MODEL}`] : []),
      "---",
      INSTRUCTIONS,
      "",
    ].join("\n"),
  );
}

/**
 * Component policy for a definition in `mode`: OpenCode v2 runs a session
 * started as the agent on the configured model, which the build reports as a
 * degradation of the definition's native model, and the drive accepts it -- a
 * primary case on v2 then shows the model the degradation names.
 */
function acceptFor(harness, mode) {
  return harness === "opencode-v2" && mode !== undefined && mode !== "subagent"
    ? { accept: ["opencode:primary-agent-model-ignored"] }
    : {};
}

/** The adapter registry, target id and version range a drive harness builds for. */
function buildTarget(harness) {
  const registry = defaultAdapterRegistry();
  if (harness === "opencode-v1") registry.opencode = opencodeV1Adapter();
  const id = harness.startsWith("codex") ? "codex" : harness.startsWith("opencode") ? "opencode" : "claude";
  const version = harness === "opencode-v2" ? opencodeV2Harness.recommendedRange : registry[id].harness.recommendedRange;
  return { registry, id, version };
}

/**
 * The `generated` case: the portable definition synchronized into the scratch
 * project by Hooknostic's own project delivery, so what the harness reads is
 * what a user's build writes.
 */
async function syncGenerated(scratch, harness, mode = undefined, defaultAgent = undefined) {
  writePortableDefinition(scratch, harness, true, mode);
  const { registry, id, version } = buildTarget(harness);
  const target = { version, delivery: "project", output: `.hooknostic/artifacts/${id}` };
  const configPath = join(scratch, "hooknostic.config.ts");
  const config = {
    project: { root: "." },
    components: {
      agents: ["./portable-agents"],
      ...acceptFor(harness, mode),
      ...(defaultAgent === undefined ? {} : { defaultAgent }),
    },
    targets: { [id]: target },
  };
  writeFileSync(configPath, `export default ${JSON.stringify(config, null, 2)};\n`, "utf8");
  const synced = await runProject({ configPath, registry, command: "sync" });
  if (!synced.ok) throw new Error(`hooknostic sync failed: ${JSON.stringify(synced.errors)}`);
}

/** Hooks for the `scoped` case, and the block reasons they leave in model requests. */
const SCOPED_ENTRY = join(REPO, ".capture/agents/scoped-hooks.ts");
/** The same, plus subagent lifecycle hooks, where the harness has those events. */
const SCOPED_LIFECYCLE_ENTRY = join(REPO, ".capture/agents/scoped-lifecycle-hooks.ts");
const SCOPED_BLOCK = "HKN-SCOPED-BLOCK";
/** What the scoped child touches second, which its guard must let through. */
const SCOPED_OTHER = "other.txt";
const SCOPED_OTHER_WRITE = "hn-other-write.txt";
const UNSCOPED_BLOCK = "HKN-UNSCOPED-BLOCK";

/** The installed build's version, e.g. "2.1.283", from `<binary> --version`. */
async function installedVersion(binary, env = process.env) {
  const reported = await runProcess(binary, ["--version"], { cwd: REPO, env, timeoutMs: 60_000 });
  const version = /(\d+\.\d+\.\d+)/.exec(reported.stdout + reported.stderr)?.[1];
  if (version === undefined) throw new Error(`${binary} --version reported no version: ${reported.stdout}`);
  return version;
}

/**
 * The `scoped` case (ADR-0030): the portable definition plus hooks scoped to
 * it, synchronized together and built for the installed build's exact version,
 * so the target's own agent-identity level decides whether the scope builds.
 * A refused build is an outcome, not a failure: the drive then delegates to a
 * native agent instead, so the tee still shows what the child's hooks carry.
 */
async function syncScoped(scratch, harness, version, mode = undefined) {
  writePortableDefinition(scratch, harness, true, mode);
  const { registry, id } = buildTarget(harness);
  const target = { version, delivery: "project", output: `.hooknostic/artifacts/${id}` };
  const configPath = join(scratch, "hooknostic.config.ts");
  const config = {
    project: { root: "." },
    entry: (id === "opencode" ? SCOPED_ENTRY : SCOPED_LIFECYCLE_ENTRY).replaceAll("\\", "/"),
    components: { agents: ["./portable-agents"], ...acceptFor(harness, mode) },
    targets: { [id]: target },
  };
  writeFileSync(configPath, `export default ${JSON.stringify(config, null, 2)};\n`, "utf8");
  // The entry sits in this repository, outside any package that depends on the
  // SDK, so it resolves the workspace source, as core's own tests do.
  const evaluate = { alias: { "@hooknostic/sdk": join(REPO, "packages/sdk/src/index.ts") } };
  const synced = await runProject({ configPath, registry, evaluate, command: "sync" });
  // The child reads this one after seed.txt; the guard lets it through.
  write(join(scratch, SCOPED_OTHER), "beta\n");
  // The trace hooks append here; the harness passes the variable on to them.
  const trace = join(scratch, "..", "scope-trace.jsonl");
  rmSync(trace, { force: true });
  process.env["HKN_SCOPE_TRACE"] = trace;
  return {
    version,
    trace,
    built: synced.ok,
    refusedBy: synced.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.capability ?? ""}`.trim()),
    errors: synced.errors,
  };
}

/** Cases that build hooks scoped to the probe: as a subagent, or as the session's agent. */
const SCOPED = new Set(["scoped", "scoped-primary"]);

/** The portable `mode` a case's definition declares, when it is not the default. */
function modeOf(caseName) {
  return caseName.endsWith("-primary") ? "primary" : undefined;
}

/** The Agent Plugins package the `packaged` case configures the definition beside. */
const PLUGIN = "hn-plugin";

/**
 * The `packaged` case: the portable definition configured beside a minimal
 * Agent Plugins package and built for package delivery, outside any project, so
 * what the harness loads is the package a user's build writes. OpenCode v2's
 * package route cannot carry native fields, so its definition has none. Returns
 * the built package directory.
 */
async function buildPackaged(dir, harness, mode = undefined) {
  writePortableDefinition(dir, harness, harness !== "opencode-v2", mode);
  write(
    join(dir, PLUGIN, "plugin.json"),
    `${JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: PLUGIN, version: "1.0.0", description: "Hooknostic capture probe package." }, null, 2)}\n`,
  );
  const { registry, id, version } = buildTarget(harness);
  const target = { version, delivery: "package", output: `dist/${id}` };
  const configPath = join(dir, "hooknostic.config.ts");
  const config = { components: { root: `./${PLUGIN}`, agents: ["./portable-agents"] }, targets: { [id]: target } };
  writeFileSync(configPath, `export default ${JSON.stringify(config, null, 2)};\n`, "utf8");
  const built = await buildProject({ configPath, registry });
  if (!built.ok) throw new Error(`hooknostic build failed: ${JSON.stringify(built.report.diagnostics)}`);
  return join(dir, target.output);
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const DISCOVERY = [{ kind: "text", text: "discovery complete" }];

function readTurns(toolName, key, seed) {
  const read = { kind: "tool", toolName, arguments: { [key]: seed } };
  return [read, { ...read }, { ...read }, { kind: "text", text: CHILD_DONE }];
}

/** The scoped child: seed.txt, which its guard blocks, then a file it allows. */
function scopedReadTurns(toolName, key, seed) {
  return [
    { kind: "tool", toolName, arguments: { [key]: seed } },
    { kind: "tool", toolName, arguments: { [key]: join(dirname(seed), SCOPED_OTHER) } },
    { kind: "text", text: CHILD_DONE },
  ];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function claudeEnv(baseUrl) {
  return {
    ...withoutCredentials(),
    ANTHROPIC_API_KEY: "hooknostic-playback",
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
  };
}

async function claudeSession(caseName) {
  const scratch = join(mkdtempSync(join(tmpdir(), "hkn-agents-")), "claude");
  prepareScratch(REPO, "claude", scratch);
  const seed = join(scratch, "seed.txt");
  write(seed, "alpha\n");
  const extraArgs = [];
  let subagentType = NAME;
  if (caseName === "direct") write(join(scratch, ".claude/agents", `${NAME}.md`), claudeAgent());
  // Uncapped: the child reaches its final text, so a normal stop can be seen.
  if (caseName === "complete") write(join(scratch, ".claude/agents", `${NAME}.md`), claudeAgent().replace("maxTurns: 2\n", ""));
  if (caseName === "control") write(join(scratch, ".claude/agents-off", `${NAME}.md`), claudeAgent());
  if (caseName === "neutral") write(join(scratch, ".agents/agents", `${NAME}.md`), claudeAgent());
  if (caseName === "generated") await syncGenerated(scratch, "claude");
  // The *-primary cases deliver a `mode: primary` definition through
  // Hooknostic's own build and start the session as it.
  if (caseName === "generated-primary") await syncGenerated(scratch, "claude", "primary");
  // generated-default: the same, named components.defaultAgent, and the
  // session started with no --agent at all.
  if (caseName === "generated-default") await syncGenerated(scratch, "claude", "primary", NAME);
  const scope = SCOPED.has(caseName)
    ? await syncScoped(scratch, "claude", await installedVersion("claude"), modeOf(caseName))
    : undefined;
  if (scope !== undefined && !scope.built) {
    write(join(scratch, ".claude/agents", `${NAME}.md`), modeOf(caseName) ? claudePrimaryAgent() : claudeAgent());
  }
  if (caseName === "generated-primary" || caseName === "scoped-primary") extraArgs.push("--agent", NAME);
  if (caseName === "packaged-primary") {
    extraArgs.push("--plugin-dir", await buildPackaged(join(scratch, "..", "packaged"), "claude", "primary"));
    extraArgs.push("--agent", `${PLUGIN}:${NAME}`);
  }
  if (caseName === "plan-project") write(join(scratch, ".claude/agents", `${NAME}.md`), claudePlanAgent());
  if (caseName === "plugin" || caseName === "plan-plugin") {
    const plugin = join(scratch, "..", PLUGIN);
    write(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: PLUGIN, version: "0.0.0" }, null, 2));
    // Fields the docs say a plugin agent ignores ride along, to be observed.
    write(
      join(plugin, "agents", `${NAME}.md`),
      caseName === "plan-plugin" ? claudePlanAgent() : claudeAgent(["permissionMode: plan"]),
    );
    extraArgs.push("--plugin-dir", plugin);
    subagentType = `${PLUGIN}:${NAME}`;
  }
  if (caseName === "packaged") {
    extraArgs.push("--plugin-dir", await buildPackaged(join(scratch, "..", "packaged"), "claude"));
    subagentType = `${PLUGIN}:${NAME}`;
  }
  // The primary-* and deny-flag cases run the session itself as the agent, so
  // its requests carry the instructions and go to the child backend; the parent
  // lane sees only requests that do not. They pass no --model, so the agent's
  // own model can show.
  const primary =
    caseName.startsWith("primary-") ||
    caseName === "deny-flag" ||
    caseName.endsWith("-primary") ||
    caseName === "generated-default";
  if (["primary-flag", "primary-setting", "deny", "deny-flag"].includes(caseName)) {
    write(join(scratch, ".claude/agents", `${NAME}.md`), claudePrimaryAgent());
  }
  if (caseName === "primary-flag" || caseName === "deny-flag") extraArgs.push("--agent", NAME);
  if (caseName === "primary-setting" || caseName.startsWith("deny")) {
    const settingsPath = join(scratch, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (caseName === "primary-setting") settings.agent = NAME;
    // The documented way to keep Claude from delegating to an agent.
    else settings.permissions = { deny: [`Agent(${NAME})`] };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }
  if (caseName.startsWith("primary-plugin")) {
    const plugin = join(scratch, "..", PLUGIN);
    write(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: PLUGIN, version: "0.0.0" }, null, 2));
    write(join(plugin, "agents", `${NAME}.md`), claudePrimaryAgent());
    // A plugin's own default, from settings.json at its root, in either spelling.
    if (caseName === "primary-plugin-setting") write(join(plugin, "settings.json"), JSON.stringify({ agent: NAME }));
    if (caseName === "primary-plugin-setting-qualified") {
      write(join(plugin, "settings.json"), JSON.stringify({ agent: `${PLUGIN}:${NAME}` }));
    }
    extraArgs.push("--plugin-dir", plugin);
    if (caseName === "primary-plugin") extraArgs.push("--agent", `${PLUGIN}:${NAME}`);
    if (caseName === "primary-plugin-bare") extraArgs.push("--agent", NAME);
  }
  const delegates = [
    "direct",
    "complete",
    "plugin",
    "generated",
    "packaged",
    "scoped",
    "plan-project",
    "plan-plugin",
    "deny",
  ].includes(caseName);
  // A bypassing parent takes precedence over a subagent's own permission
  // mode, so the plan-* cases run the parent in the default mode instead.
  const permissions = caseName.startsWith("plan-") ? [] : ["--dangerously-skip-permissions"];
  const parentScript = delegates
    ? [
        {
          kind: "tool",
          toolName: "Agent",
          arguments: { description: "hn probe", prompt: DELEGATION, subagent_type: subagentType, run_in_background: false },
        },
        { kind: "text", text: "parent complete" },
      ]
    : DISCOVERY;
  const router = await startRouter(
    PROTOCOL.claude,
    parentScript,
    (scope ? scopedReadTurns : readTurns)("Read", "file_path", seed),
  );
  let result;
  try {
    result = await runProcess(
      "claude",
      [
        "-p",
        primary ? PRIMARY_PROMPT : PROMPT,
        ...(primary ? [] : ["--model", MODEL]),
        "--settings",
        join(scratch, ".claude", "settings.json"),
        ...permissions,
        "--max-turns",
        "6",
        ...extraArgs,
      ],
      { cwd: scratch, timeoutMs: 180_000, env: claudeEnv(router.baseUrl) },
    );
  } finally {
    await router.close();
  }
  return { scratch, captured: join(scratch, "captured"), result, router, delegation: ["Agent", "Task"], scope };
}

/**
 * Codex with its configuration persisted in an isolated CODEX_HOME, rather than
 * as `-c` session overrides a spawned child may not inherit (#33097 lost the
 * session-scoped hook-trust bypass that way). Never touches the real home.
 */
async function runCodexHome(
  scratch,
  baseUrl,
  prompt,
  sandbox = "danger-full-access",
  trusted = true,
  { args = [], homeLines = [] } = {},
) {
  const home = join(scratch, "..", "codex-home");
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  write(
    join(home, "config.toml"),
    [
      `model = "${MODEL}"`,
      'model_provider = "hkn_playback"',
      'approval_policy = "never"',
      `sandbox_mode = "${sandbox}"`,
      "",
      "[model_providers.hkn_playback]",
      'name = "Hooknostic Playback"',
      `base_url = ${literal(`${baseUrl}/v1`)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
      ...(trusted ? [`[projects.${literal(scratch)}]`, 'trust_level = "trusted"'] : []),
      ...(process.platform === "win32" ? ["", "[windows]", 'sandbox = "unelevated"'] : []),
      ...homeLines,
      "",
    ].join("\n"),
  );
  await runProcess("git", ["init"], { cwd: scratch, env: process.env, timeoutMs: 30_000 });
  return runProcess("codex", ["exec", "-", "--dangerously-bypass-hook-trust", "--color", "never", ...args], {
    cwd: scratch,
    input: prompt,
    timeoutMs: 180_000,
    env: { ...withoutCredentials(), CODEX_HOME: home },
  });
}

/** The first `targets`-shaped id a spawn result carries, if any. */
function spawnedId(body) {
  const items = Array.isArray(body.input) ? body.input : [];
  for (const item of [...items].reverse()) {
    if (item?.type !== "function_call_output") continue;
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
    try {
      const parsed = JSON.parse(output);
      for (const key of ["agent_id", "id", "thread_id", "target", "nickname"]) {
        if (typeof parsed?.[key] === "string") return parsed[key];
      }
    } catch {
      // Not JSON: fall through to the textual forms below.
    }
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(output);
    if (uuid) return uuid[0];
  }
  return undefined;
}

/**
 * The Codex main-session cases: Codex has no agent a session runs as, so these
 * ask whether configuration can stand in for one. `project-instructions`
 * writes the agent's instructions and model at the top level of the project's
 * `.codex/config.toml`; `project-profile` writes them as `[profiles.hn-probe]`
 * there, and `home-profile` in the isolated CODEX_HOME, both run with
 * `--profile hn-probe`. As in the other primary cases, every request that
 * carries the instructions reaches the child backend.
 */
const CODEX_PRIMARY_CASES = new Set([
  "project-instructions",
  "project-instructions-only",
  "project-instructions-untrusted",
  "project-profile",
  "home-profile",
]);

function codexAgentKeys() {
  return [
    'developer_instructions = """',
    INSTRUCTIONS,
    '"""',
    `model = "${ALT_MODEL}"`,
    'model_reasoning_effort = "low"',
  ];
}

async function codexPrimarySession(caseName) {
  const scratch = join(mkdtempSync(join(tmpdir(), "hkn-agents-")), "codex");
  prepareScratch(REPO, "codex", scratch);
  write(join(scratch, "seed.txt"), "alpha\n");
  const profile = ["[profiles.hn-probe]", ...codexAgentKeys()];
  if (caseName === "project-instructions" || caseName === "project-instructions-untrusted") {
    write(join(scratch, ".codex/config.toml"), `${codexAgentKeys().join("\n")}\n`);
  }
  // The instructions alone, on the session's own model.
  if (caseName === "project-instructions-only") {
    write(join(scratch, ".codex/config.toml"), `${codexAgentKeys().slice(0, 3).join("\n")}\n`);
  }
  if (caseName === "project-profile") write(join(scratch, ".codex/config.toml"), `${profile.join("\n")}\n`);
  const router = await startRouter(PROTOCOL.codex, DISCOVERY, [{ kind: "text", text: CHILD_DONE }]);
  let result;
  try {
    // No trust entry for the untrusted case: project config should not load.
    result = await runCodexHome(scratch, router.baseUrl, PRIMARY_PROMPT, undefined, !caseName.endsWith("-untrusted"), {
      args: caseName.startsWith("project-instructions") ? [] : ["--profile", NAME],
      homeLines: caseName === "home-profile" ? ["", ...profile] : [],
    });
  } finally {
    await router.close();
  }
  return { scratch, captured: join(scratch, "captured"), result, router, delegation: ["spawn_agent"] };
}

async function codexSession(caseName, isolatedHome) {
  if (CODEX_PRIMARY_CASES.has(caseName)) return codexPrimarySession(caseName);
  const scratch = join(mkdtempSync(join(tmpdir(), "hkn-agents-")), "codex");
  prepareScratch(REPO, "codex", scratch);
  const seed = join(scratch, "seed.txt");
  write(seed, "alpha\n");
  // sandbox-*: the session runs workspace-write and the agent asks for the
  // opposite extreme, so whichever value the child reports is attributable.
  const delegating =
    caseName === "direct" || caseName === "generated" || caseName === "scoped" || caseName.startsWith("sandbox-");
  const scope =
    caseName === "scoped"
      ? await syncScoped(scratch, isolatedHome ? "codex-home" : "codex", await installedVersion("codex"))
      : undefined;
  if (caseName === "generated") await syncGenerated(scratch, isolatedHome ? "codex-home" : "codex");
  // A primary default: Codex takes its instructions into the project's
  // configuration, and every session runs on them.
  else if (caseName === "generated-default") {
    await syncGenerated(scratch, isolatedHome ? "codex-home" : "codex", "primary", NAME);
  } else if (scope?.built === true) {
    // The synchronized definition is the agent under test.
  } else if (delegating || ["discover", "unknown-key", "untrusted"].includes(caseName)) {
    let agent = codexAgent() + (caseName === "unknown-key" ? 'hooknostic_unknown_key = "x"\n' : "");
    if (caseName === "sandbox-full") agent = agent.replace('sandbox_mode = "read-only"', 'sandbox_mode = "danger-full-access"');
    write(join(scratch, ".codex/agents", `${NAME}.toml`), agent);
  }
  if (caseName === "control") write(join(scratch, ".codex/agents-off", `${NAME}.toml`), codexAgent());
  if (caseName === "neutral") {
    // Either spelling a vendor-neutral directory could plausibly hold.
    write(join(scratch, ".agents/agents", `${NAME}.toml`), codexAgent());
    write(join(scratch, ".agents/agents", `${NAME}-md.md`), claudeAgent().replace(`name: ${NAME}`, `name: ${NAME}-md`));
  }
  if (caseName === "cross") write(join(scratch, ".claude/agents", `${NAME}.md`), claudeAgent());
  const wait = { kind: "tool", toolName: "wait_agent", arguments: { targets: [], timeout_ms: 60_000 } };
  const parentScript = delegating
    ? [
        { kind: "tool", toolName: "spawn_agent", arguments: { message: DELEGATION, agent_type: NAME } },
        wait,
        { kind: "text", text: "parent complete" },
      ]
    : DISCOVERY;
  // The spawn result names the child; the wait turn needs that id.
  const onRequest = (lane, body) => {
    if (lane !== "parent") return;
    const id = spawnedId(body);
    if (id !== undefined) wait.arguments = { targets: [id], timeout_ms: 60_000 };
  };
  // The child's one shell call tries to write a file: under the agent's
  // `sandbox_mode = "read-only"` it should not appear (checked after the run).
  const shellTurns = [
    { kind: "tool", disposition: "rewrite", marker: CHILD_WRITE },
    // The scoped case's guard blocks the first write only.
    ...(scope ? [{ kind: "tool", disposition: "rewrite", marker: SCOPED_OTHER_WRITE }] : []),
    { kind: "text", text: CHILD_DONE },
  ];
  const asDefault = caseName === "generated-default";
  const childScript = delegating ? shellTurns : asDefault ? [{ kind: "text", text: CHILD_DONE }] : DISCOVERY;
  const router = await startRouter(PROTOCOL.codex, parentScript, childScript, onRequest);
  const prompt = asDefault ? PRIMARY_PROMPT : PROMPT;
  let result;
  try {
    result = isolatedHome
      ? await runCodexHome(
          scratch,
          router.baseUrl,
          prompt,
          caseName.startsWith("sandbox-") ? "workspace-write" : undefined,
          caseName !== "untrusted",
        )
      : await driveCodex(scratch, { baseUrl: `${router.baseUrl}/v1`, name: MODEL }, prompt);
  } finally {
    await router.close();
  }
  return {
    scratch,
    captured: join(scratch, "captured"),
    result,
    router,
    delegation: ["spawn_agent", "wait_agent"],
    scope,
  };
}

function patchOpencodeV1Models(scratch, pluginPackage, defaultAgent) {
  const path = join(scratch, "opencode.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.provider.drift.models[ALT_MODEL] = { name: ALT_MODEL, limit: { context: 32768, output: 4096 } };
  if (pluginPackage !== undefined) config.plugin = [pluginPackage.replaceAll("\\", "/")];
  if (defaultAgent !== undefined) config.default_agent = defaultAgent;
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

/** A plugin whose `config` hook adds the agent, in `mode`, and optionally makes it the default. */
function v1Injector(mode = "subagent", makeDefault = false) {
  return `export default async () => ({
  config: (config) => {
    config.agent = { ...(config.agent ?? {}) };
    config.agent[${JSON.stringify(NAME)}] = {
      description: ${JSON.stringify(DESCRIPTION)},
      mode: ${JSON.stringify(mode)},
      model: ${JSON.stringify(`drift/${ALT_MODEL}`)},
      prompt: ${JSON.stringify(INSTRUCTIONS)},
    };${makeDefault ? `\n    config.default_agent = ${JSON.stringify(NAME)};` : ""}
  },
});
`;
}

/**
 * `opencode run` as driveOpencode starts it, but with no --model, so an agent's
 * own model can show, and with the caller's arguments (--agent).
 */
async function runOpencodeV1(scratch, args) {
  await runProcess("git", ["init"], { cwd: scratch, env: process.env, timeoutMs: 30_000 });
  return runProcess("opencode", ["run", ...args, "--print-logs", "--log-level", "DEBUG"], {
    cwd: scratch,
    timeoutMs: 180_000,
    env: { ...withoutCredentials(), PWD: scratch, XDG_CONFIG_HOME: openCodePlaybackConfigHome(scratch) },
  });
}

/**
 * The mode cases, OpenCode v1 and v2 alike: the `mode` the agent file declares.
 * `*-flag` runs the session as the agent (`--agent`), `default-agent` names it
 * `default_agent`, and `primary-hidden`/`all-listed` run the default agent to
 * see whether the delegation tool offers it.
 */
const MODE_CASES = {
  "primary-flag": "primary",
  "primary-hidden": "primary",
  "default-agent": "primary",
  "all-flag": "all",
  "all-listed": "all",
  "subagent-flag": "subagent",
};
/** Cases whose session is started with `--agent hn-probe`. */
const AS_AGENT = new Set([
  "primary-flag",
  "all-flag",
  "subagent-flag",
  "inject-primary",
  "generated-primary",
  "packaged-primary",
  "scoped-primary",
]);
/** Cases whose session should start as the agent without being told to. */
const AS_DEFAULT = new Set(["default-agent", "inject-default", "generated-default"]);

async function opencodeV1Session(caseName) {
  // The tee plugin's dependency must match the harness build on PATH; CI's
  // playback lane installs the reference version, so that is the default.
  const version = process.env["HOOKNOSTIC_PLAYBACK_VERSION"] || opencodeHarness.referenceVersion;
  const scratch = join(mkdtempSync(join(tmpdir(), "hkn-agents-")), "opencode");
  prepareScratch(REPO, "opencode", scratch);
  await prepareOpenCodePluginDependency(scratch, version);
  const seed = join(scratch, "seed.txt");
  write(seed, "alpha\n");
  if (caseName === "direct") write(join(scratch, ".opencode/agents", `${NAME}.md`), opencodeV1Agent());
  if (caseName === "maxsteps") write(join(scratch, ".opencode/agents", `${NAME}.md`), opencodeV1Agent("maxSteps"));
  if (caseName === "singular") write(join(scratch, ".opencode/agent", `${NAME}.md`), opencodeV1Agent());
  if (caseName === "control") write(join(scratch, ".opencode/agents-off", `${NAME}.md`), opencodeV1Agent());
  if (caseName === "neutral") write(join(scratch, ".agents/agents", `${NAME}.md`), claudeAgent());
  if (caseName === "cross") write(join(scratch, ".claude/agents", `${NAME}.md`), claudeAgent());
  if (caseName === "inject") write(join(scratch, ".opencode/plugins/hn-inject.js"), v1Injector());
  if (caseName === "inject-primary" || caseName === "inject-default") {
    write(join(scratch, ".opencode/plugins/hn-inject.js"), v1Injector("primary", caseName === "inject-default"));
  }
  if (caseName in MODE_CASES) write(join(scratch, ".opencode/agents", `${NAME}.md`), opencodeV1ModeAgent(MODE_CASES[caseName]));
  if (caseName === "generated") await syncGenerated(scratch, "opencode-v1");
  if (caseName === "generated-primary") await syncGenerated(scratch, "opencode-v1", "primary");
  if (caseName === "generated-default") await syncGenerated(scratch, "opencode-v1", "primary", NAME);
  const scope = SCOPED.has(caseName)
    ? await syncScoped(scratch, "opencode-v1", await installedVersion("opencode"), modeOf(caseName))
    : undefined;
  if (scope !== undefined && !scope.built) {
    write(
      join(scratch, ".opencode/agents", `${NAME}.md`),
      modeOf(caseName) ? opencodeV1ModeAgent("primary") : opencodeV1Agent(),
    );
  }
  // Named by path from opencode.json, as a consumer would name the package.
  const packaged =
    caseName === "packaged" || caseName === "packaged-primary"
      ? await buildPackaged(join(scratch, "..", "packaged"), "opencode-v1", modeOf(caseName))
      : undefined;
  const delegates = ["direct", "maxsteps", "singular", "inject", "generated", "packaged", "scoped"].includes(caseName);
  const parentScript = delegates
    ? [
        {
          kind: "tool",
          toolName: "task",
          arguments: {
            description: "hn probe",
            prompt: DELEGATION,
            subagent_type: packaged === undefined ? NAME : `${PLUGIN}-${NAME}`,
          },
        },
        { kind: "text", text: "parent complete" },
      ]
    : DISCOVERY;
  const router = await startRouter(
    PROTOCOL["opencode-v1"],
    parentScript,
    (scope ? scopedReadTurns : readTurns)("read", "filePath", seed),
  );
  let result;
  try {
    writeOpencodeConfig(scratch, router.baseUrl, "hooknostic-playback", MODEL);
    patchOpencodeV1Models(scratch, packaged, caseName === "default-agent" ? NAME : undefined);
    const agent = packaged === undefined ? NAME : `${PLUGIN}-${NAME}`;
    result =
      AS_AGENT.has(caseName) || AS_DEFAULT.has(caseName)
        ? await runOpencodeV1(scratch, [PRIMARY_PROMPT, ...(AS_AGENT.has(caseName) ? ["--agent", agent] : [])])
        : await driveOpencode(scratch, MODEL, PROMPT);
  } finally {
    await router.close();
  }
  return {
    scratch,
    captured: join(scratch, ".opencode", "plugins", "captured"),
    result,
    router,
    delegation: ["task"],
    scope,
  };
}

/** Records tool boundary events, and what the v2 agent API offers a plugin. */
const V2_TEE = `import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const methods = (value) => {
  const names = new Set();
  for (let object = value; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) if (name !== "constructor") names.add(name);
  }
  return [...names].sort();
};

export default {
  id: "hooknostic.capture.agents",
  async setup(ctx) {
    const root = process.env.HKN_CAPTURE_DIR;
    mkdirSync(root, { recursive: true });
    // The envelope Hooknostic's v2 shim hands its decoder, so a row can become a fixture.
    const record = (hook, event) =>
      appendFileSync(join(root, "events.jsonl"), JSON.stringify({ hook, directory: ctx.location?.directory, event }) + "\\n");
    record("setup.surface", { ctx: methods(ctx), agent: ctx.agent === undefined ? null : methods(ctx.agent) });
    // inject: a subagent; inject-primary: a primary agent; inject-default: a
    // primary agent the editor's default() then selects.
    const effect = process.env.HKN_PROBE_EFFECT ?? "";
    if (effect.startsWith("inject") && ctx.agent?.transform) {
      try {
        await ctx.agent.transform((editor) => {
          record("agent.editor", {
            methods: methods(editor),
            list: editor.list?.().map((agent) => agent.id ?? agent.name),
            default: String(editor.default).slice(0, 400),
          });
          const definition = {
            id: ${JSON.stringify(NAME)},
            description: ${JSON.stringify(DESCRIPTION)},
            mode: effect === "inject" ? "subagent" : "primary",
            system: ${JSON.stringify(INSTRUCTIONS)},
          };
          for (const [name, call] of [
            ["add", () => editor.add(definition)],
            ["set", () => editor.set(${JSON.stringify(NAME)}, definition)],
            ["update", () => editor.update(${JSON.stringify(NAME)}, (agent) => Object.assign(agent, definition))],
          ]) {
            if (typeof editor[name] !== "function") continue;
            try {
              call();
              record("agent.editor.call", { name, ok: true, list: editor.list?.().map((agent) => agent.id ?? agent.name) });
              break;
            } catch (error) {
              record("agent.editor.call", { name, ok: false, error: String(error) });
            }
          }
          if (effect === "inject-default") {
            try {
              const returned = editor.default(${JSON.stringify(NAME)});
              record("agent.editor.default", { ok: true, returned: String(returned) });
            } catch (error) {
              record("agent.editor.default", { ok: false, error: String(error) });
            }
          }
        });
      } catch (error) {
        record("agent.transform.error", String(error));
      }
    }
    for (const hook of ["execute.before", "execute.after"]) {
      await ctx.tool.hook(hook, async (event) => record(hook, event));
    }
  },
};
`;

async function opencodeV2Session(caseName) {
  const root = mkdtempSync(join(tmpdir(), "hkn-agents-v2-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".opencode/plugins"), { recursive: true });
  write(join(project, ".opencode/plugins/capture.js"), V2_TEE);
  const seed = join(project, "seed.txt");
  write(seed, "alpha\n");
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    PWD: project,
    HKN_CAPTURE_DIR: join(root, "captured"),
    HKN_PROBE_EFFECT: caseName,
    HKN_PLAYBACK_KEY: "local-playback",
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  for (const name of Object.keys(env)) {
    if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|OPENCODE/.test(name) && name !== "HKN_PLAYBACK_KEY") delete env[name];
  }
  let executable = process.env["HKN_OPENCODE_BINARY"] ?? "opencode";
  if (process.platform === "win32" && !process.env["HKN_OPENCODE_BINARY"]) {
    const npmRoot = await runProcess("npm", ["root", "--global"], { cwd: project, env });
    executable = join(npmRoot.stdout.trim(), "@opencode/cli/bin/opencode.exe");
  }
  if (caseName === "direct") write(join(project, ".opencode/agents", `${NAME}.md`), opencodeV2Agent());
  if (caseName === "readonly") write(join(project, ".opencode/agents", `${NAME}.md`), opencodeV2Agent(true));
  if (caseName === "control") write(join(project, ".opencode/agents-off", `${NAME}.md`), opencodeV2Agent());
  if (caseName === "neutral") write(join(project, ".agents/agents", `${NAME}.md`), claudeAgent());
  if (caseName === "cross") write(join(project, ".claude/agents", `${NAME}.md`), claudeAgent());
  if (caseName in MODE_CASES) write(join(project, ".opencode/agents", `${NAME}.md`), opencodeV2ModeAgent(MODE_CASES[caseName]));
  if (caseName === "generated") await syncGenerated(project, "opencode-v2");
  if (caseName === "generated-primary") await syncGenerated(project, "opencode-v2", "primary");
  if (caseName === "generated-default") await syncGenerated(project, "opencode-v2", "primary", NAME);
  const scope = SCOPED.has(caseName)
    ? await syncScoped(project, "opencode-v2", await installedVersion(executable, env), modeOf(caseName))
    : undefined;
  if (scope !== undefined) env["HKN_SCOPE_TRACE"] = scope.trace;
  if (scope !== undefined && !scope.built) {
    write(
      join(project, ".opencode/agents", `${NAME}.md`),
      modeOf(caseName) ? opencodeV2ModeAgent("primary") : opencodeV2Agent(),
    );
  }
  const packaged =
    caseName === "packaged" || caseName === "packaged-primary"
      ? await buildPackaged(join(root, "packaged"), "opencode-v2", modeOf(caseName))
      : undefined;
  const delegates = ["direct", "readonly", "inject", "generated", "packaged", "scoped"].includes(caseName);
  const parentScript = delegates
    ? [
        {
          kind: "tool",
          toolName: "subagent",
          arguments: {
            agent: packaged === undefined ? NAME : `${PLUGIN}-${NAME}`,
            description: "hn probe",
            prompt: DELEGATION,
          },
        },
        { kind: "text", text: "parent complete" },
      ]
    : DISCOVERY;
  const router = await startRouter(
    PROTOCOL["opencode-v2"],
    parentScript,
    (scope ? scopedReadTurns : readTurns)("read", "path", seed),
  );
  const model = (name) => ({ name, limit: { context: 128000, output: 4096 } });
  write(
    join(project, "opencode.json"),
    JSON.stringify({
      ...(packaged === undefined ? {} : { plugins: [packaged] }),
      ...(caseName === "default-agent" ? { default_agent: NAME } : {}),
      // Always set. Without it a session running as the agent does not fall
      // back to the agent's own model: 2.0.17 reached OpenCode's hosted
      // default provider instead of the loopback server (README).
      model: `playback/${MODEL}`,
      providers: {
        playback: {
          name: "Playback",
          env: ["HKN_PLAYBACK_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${router.baseUrl}/v1` },
          models: { [MODEL]: model("Playback"), [ALT_MODEL]: model("Playback alt") },
        },
      },
    }),
  );
  let result;
  try {
    const primary = AS_AGENT.has(caseName) || AS_DEFAULT.has(caseName);
    result = await runProcess(
      executable,
      [
        "run",
        "--standalone",
        "--auto",
        "--format",
        "json",
        ...(AS_AGENT.has(caseName) ? ["--agent", packaged === undefined ? NAME : `${PLUGIN}-${NAME}`] : []),
        primary ? PRIMARY_PROMPT : PROMPT,
      ],
      { cwd: project, env, timeoutMs: 180_000 },
    );
  } finally {
    await router.close();
  }
  return { scratch: project, captured: join(root, "captured"), result, router, delegation: ["subagent"], scope };
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function excerpt(text, limit = 1500) {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length} chars]` : text;
}

/**
 * Whether the tee saw the running agent named on a tool event inside the
 * child -- the raw field ADR-0030 normalizes -- whatever Hooknostic decided.
 */
function rows(file) {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

/**
 * Every `<hook>:<agent>` pair the tee saw, "-" where the event named none:
 * Claude's and Codex's `agent_type`, OpenCode v1's `chat.message` agent (its
 * tool events carry none) and OpenCode v2's tool-event `agent`. In the primary
 * cases, where the session itself runs as the agent, this is what the session's
 * own events say about it.
 */
function teeIdentity(harness, captured) {
  const seen = new Set();
  if (harness === "claude" || harness.startsWith("codex")) {
    for (const hook of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
      for (const row of rows(join(captured, `${hook}.jsonl`))) seen.add(`${hook}:${row.agent_type ?? "-"}`);
    }
  } else if (harness === "opencode-v1") {
    for (const row of rows(join(captured, "chat.message.jsonl"))) {
      seen.add(`chat.message:${row.output?.message?.agent ?? "-"}`);
    }
    for (const row of rows(join(captured, "tool.execute.before.jsonl"))) {
      seen.add(`tool.execute.before:${row.input?.agent ?? "-"}`);
    }
  } else {
    for (const row of rows(join(captured, "events.jsonl"))) {
      if (row.hook === "execute.before") seen.add(`execute.before:${row.event?.agent ?? "-"}`);
    }
  }
  return [...seen].sort();
}

/** Output lines about agent selection or fallbacks, which a summary would otherwise lose. */
function outputNotes(result) {
  return (result.stdout + result.stderr)
    .split(/\r?\n/)
    .filter((line) => /fall(?:ing)?[ -]?back|is a subagent|primary agent|not found|unknown agent|no agent/i.test(line))
    .slice(0, 12)
    .map((line) => line.slice(0, 400));
}

function childToolIdentity(harness, captured) {
  if (harness === "claude" || harness.startsWith("codex")) {
    return rows(join(captured, "PreToolUse.jsonl")).some((row) => typeof row.agent_type === "string");
  }
  if (harness === "opencode-v1") {
    return rows(join(captured, "tool.execute.before.jsonl")).some((row) => row.input !== null && "agent" in (row.input ?? {}));
  }
  return rows(join(captured, "events.jsonl")).some((row) => row.hook === "execute.before" && row.event?.agent === NAME);
}

function summarize(harness, caseName, session) {
  const { router, result } = session;
  const parentRequests = router.log.filter((entry) => entry.lane === "parent" && toolDeclarations(entry.body).length > 0);
  const childRequests = router.log.filter((entry) => entry.lane === "child");
  const firstParent = parentRequests[0]?.body;
  const delegationTools = firstParent
    ? toolDeclarations(firstParent).filter((tool) => session.delegation.includes(toolName(tool)))
    : [];
  // The prompt names the agent, so only the tool declarations can show that the
  // harness itself advertised it; the description nonce appears nowhere else.
  const declared = firstParent === undefined ? "" : JSON.stringify(toolDeclarations(firstParent));
  const serialized = firstParent === undefined ? "" : JSON.stringify(firstParent);
  return {
    harness,
    case: caseName,
    nonce: NONCE,
    exit: result.code,
    playbackErrors: router.errors(),
    childWriteLanded: existsSync(join(session.scratch, CHILD_WRITE)),
    scope: session.scope ?? null,
    blocks: {
      scopedInChild: childRequests.some((entry) => JSON.stringify(entry.body).includes(SCOPED_BLOCK)),
      scopedInParent: router.log.some(
        (entry) => entry.lane === "parent" && JSON.stringify(entry.body).includes(SCOPED_BLOCK),
      ),
      unscoped: router.log.some((entry) => JSON.stringify(entry.body).includes(UNSCOPED_BLOCK)),
    },
    childToolIdentity: childToolIdentity(harness, session.captured),
    identity: teeIdentity(harness, session.captured),
    outputNotes: outputNotes(result),
    // What the scoped trace hooks saw, and whether the call they let through ran.
    scopeTrace:
      session.scope?.trace !== undefined && existsSync(session.scope.trace)
        ? readFileSync(session.scope.trace, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    otherWriteLanded: existsSync(join(session.scratch, SCOPED_OTHER_WRITE)),
    parent: {
      toolBearingRequests: parentRequests.length,
      advertisedTools: firstParent ? toolDeclarations(firstParent).map(toolName) : [],
      nameInTools: declared.includes(NAME),
      descriptionInTools: declared.includes(DESC),
      descriptionInRequest: serialized.includes(DESC),
      delegationTools,
      childResultReturned: router.log.some(
        (entry) => entry.lane === "parent" && JSON.stringify(entry.body).includes(CHILD_DONE),
      ),
    },
    child: {
      requests: childRequests.length,
      toolBearingRequests: childRequests.filter((entry) => toolDeclarations(entry.body).length > 0).length,
      turns: childRequests.map((entry) => {
        const { system } = texts(entry.body);
        const joined = system.join("\n\n");
        // Codex states the child's effective filesystem policy in its prompt.
        const sandbox = /`sandbox_mode` is `([a-z-]+)`/.exec(JSON.stringify(entry.body))?.[1];
        return {
          url: entry.url,
          model: entry.body.model,
          ...(sandbox === undefined ? {} : { sandboxReported: sandbox }),
          tools: toolDeclarations(entry.body).map(toolName),
          markerInSystem: system.some((text) => text.includes(MARKER)),
          systemParts: system.length,
          system: excerpt(joined),
        };
      }),
    },
  };
}

function record(harness, caseName, session) {
  // HKN_CAPTURE_LABEL keeps runs against another build (a reference version) apart.
  const label = process.env["HKN_CAPTURE_LABEL"];
  const dest = join(OUT, harness, label ? `${caseName}@${label}` : caseName);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (existsSync(session.captured)) cpSync(session.captured, join(dest, "tee"), { recursive: true });
  writeFileSync(join(dest, "requests.json"), JSON.stringify(session.router.log, null, 2) + "\n", "utf8");
  writeFileSync(
    join(dest, "drive.json"),
    JSON.stringify(
      { exit: session.result.code, scratch: session.scratch, tail: (session.result.stdout + session.result.stderr).slice(-4000) },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const summary = summarize(harness, caseName, session);
  writeFileSync(join(dest, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  // One machine-readable line for packages/cli/test/agent-definition-playback.test.ts.
  console.log(`HKN-SUMMARY ${JSON.stringify(summary)}`);
  const child = summary.child;
  console.log(
    `[${harness}/${caseName}] exit=${summary.exit} errors=${summary.playbackErrors.length} ` +
      `parent: nameInTools=${summary.parent.nameInTools} descInTools=${summary.parent.descriptionInTools} ` +
      `descInRequest=${summary.parent.descriptionInRequest} ` +
      `returned=${summary.parent.childResultReturned} | child: requests=${child.requests} ` +
      `withTools=${child.toolBearingRequests} marker=${child.turns.some((turn) => turn.markerInSystem)} ` +
      `models=${[...new Set(child.turns.map((turn) => turn.model))].join(",")} -> ${dest}`,
  );
}

const CASES = {
  claude: [
    "direct",
    "complete",
    "control",
    "neutral",
    "plugin",
    "generated",
    "packaged",
    "scoped",
    "plan-project",
    "plan-plugin",
    "primary-flag",
    "primary-setting",
    "primary-plugin",
    "primary-plugin-bare",
    "primary-plugin-setting",
    "primary-plugin-setting-qualified",
    "deny",
    "deny-flag",
    "generated-primary",
    "packaged-primary",
    "scoped-primary",
    "generated-default",
  ],
  codex: ["discover", "direct", "control", "neutral", "cross", "unknown-key", "generated", "scoped", "generated-default"],
  "codex-home": [
    "direct",
    "sandbox-read-only",
    "sandbox-full",
    "untrusted",
    "generated",
    "scoped",
    ...CODEX_PRIMARY_CASES,
    "generated-default",
  ],
  "opencode-v1": [
    "direct",
    "maxsteps",
    "singular",
    "control",
    "neutral",
    "cross",
    "inject",
    "generated",
    "packaged",
    "scoped",
    ...Object.keys(MODE_CASES),
    "inject-primary",
    "inject-default",
    "generated-primary",
    "packaged-primary",
    "scoped-primary",
    "generated-default",
  ],
  "opencode-v2": [
    "direct",
    "readonly",
    "control",
    "neutral",
    "cross",
    "inject",
    "generated",
    "packaged",
    "scoped",
    ...Object.keys(MODE_CASES),
    "inject-primary",
    "inject-default",
    "generated-primary",
    "packaged-primary",
    "scoped-primary",
    "generated-default",
  ],
};

async function main() {
  const harness = process.argv[2];
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
  if (!(harness in CASES)) {
    console.error(`usage: drive.mjs <${Object.keys(CASES).join("|")}> [--only <case>]`);
    process.exit(2);
  }
  for (const caseName of CASES[harness]) {
    if (only !== undefined && only !== caseName) continue;
    const session =
      harness === "claude"
        ? await claudeSession(caseName)
        : harness === "codex" || harness === "codex-home"
          ? await codexSession(caseName, harness === "codex-home")
          : harness === "opencode-v1"
            ? await opencodeV1Session(caseName)
            : await opencodeV2Session(caseName);
    record(harness, caseName, session);
  }
}

await main();
