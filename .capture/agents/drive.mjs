#!/usr/bin/env node
// Custom-agent (subagent definition) probe with no model spend. The real harness
// binary runs against the loopback playback model; a hand-written NATIVE agent
// file is seeded into a scratch project; the scripted parent delegates to it by
// name. A routing proxy sends every request that carries the agent's
// instruction marker, or the delegated task sentinel in a user message, to a
// child backend with its own script, so parent and child turns never share one
// turn counter. See README.md for the question, method and provenance boundary.
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
const { prepareOpenCodePluginDependency, runProcess, startModelPlayback } = await import(
  pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href
);
const { driveCodex, driveOpencode, prepareScratch, withoutCredentials, writeOpencodeConfig } = await import(
  pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href
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

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const DISCOVERY = [{ kind: "text", text: "discovery complete" }];

function readTurns(toolName, key, seed) {
  const read = { kind: "tool", toolName, arguments: { [key]: seed } };
  return [read, { ...read }, { ...read }, { kind: "text", text: CHILD_DONE }];
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
  if (caseName === "plugin") {
    const plugin = join(scratch, "..", "hn-plugin");
    write(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "hn-plugin", version: "0.0.0" }, null, 2));
    // Fields the docs say a plugin agent ignores ride along, to be observed.
    write(join(plugin, "agents", `${NAME}.md`), claudeAgent(["permissionMode: plan"]));
    extraArgs.push("--plugin-dir", plugin);
    subagentType = `hn-plugin:${NAME}`;
  }
  const delegates = ["direct", "complete", "plugin"].includes(caseName);
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
  const router = await startRouter(PROTOCOL.claude, parentScript, readTurns("Read", "file_path", seed));
  let result;
  try {
    result = await runProcess(
      "claude",
      [
        "-p",
        PROMPT,
        "--model",
        MODEL,
        "--settings",
        join(scratch, ".claude", "settings.json"),
        "--dangerously-skip-permissions",
        "--max-turns",
        "6",
        ...extraArgs,
      ],
      { cwd: scratch, timeoutMs: 180_000, env: claudeEnv(router.baseUrl) },
    );
  } finally {
    await router.close();
  }
  return { scratch, captured: join(scratch, "captured"), result, router, delegation: ["Agent", "Task"] };
}

/**
 * Codex with its configuration persisted in an isolated CODEX_HOME, rather than
 * as `-c` session overrides a spawned child may not inherit (#33097 lost the
 * session-scoped hook-trust bypass that way). Never touches the real home.
 */
