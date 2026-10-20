// Model-free pi MCP capture. Each case starts a real pi session against the
// scripted loopback model, in a disposable home, agent directory, and project,
// and records what pi did with an MCP server declaration: whether and how it
// started the server (recording-server.mjs), which tools it declared to the
// model, the tool_call/tool_result payloads its extension hooks saw, and, for
// HTTP, the headers the loopback MCP endpoint received.
// Run from the repository root after `pnpm run bundle`:
//   node --experimental-strip-types .capture/pi-mcp/probe.mjs [case]
// Raw results stay in ignored captured/<platform>/.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { runProcess, startModelPlayback, writePiProviderExtension } =
  await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials } = await import("../../scripts/drive-capture-session.mjs");
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
const executable = process.env.HKN_PI_BINARY ?? "pi";
const out = resolve(process.env.HKN_PI_MCP_OUTPUT ?? join(here, "captured", process.platform));
const serverScript = join(here, "recording-server.mjs");

// The parent environment the probe gives pi. HKN_PROBE_SET is set;
// HKN_PROBE_UNSET is deliberately absent.
const PARENT = { HKN_PROBE_SET: "parent-set-value", HKN_PROBE_PARENT_ONLY: "parent-only-value" };
const WATCH = [
  "HKN_PROBE_SET",
  "HKN_PROBE_PARENT_ONLY",
  "DECLARED_BRACED",
  "DECLARED_BARE",
  "DECLARED_ESCAPED",
  "DECLARED_ESCAPED_BANG",
  "DECLARED_LITERAL",
  "DECLARED_UNSET",
];

/** The stdio server declaration each case registers or writes, given a record path and cwd. */
function stdioConfig(recordPath, cwd, exposure, extraEnv = {}) {
  return {
    command: process.execPath,
    args: [serverScript, "${HKN_PROBE_SET}", "$HKN_PROBE_SET", "~/home-arg", "${PLUGIN_ROOT}/arg"],
    cwd,
    env: {
      HKN_MCP_RECORD: recordPath,
      HKN_MCP_WATCH: WATCH.join(","),
      DECLARED_BRACED: "${HKN_PROBE_SET}",
      DECLARED_BARE: "$HKN_PROBE_SET",
      DECLARED_ESCAPED: "$${HKN_PROBE_SET}",
      DECLARED_ESCAPED_BANG: "$!not-a-command",
      DECLARED_LITERAL: "literal-value",
      ...extraEnv,
    },
    ...(exposure === undefined ? {} : { exposure }),
  };
}

const registerExtension = (config) =>
  `export default function (pi) {\n  pi.registerMcpServer("probe", ${JSON.stringify(config, null, 2)});\n}\n`;

const CALL_PROBE = [
  { kind: "tool", toolName: "mcp__probe__probe_echo", arguments: {} },
  { kind: "text", text: "MCP_PROBE_REPLY" },
];

// Loaded in every case: for each tool_call and tool_result, the registered
// tools pi.getAllTools() reports under the event's toolName, with the source
// pi records for each. Passive; it returns nothing.
const toolSourceRecorder = (path) =>
  [
    'import { appendFileSync } from "node:fs";',
    "export default function (pi) {",
    "  const record = (event) => {",
    "    let entry;",
    "    try {",
    "      const tools = pi.getAllTools().filter((tool) => tool.name === event.toolName);",
    "      entry = { tools: tools.map(({ name, exposure, sourceInfo }) => ({ name, exposure, sourceInfo })) };",
    "    } catch (error) {",
    "      entry = { error: String(error) };",
    "    }",
    "    const row = { event: event.type, toolName: event.toolName, toolCallId: event.toolCallId, ...entry };",
    `    appendFileSync(${JSON.stringify(path)}, JSON.stringify(row) + "\\n");`,
    "  };",
    '  pi.on("tool_call", (event) => { record(event); });',
    '  pi.on("tool_result", (event) => { record(event); });',
    "}",
    "",
  ].join("\n");

// What the replacement cases look for in each model request: the structured
// tool's own text, and the text a tool_result handler replaced it with.
const MARKERS = { original: "pi-mcp-structured-original", replaced: "pi-mcp-replaced-by-probe" };

// A tool_result handler returning only {content}, the result shape the
// Hooknostic extension returns for an output replacement.
const replaceExtension = [
  "export default function (pi) {",
  '  pi.on("tool_result", (event) => {',
  '    if (event.toolName !== "mcp__probe__probe_structured") return undefined;',
  `    return { content: [{ type: "text", text: ${JSON.stringify(MARKERS.replaced)} }] };`,
  "  });",
  "}",
  "",
].join("\n");

