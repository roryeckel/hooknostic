// Opt-in real inference on the already-installed LOCAL Ollama model only.
// No ambient provider settings, credentials, cloud model, or scripted response.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { register } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { describeTools, runProcess } = await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials } = await import("../../scripts/drive-capture-session.mjs");
const { piAdapter, piHarness } = await import("../../packages/adapter-pi/src/index.ts");
const { runProject } = await import("../../packages/core/src/project.ts");

assert.ok(process.argv.includes("--run"), "Local inference is opt-in: pass --run");
const MODEL = "qwen3.8:27b-128k";
const OLLAMA = "http://127.0.0.1:11434";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const output = join(
  repo,
  ".capture/pi-default-agent/captured/local-smoke",
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(output, { recursive: true });
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
};
const metadata = { account: userInfo().username, home: homedir() };
write(join(output, "metadata.json"), metadata);
const readJson = async (path, body) => {
  const response = await fetch(OLLAMA + path, {
    ...(body ? { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response.json();
};
const runtime = await readJson("/api/version");
const inventory = await readJson("/api/tags");
const installed = inventory.models.find((model) => model.name === MODEL);
assert.ok(installed && installed.size > 1_000_000_000, "Requested local weights must already be installed");
assert.ok(!installed.remote_host && !installed.remote_model, "Cloud-backed Ollama entries are forbidden");
const modelInfo = await readJson("/api/show", { model: MODEL });
assert.ok(modelInfo.capabilities.includes("tools"));
const detected = await runProcess("pi", ["--version"], { cwd: repo, env: withoutCredentials() });
assert.equal(detected.code, 0);
const version = detected.stdout.trim();
assert.equal(version, piHarness.referenceVersion);
const roleMarker = "ROLE_" + randomBytes(8).toString("hex");
const fileToken = "FILE_" + randomBytes(8).toString("hex");
const instructions = `You are the local smoke verifier. When asked to read probe.txt and report its contents,
call the read tool exactly once on probe.txt. Then return only a JSON object with exactly two keys:
"role" must be "${roleMarker}" and "token" must be the exact file content with surrounding whitespace removed.
Do not use Markdown fences, commentary, other tools, or other files.\n`;
const prompt =
  "Use the read tool exactly once to read probe.txt, then report its actual contents. Do not guess the file contents.";
const observations = [];

async function runCase(label, enabled) {
  const root = mkdtempSync(join(tmpdir(), "hkn-pi-local-smoke-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  const log = join(root, "events.jsonl");
  const trace = [];
  const errors = [];
  let server;
  try {
    for (const path of [project, agent, join(project, ".git")]) mkdirSync(path, { recursive: true });
    write(join(project, "probe.txt"), fileToken + "\n");
    write(
      join(project, "agents/verifier.md"),
      `---\nname: verifier\ndescription: Local role smoke.\nmode: primary\n---\n${instructions}`,
    );
    const configPath = join(project, "hooknostic.config.ts");
    write(
      configPath,
      `export default ${JSON.stringify({
        project: { root: "." },
        components: { agents: ["./agents"], defaultAgent: "verifier" },
        targets: {
          pi: {
            version: piHarness.recommendedRange,
            delivery: "project",
            output: ".hooknostic/artifacts/pi",
            agents: { include: enabled ? ["verifier"] : [] },
          },
        },
      })};`,
    );
    const buildOptions = { configPath, registry: { pi: piAdapter() } };
    const synced = await runProject({ ...buildOptions, command: "sync" });
    assert.equal(synced.ok, true, synced.errors.join("\n"));
    const verified = await runProject({ ...buildOptions, command: "verify" });
    assert.equal(verified.ok, true, verified.errors.join("\n"));
    const appendPath = join(project, ".pi/APPEND_SYSTEM.md");
    assert.equal(existsSync(appendPath), enabled);
    if (enabled) assert.equal(readFileSync(appendPath, "utf8"), instructions);

    // Passive HTTP tee. Only this fixed loopback model endpoint is reachable
    // through the proxy; the incoming model id must match the local inventory.
    server = createServer(async (incoming, outgoing) => {
      try {
        assert.equal(incoming.method, "POST");
        assert.equal(incoming.url, "/v1/chat/completions");
        assert.ok(trace.length < 4, "Per-session model request budget exceeded");
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        assert.ok(body.length < 1_000_000);
        const request = JSON.parse(body.toString("utf8"));
        assert.equal(request.model, MODEL);
        const item = { request, status: null, response: "" };
        trace.push(item);
        console.log(`${label}: forwarding local model request ${trace.length}`);
        const upstream = httpRequest(
          OLLAMA + incoming.url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": body.length },
          },
          (response) => {
            item.status = response.statusCode;
            outgoing.writeHead(response.statusCode, {
              "Content-Type": response.headers["content-type"] ?? "text/event-stream",
            });
            response.on("data", (chunk) => {
              item.response += chunk.toString("utf8");
              outgoing.write(chunk);
            });
            response.on("end", () => {
              outgoing.end();
              write(join(output, label, "http.json"), trace);
              console.log(`${label}: local request completed (HTTP ${item.status})`);
            });
            response.on("error", (error) => {
              errors.push(String(error));
              outgoing.destroy(error);
            });
          },
        );
        upstream.setTimeout(180_000, () => upstream.destroy(new Error("Local inference timed out")));
        upstream.on("error", (error) => {
          errors.push(String(error));
          outgoing.destroy(error);
        });
        incoming.on("aborted", () => upstream.destroy());
        upstream.end(body);
      } catch (error) {
        errors.push(String(error));
        outgoing.writeHead(503);
        outgoing.end(String(error));
      }
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    write(join(agent, "models.json"), {
      providers: {
        "local-smoke": {
          baseUrl: endpoint,
          api: "openai-completions",
          apiKey: "local-only-placeholder",
          models: [
            {
              id: MODEL,
              name: MODEL,
              reasoning: true,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 2048,
              thinkingLevelMap: { off: "none", low: "low" },
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    });
    write(join(agent, "settings.json"), {
      defaultProvider: "local-smoke",
      defaultModel: MODEL,
      defaultThinkingLevel: "off",
    });
    const observer = join(root, "observe.js");
    write(
      observer,
      `import { appendFileSync } from "node:fs";
export default function (pi) {
  for (const name of ["session_start", "before_agent_start", "tool_call", "tool_result", "agent_settled"]) {
    pi.on(name, event => { appendFileSync(process.env.HKN_PI_SMOKE_TRACE, JSON.stringify(event) + "\\n"); });
  }
}\n`,
    );
    const env = {
      ...withoutCredentials(),
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, "appdata"),
      LOCALAPPDATA: join(root, "localdata"),
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      HKN_PI_SMOKE_TRACE: log,
    };
    for (const name of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|CREDENTIAL/.test(name)) delete env[name];
    const args = [
      "--offline",
      "--no-extensions",
      "-e",
      observer,
      "--no-session",
      "--approve",
      "--tools",
      "read",
      "--thinking",
      "off",
      "-p",
      prompt,
    ];
    console.log(`${label}: starting Pi ${version} on ${MODEL}`);
    const started = Date.now();
    const result = await runProcess("pi", args, { cwd: project, env, timeoutMs: 240_000 });
    const events = existsSync(log)
      ? readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
      : [];
    write(join(output, label, "raw.json"), { args, result, events, requests: trace, synced, verified });
    const calls = events.filter((event) => event.type === "tool_call");
    const results = events.filter((event) => event.type === "tool_result");
    const highPriority = trace.map(({ request }) =>
      request.messages.filter((message) => ["system", "developer"].includes(message.role)),
    );
    let report;
    try {
      report = JSON.parse(result.stdout.trim());
    } catch {
      report = null;
    }
    const observation = {
      label,
      enabled,
      exit: result.code,
      durationMs: Date.now() - started,
      output: result.stdout.trim(),
      stderr: result.stderr.trim(),
      requestCount: trace.length,
      httpStatuses: trace.map((item) => item.status),
      errors,
      models: trace.map(({ request }) => request.model),
      tools: trace.map(({ request }) => describeTools(request).map((tool) => tool.name)),
      promptRoles: highPriority.map((messages) => messages.map((message) => message.role)),
      roleInEveryHighPriorityMessage:
        highPriority.length > 0 &&
        highPriority.every(
          (messages) => messages.length === 1 && JSON.stringify(messages[0].content).includes(roleMarker),
        ),
      roleInAnyUserMessage: trace.some(({ request }) =>
        request.messages.some(
          (message) => message.role === "user" && JSON.stringify(message.content).includes(roleMarker),
        ),
      ),
      fileResultReachedModel: trace.some(({ request }) =>
        request.messages.some(
          (message) => message.role === "tool" && JSON.stringify(message.content).includes(fileToken),
        ),
      ),
      toolCalls: calls,
      toolResults: results,
      readSucceeded:
        calls.length === 1 &&
        calls[0].toolName === "read" &&
        resolve(project, calls[0].input.path) === join(project, "probe.txt") &&
        results.length === 1 &&
        results[0].toolName === "read" &&
        results[0].isError === false &&
        JSON.stringify(results[0].content).includes(fileToken),
      positiveRoleCondition:
        report?.role === roleMarker && report?.token === fileToken && Object.keys(report).length === 2,
      rawOutputHasRole: result.stdout.includes(roleMarker),
      syncVerified: synced.ok && verified.ok,
    };
    observations.push(observation);
    console.log(
      `${label}: ${JSON.stringify({ exit: observation.exit, readSucceeded: observation.readSucceeded, positiveRoleCondition: observation.positiveRoleCondition, output: observation.output })}`,
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("hkn-pi-local-smoke-"))
      throw new Error("Unexpected smoke root");
    rmSync(root, { recursive: true, force: true });
  }
}

await runCase("default-excluded", false);
await runCase("default-enabled", true);
const checks = {
  cleanExits: observations.every((item) => item.exit === 0 && item.stderr === "" && item.errors.length === 0),
  realLocalRequests: observations.every(
    (item) =>
      item.requestCount === 2 &&
      item.models.every((model) => model === MODEL) &&
      item.httpStatuses.every((status) => status === 200),
  ),
  onlyReadAdvertised: observations.every((item) => item.tools.every((tools) => JSON.stringify(tools) === '["read"]')),
  nativeFileReadInBothSessions: observations.every((item) => item.readSucceeded && item.fileResultReachedModel),
  defaultRoleOnlyInEnabledPrompt:
    !observations[0].roleInEveryHighPriorityMessage &&
    observations[1].roleInEveryHighPriorityMessage &&
    observations.every((item) => !item.roleInAnyUserMessage),
  roleControlsActualAnswer:
    !observations[0].rawOutputHasRole &&
    !observations[0].positiveRoleCondition &&
    observations[1].positiveRoleCondition,
};
const summary = {
  version,
  platform: process.platform,
  node: process.version,
  date: new Date().toISOString(),
  transport: "local Ollama OpenAI-compatible HTTP (passive recording proxy)",
  ollamaVersion: runtime.version,
  model: MODEL,
  modelDigest: installed.digest,
  size: installed.size,
  modelDetails: modelInfo.details,
  modelParameters: modelInfo.parameters,
  modelCapabilities: modelInfo.capabilities,
  thinking: "off",
  maxTokens: 2048,
  contextWindow: 128000,
  roleMarker,
  fileToken,
  instructions,
  userPrompt: prompt,
  checks,
  observations,
};
write(join(output, "summary.json"), summary);
for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name);
console.log(`PASSED local Pi role/file-read smoke; ${output}`);