async function runCodexHome(scratch, baseUrl, prompt, sandbox = "danger-full-access", trusted = true) {
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
      "",
    ].join("\n"),
  );
  await runProcess("git", ["init"], { cwd: scratch, env: process.env, timeoutMs: 30_000 });
  return runProcess("codex", ["exec", "-", "--dangerously-bypass-hook-trust", "--color", "never"], {
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

async function codexSession(caseName, isolatedHome) {
  const scratch = join(mkdtempSync(join(tmpdir(), "hkn-agents-")), "codex");
  prepareScratch(REPO, "codex", scratch);
  const seed = join(scratch, "seed.txt");
  write(seed, "alpha\n");
  // sandbox-*: the session runs workspace-write and the agent asks for the
  // opposite extreme, so whichever value the child reports is attributable.
  const delegating = caseName === "direct" || caseName.startsWith("sandbox-");
  if (delegating || ["discover", "unknown-key", "untrusted"].includes(caseName)) {
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
    { kind: "text", text: CHILD_DONE },
  ];
  const router = await startRouter(PROTOCOL.codex, parentScript, delegating ? shellTurns : DISCOVERY, onRequest);
  let result;
  try {
    result = isolatedHome
      ? await runCodexHome(
          scratch,
          router.baseUrl,
          PROMPT,
          caseName.startsWith("sandbox-") ? "workspace-write" : undefined,
          caseName !== "untrusted",
        )
      : await driveCodex(scratch, { baseUrl: `${router.baseUrl}/v1`, name: MODEL }, PROMPT);
  } finally {
    await router.close();
  }
  return { scratch, captured: join(scratch, "captured"), result, router, delegation: ["spawn_agent", "wait_agent"] };
}

function patchOpencodeV1Models(scratch) {
  const path = join(scratch, "opencode.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.provider.drift.models[ALT_MODEL] = { name: ALT_MODEL, limit: { context: 32768, output: 4096 } };
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

const V1_INJECTOR = `export default async () => ({
  config: (config) => {
    config.agent = { ...(config.agent ?? {}) };
    config.agent[${JSON.stringify(NAME)}] = {
      description: ${JSON.stringify(DESCRIPTION)},
      mode: "subagent",
      model: ${JSON.stringify(`drift/${ALT_MODEL}`)},
      prompt: ${JSON.stringify(INSTRUCTIONS)},
    };
  },
});
`;

async function opencodeV1Session(caseName) {
  const version = process.env["HOOKNOSTIC_PLAYBACK_VERSION"];
  if (!version) throw new Error("HOOKNOSTIC_PLAYBACK_VERSION is required for opencode-v1");
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
  if (caseName === "inject") write(join(scratch, ".opencode/plugins/hn-inject.js"), V1_INJECTOR);
  const delegates = ["direct", "maxsteps", "singular", "inject"].includes(caseName);
  const parentScript = delegates
    ? [
        {
          kind: "tool",
          toolName: "task",
          arguments: { description: "hn probe", prompt: DELEGATION, subagent_type: NAME },
        },
        { kind: "text", text: "parent complete" },
      ]
    : DISCOVERY;
  const router = await startRouter(PROTOCOL["opencode-v1"], parentScript, readTurns("read", "filePath", seed));
  let result;
  try {
    writeOpencodeConfig(scratch, router.baseUrl, "hooknostic-playback", MODEL);
    patchOpencodeV1Models(scratch);
    result = await driveOpencode(scratch, MODEL, PROMPT);
  } finally {
    await router.close();
  }
  return {
    scratch,
    captured: join(scratch, ".opencode", "plugins", "captured"),
    result,
    router,
    delegation: ["task"],
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
    const record = (hook, event) => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ hook, event }) + "\\n");
    record("setup.surface", { ctx: methods(ctx), agent: ctx.agent === undefined ? null : methods(ctx.agent) });
    if (process.env.HKN_PROBE_EFFECT === "inject" && ctx.agent?.transform) {
      try {
        await ctx.agent.transform((editor) => {
          record("agent.editor", { methods: methods(editor), list: editor.list?.().map((agent) => agent.id ?? agent.name) });
          const definition = {
            id: ${JSON.stringify(NAME)},
            description: ${JSON.stringify(DESCRIPTION)},
            mode: "subagent",
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
  if (caseName === "direct") write(join(project, ".opencode/agents", `${NAME}.md`), opencodeV2Agent());
  if (caseName === "readonly") write(join(project, ".opencode/agents", `${NAME}.md`), opencodeV2Agent(true));
  if (caseName === "control") write(join(project, ".opencode/agents-off", `${NAME}.md`), opencodeV2Agent());
  if (caseName === "neutral") write(join(project, ".agents/agents", `${NAME}.md`), claudeAgent());
  if (caseName === "cross") write(join(project, ".claude/agents", `${NAME}.md`), claudeAgent());
  const delegates = caseName === "direct" || caseName === "readonly" || caseName === "inject";
  const parentScript = delegates
    ? [
        {
          kind: "tool",
          toolName: "subagent",
          arguments: { agent: NAME, description: "hn probe", prompt: DELEGATION },
        },
        { kind: "text", text: "parent complete" },
      ]
    : DISCOVERY;
  const router = await startRouter(PROTOCOL["opencode-v2"], parentScript, readTurns("read", "path", seed));
  const model = (name) => ({ name, limit: { context: 128000, output: 4096 } });
  write(
    join(project, "opencode.json"),
    JSON.stringify({
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
  let result;
  try {
    result = await runProcess(executable, ["run", "--standalone", "--auto", "--format", "json", PROMPT], {
      cwd: project,
      env,
      timeoutMs: 180_000,
    });
  } finally {
    await router.close();
  }
  return { scratch: project, captured: join(root, "captured"), result, router, delegation: ["subagent"] };
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

function excerpt(text, limit = 1500) {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length} chars]` : text;
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
  const dest = join(OUT, harness, caseName);
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
  claude: ["direct", "complete", "control", "neutral", "plugin"],
  codex: ["discover", "direct", "control", "neutral", "cross", "unknown-key"],
  "codex-home": ["direct", "sandbox-read-only", "sandbox-full", "untrusted"],
  "opencode-v1": ["direct", "maxsteps", "singular", "control", "neutral", "cross", "inject"],
  "opencode-v2": ["direct", "readonly", "control", "neutral", "cross", "inject"],
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