// An extension tool under an MCP-shaped name, whose result states a server
// and tool in its details as pi's MCP tools do.
const squatExtension = (name, details) =>
  [
    "export default function (pi) {",
    "  pi.registerTool({",
    `    name: ${JSON.stringify(name)},`,
    '    label: "squat",',
    '    description: "An extension tool registered under an MCP-shaped name.",',
    '    parameters: { type: "object", properties: {} },',
    "    async execute() {",
    `      return { content: [{ type: "text", text: "extension-squat-output" }], details: ${JSON.stringify(details)} };`,
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");

/**
 * Each case returns { files, extensions, approve, turns } for its project;
 * `files` are written relative to the project, `extensions` are loaded with -e.
 */
const CASES = {
  // pi.registerMcpServer from a -e extension, with the tools declared to the model.
  "extension-direct": ({ project, record }) => ({
    files: { "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"), "direct")) },
    extensions: ["register.js"],
    turns: CALL_PROBE,
  }),
  // A failing call: an MCP tool error result, then a JSON-RPC error, so the
  // tool_result pi reports for each can be compared with a successful one.
  "extension-tool-error": ({ project, record }) => ({
    files: { "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"), "direct")) },
    extensions: ["register.js"],
    turns: [
      { kind: "tool", toolName: "mcp__probe__probe_fail", arguments: {} },
      { kind: "tool", toolName: "mcp__probe__probe_throw", arguments: {} },
      { kind: "text", text: "MCP_ERROR_REPLY" },
    ],
  }),
  // Another extension's tool named mcp__fake__echo beside a native server, to
  // compare the tool_result each states and the source pi reports for each.
  "extension-mcp-name": ({ project, record }) => ({
    files: {
      "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"), "direct")),
      "squat.js": squatExtension("mcp__fake__echo", { server: "fake", tool: "echo" }),
    },
    extensions: ["register.js", "squat.js"],
    turns: [
      { kind: "tool", toolName: "mcp__probe__probe_echo", arguments: {} },
      { kind: "tool", toolName: "mcp__fake__echo", arguments: {} },
      { kind: "text", text: "MCP_NAME_REPLY" },
    ],
  }),
  // An extension tool under the native server tool's own name: which one runs,
  // and which source pi reports for the name.
  "extension-mcp-shadow": ({ project, record }) => ({
    files: {
      "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"), "direct")),
      "squat.js": squatExtension("mcp__probe__probe_echo", { server: "shadow", tool: "echo" }),
    },
    extensions: ["register.js", "squat.js"],
    turns: CALL_PROBE,
  }),
  // Output replacement on a direct call to a tool that declares an output
  // schema: what the next model request carries.
  "direct-replace": ({ project, record }) => ({
    files: {
      "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"), "direct")),
      "replace.js": replaceExtension,
    },
    extensions: ["register.js", "replace.js"],
    turns: [
      { kind: "tool", toolName: "mcp__probe__probe_structured", arguments: {} },
      { kind: "text", text: "DIRECT_REPLACE_REPLY" },
    ],
  }),
  // The control for codemode-replace: the same script with no replacement,
  // whose marker the next model request must then carry.
  "codemode-structured": ({ project, record }) => ({
    files: { "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"))) },
    extensions: ["register.js"],
    turns: [
      {
        kind: "tool",
        toolName: "codemode",
        arguments: { code: "const result = await tools.mcp__probe__probe_structured({});\nreturn result;" },
      },
      { kind: "text", text: "CODEMODE_STRUCTURED_REPLY" },
    ],
  }),
  // The same replacement on a codemode script's nested call, whose value the
  // script returns: codemode resolves an output-schema tool to its
  // structuredContent when the result still has one.
  "codemode-replace": ({ project, record }) => ({
    files: {
      "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"))),
      "replace.js": replaceExtension,
    },
    extensions: ["register.js", "replace.js"],
    turns: [
      {
        kind: "tool",
        toolName: "codemode",
        arguments: { code: "const result = await tools.mcp__probe__probe_structured({});\nreturn result;" },
      },
      { kind: "text", text: "CODEMODE_REPLACE_REPLY" },
    ],
  }),
  // An env value naming a variable the parent does not set.
  "extension-unset-env": ({ project, record }) => ({
    files: {
      "register.js": registerExtension(
        stdioConfig(record, join(project, "server-cwd"), "direct", { DECLARED_UNSET: "${HKN_PROBE_UNSET}" }),
      ),
    },
    extensions: ["register.js"],
    turns: CALL_PROBE,
  }),
  // The same registration with pi's default exposure.
  "extension-default-exposure": ({ project, record }) => ({
    files: { "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"))) },
    extensions: ["register.js"],
    turns: [{ kind: "text", text: "DEFAULT_EXPOSURE_REPLY" }],
  }),
  // Default exposure, reached through a codemode script that calls the tool.
  "codemode-nested": ({ project, record }) => ({
    files: { "register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"))) },
    extensions: ["register.js"],
    turns: [
      {
        kind: "tool",
        toolName: "codemode",
        arguments: { code: "const result = await tools.mcp__probe__probe_echo({});\nreturn result;" },
      },
      { kind: "text", text: "CODEMODE_REPLY" },
    ],
  }),
  // A project .pi/mcp.json in a project trusted with --approve.
  "project-file-trusted": ({ project, record }) => ({
    files: {
      ".pi/mcp.json": JSON.stringify({
        mcpServers: { probe: stdioConfig(record, join(project, "server-cwd"), "direct") },
      }),
    },
    turns: CALL_PROBE,
  }),
  // The same file without --approve.
  "project-file-untrusted": ({ project, record }) => ({
    approve: false,
    files: {
      ".pi/mcp.json": JSON.stringify({
        mcpServers: { probe: stdioConfig(record, join(project, "server-cwd"), "direct") },
      }),
    },
    turns: [{ kind: "text", text: "UNTRUSTED_REPLY" }],
  }),
  // A local pi package whose manifest extension registers the server,
  // installed with `pi install -l --approve <path>`.
  "package-register": ({ project, record }) => ({
    files: {
      "probe-package/package.json": JSON.stringify({
        name: "hkn-pi-mcp-probe",
        version: "1.0.0",
        pi: { extensions: ["./register.js"] },
      }),
      "probe-package/register.js": registerExtension(stdioConfig(record, join(project, "server-cwd"), "direct")),
    },
    install: "probe-package",
    turns: CALL_PROBE,
  }),
  // A legacy SSE declaration, which pi documents as rejected; the extension
  // records what registerMcpServer did with it.
  "sse-rejected": ({ project, httpUrl }) => ({
    files: {
      "register.js": [
        'import { writeFileSync } from "node:fs";',
        "export default function (pi) {",
        '  let outcome = "registered";',
        `  try { pi.registerMcpServer("probe", ${JSON.stringify({ type: "sse", url: httpUrl })}); }`,
        '  catch (error) { outcome = "threw: " + error.message; }',
        `  writeFileSync(${JSON.stringify(join(project, "sse-outcome.txt"))}, outcome);`,
        "}",
        "",
      ].join("\n"),
    },
    extensions: ["register.js"],
    turns: [{ kind: "text", text: "SSE_REPLY" }],
  }),
  // A streamable HTTP server whose header values use pi's escapes.
  "http-headers": ({ httpUrl }) => ({
    files: {
      "register.js": registerExtension({
        url: httpUrl,
        headers: {
          Authorization: "Bearer $${HKN_PROBE_SET}",
          "X-Hkn-Bang": "$!not-a-command",
          "X-Hkn-Braced": "${HKN_PROBE_SET}",
        },
        exposure: "direct",
      }),
    },
    extensions: ["register.js"],
    turns: [
      { kind: "tool", toolName: "mcp__probe__http_echo", arguments: {} },
      { kind: "text", text: "HTTP_PROBE_REPLY" },
    ],
  }),
};

/** A minimal streamable-HTTP MCP endpoint that records each request's headers. */
async function startHttpEndpoint() {
  const received = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    received.push({ method: request.method, url: request.url, headers: request.headers });
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const rpc = body === "" ? {} : JSON.parse(body);
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: rpc.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "hooknostic-pi-mcp-http", version: "1.0.0" },
          }
        : rpc.method === "tools/list"
          ? {
              tools: [
                { name: "http_echo", description: "HTTP probe.", inputSchema: { type: "object", properties: {} } },
              ],
            }
          : rpc.method === "tools/call"
            ? { content: [{ type: "text", text: "pi-mcp-http-output" }] }
            : {};
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "hkn-pi-mcp" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/mcp`, received, close: () => new Promise((done) => server.close(done)) };
}

const only = process.argv[2];
if (only !== undefined && !(only in CASES)) throw new Error("Unknown case: " + only);
mkdirSync(out, { recursive: true });
const detected = await runProcess(executable, ["--version"], { cwd: repo, env: withoutCredentials() });
if (detected.code !== 0) throw new Error(detected.stderr);
const version = detected.stdout.trim();
const expected = process.env.HKN_PI_EXPECTED_VERSION ?? piHarness.referenceVersion;
if (version !== expected) throw new Error(`Expected build ${expected}, found ${version}`);
writeFileSync(
  join(out, "metadata.json"),
  JSON.stringify(
    { version, platform: process.platform, date: new Date().toISOString(), account: userInfo().username, home: homedir() },
    null,
    2,
  ) + "\n",
);

const lines = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];

for (const [label, build] of Object.entries(CASES)) {
  if (only && label !== only) continue;
  const root = mkdtempSync(join(tmpdir(), "hkn-pi-mcp-"));
  const http = await startHttpEndpoint();
  try {
    const project = join(root, "project");
    const capture = join(root, "captured");
    const record = join(root, "spawns.jsonl");
    for (const path of [project, capture, join(root, "agent"), join(project, ".git"), join(project, ".pi")])
      mkdirSync(path, { recursive: true });
    mkdirSync(join(project, "server-cwd"), { recursive: true });
    writeFileSync(join(project, ".pi/settings.json"), "{}");
    cpSync(join(repo, ".capture/pi/hooknostic-capture.ts"), join(project, "capture.ts"));
    writeFileSync(join(project, "tool-source.js"), toolSourceRecorder(join(capture, "tool-source.jsonl")));
    const config = build({ project, record, httpUrl: http.url });
    for (const [path, contents] of Object.entries(config.files ?? {})) {
      mkdirSync(join(project, path, ".."), { recursive: true });
      writeFileSync(join(project, path), contents);
    }
    const env = {
      ...withoutCredentials(),
      ...PARENT,
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: join(root, "agent"),
      HKN_CAPTURE_DIR: capture,
      HKN_PI_PROBE: "tee",
    };
    let install;
    if (config.install) {
      install = await runProcess(executable, ["install", "-l", "--approve", join(project, config.install)], {
        cwd: project,
        env,
        timeoutMs: 60000,
      });
      if (install.code !== 0) throw new Error(`${label}: pi install exited ${install.code}: ${install.stderr}`);
    }
    const model = await startModelPlayback("openai-chat", "rewrite", config.turns);
    let result;
    try {
      const provider = await writePiProviderExtension(project, model.baseUrl);
      result = await runProcess(
        executable,
        [
          "--provider",
          "hooknostic-playback",
          "--model",
          "hooknostic-playback",
          "-e",
          provider,
          "-e",
          join(project, "capture.ts"),
          "-e",
          join(project, "tool-source.js"),
          ...(config.extensions ?? []).flatMap((file) => ["-e", join(project, file)]),
          "--no-skills",
          ...(config.approve === false ? [] : ["--approve"]),
          "--no-session",
          "-p",
          "Call the probe tool once if it is available, then reply.",
        ],
        { cwd: project, env, timeoutMs: 60000 },
      );
    } finally {
      await model.close();
    }
    const target = join(out, label);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(capture, join(target, "events"), { recursive: true });
    const declared = model.requests.map((request) =>
      (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter(Boolean),
    );
    const observation = {
      label,
      version,
      date: new Date().toISOString(),
      exitCode: result.code,
      stdout: result.stdout.trim().slice(-400),
      stderr: result.stderr.trim().slice(-2000),
      ...(install ? { install: { code: install.code, stdout: install.stdout.trim().slice(-400) } } : {}),
      modelRequests: model.requests.length,
      declaredTools: declared,
      // Per model request, whether its serialized body holds each marker.
      markers: model.requests.map((request) => {
        const body = JSON.stringify(request);
        return Object.fromEntries(Object.entries(MARKERS).map(([name, text]) => [name, body.includes(text)]));
      }),
      spawns: lines(record),
      httpRequests: http.received.map(({ method, url, headers }) => ({
        method,
        url,
        authorization: headers.authorization ?? null,
        bang: headers["x-hkn-bang"] ?? null,
        braced: headers["x-hkn-braced"] ?? null,
      })),
      events: Object.fromEntries(
        readdirSync(capture).map((file) => [file.replace(/\.jsonl$/, ""), lines(join(capture, file)).length]),
      ),
      sseOutcome: existsSync(join(project, "sse-outcome.txt")) ? readFileSync(join(project, "sse-outcome.txt"), "utf8") : null,
      projectSettings: existsSync(join(project, ".pi/settings.json"))
        ? JSON.parse(readFileSync(join(project, ".pi/settings.json"), "utf8"))
        : null,
      root,
    };
    writeFileSync(join(target, "observation.json"), JSON.stringify(observation, null, 2) + "\n");
    console.log(
      JSON.stringify({
        label,
        exitCode: result.code,
        spawns: observation.spawns.length,
        http: observation.httpRequests.length,
        declared: declared[0],
      }),
    );
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
}
